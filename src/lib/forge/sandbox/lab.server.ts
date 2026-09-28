/**
 * Authenticated lab lifecycle + execution recording (server only).
 *
 * Every function here runs behind Supabase auth, resolves the caller's OWN lab
 * rows through RLS-scoped queries, and only then dispatches to a provider that
 * this build is allowed to use. There is no generic "run this shell string"
 * endpoint: execution always goes through `executeInLab`, which is bound to the
 * caller's environment and records a redacted event.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { createSupabaseAdminClient } from "@/integrations/supabase/server-admin";
import type { Mutation } from "../executor.server";
import {
  DEFAULT_RESOURCE_POLICY,
  MOCK_PROVIDER_ID,
  isEnvironmentStatus,
  providerFail,
  providerOk,
  type EnvironmentDescriptor,
  type EnvironmentHandle,
  type ExecutionRecord,
  type ProviderResult,
  type SandboxFsObject,
  type SandboxFsView,
  type SandboxStatusView,
  type ShellName,
  type ProviderId,
} from "./contract";
import type { MockBackingStore, SandboxInstanceRecord } from "./mock-provider.server";
import { redactText } from "@/lib/security-redaction";
import { selectProvider } from "./registry.server";
import {
  persistLifecycleTransition,
  reconcileLabInstance,
  withLabControlLease,
} from "./orchestrator.server";
import { runTrackedLabOperation } from "./lab-control-plane.server";
import {
  ensureRuntimeIdentity,
  verifyAndPersistRuntimeIsolation,
  authorizeVerifiedRuntimeAccess,
} from "./runtime-identity.server";
import type { IsolationVerification, RuntimeBinding } from "./lab-isolation";
import { invalidateTerminalSessionsForInstance } from "./terminal-control.server";
import {
  ensureEnvironmentPersistence,
  getEnvironmentPersistence,
  markEnvironmentActive,
  markEnvironmentStopping,
  markEnvironmentStopped,
  markEnvironmentReset,
  markEnvironmentDestroyed,
  markEnvironmentQuarantined,
} from "./environment-persistence.server";

export type Db = SupabaseClient<Database>;

export const LAB_KEY = "forge-core";

type LabRow = Database["public"]["Tables"]["learner_labs"]["Row"];

/** The learner's story lab row, created on first use. */
export async function ensureLab(db: Db, userId: string): Promise<LabRow> {
  const existing = await db
    .from("learner_labs")
    .select("*")
    .eq("user_id", userId)
    .eq("lab_key", LAB_KEY)
    .maybeSingle();

  if (existing.error) {
    throw new Error(existing.error.message);
  }

  if (existing.data) {
    return existing.data;
  }

  const created = await db
    .from("learner_labs")
    .insert({
      user_id: userId,
      lab_key: LAB_KEY,
      title: "Forge training lab",
    })
    .select("*")
    .single();

  if (!created.error) {
    return created.data;
  }

  if (created.error.code !== "23505") {
    throw new Error(created.error.message);
  }

  const raced = await db
    .from("learner_labs")
    .select("*")
    .eq("user_id", userId)
    .eq("lab_key", LAB_KEY)
    .single();

  if (raced.error) {
    throw new Error(raced.error.message);
  }

  return raced.data;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [k, v] of Object.entries(asRecord(value))) {
    if (typeof v === "string") {
      out[k] = v;
    }
  }

  return out;
}

type InstanceRow = Database["public"]["Tables"]["lab_instances"]["Row"];

const toInstanceRecord = (row: InstanceRow): SandboxInstanceRecord => ({
  environmentId: row.environment_id,
  userId: row.user_id,
  labId: row.lab_id,
  status: isEnvironmentStatus(row.status) ? row.status : "ERROR",
  snapshotId: row.snapshot_id ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastActiveAt: row.last_active_at,
  expiresAt: row.expires_at ?? null,
  metadata: stringMap(row.metadata),
});

/**
 * Supabase-backed store for the modelled provider. All reads and writes are
 * filtered by the caller's user id in addition to RLS, so a provider adapter can
 * never observe or mutate another learner's environment.
 */
export function createSupabaseMockStore(db: Db, userId: string): MockBackingStore {
  const own = (handle: EnvironmentHandle) => handle.userId === userId;

  return {
    async readInstance(handle) {
      if (!own(handle)) {
        return null;
      }

      const res = await db
        .from("lab_instances")
        .select("*")
        .eq("user_id", userId)
        .eq("environment_id", handle.environmentId)
        .maybeSingle();

      if (res.error) {
        throw new Error(res.error.message);
      }

      return res.data ? toInstanceRecord(res.data) : null;
    },

    async createInstance(input) {
      const environmentId = `mock-env-${crypto.randomUUID()}`;
      const now = new Date();

      const res = await db
        .from("lab_instances")
        .insert({
          user_id: userId,
          lab_id: input.labId,
          provider: MOCK_PROVIDER_ID,
          environment_id: environmentId,
          status: "READY",
          metadata: input.metadata,
          resource_policy: {
            ...DEFAULT_RESOURCE_POLICY,
            egressAllowlist: [...DEFAULT_RESOURCE_POLICY.egressAllowlist],
          },
          last_active_at: now.toISOString(),
          expires_at: new Date(now.getTime() + DEFAULT_RESOURCE_POLICY.idleExpiryMs).toISOString(),
        })
        .select("*")
        .single();

      if (res.error) {
        throw new Error(res.error.message);
      }

      return toInstanceRecord(res.data);
    },

    async patchInstance(handle, patch) {
      if (!own(handle)) {
        throw new Error("Not your lab environment");
      }

      const res = await db
        .from("lab_instances")
        .update({
          ...(patch.status ? { status: patch.status } : {}),
          ...(patch.snapshotId !== undefined
            ? {
                snapshot_id: patch.snapshotId,
              }
            : {}),
          ...(patch.lastActiveAt
            ? {
                last_active_at: patch.lastActiveAt,
              }
            : {}),
          ...(patch.expiresAt !== undefined
            ? {
                expires_at: patch.expiresAt,
              }
            : {}),
          ...(patch.metadata
            ? {
                metadata: patch.metadata,
              }
            : {}),
        })
        .eq("user_id", userId)
        .eq("environment_id", handle.environmentId)
        .select("*")
        .single();

      if (res.error) {
        throw new Error(res.error.message);
      }

      return toInstanceRecord(res.data);
    },

    async readFilesystem(handle) {
      const view: SandboxFsView = new Map();

      if (!own(handle)) {
        return view;
      }

      const res = await db
        .from("lab_world_objects")
        .select("*")
        .eq("user_id", userId)
        .eq("lab_id", handle.labId)
        .eq("active", true);

      if (res.error) {
        throw new Error(res.error.message);
      }

      for (const r of res.data ?? []) {
        const state = asRecord(r.current_state);

        const objectType =
          r.object_type === "directory" ? ("directory" as const) : ("file" as const);

        const obj: SandboxFsObject = {
          objectId: r.object_id,
          objectType,
          path: r.path,
          name: r.name,
          permissions: asString(state["permissions"], objectType === "directory" ? "755" : "644"),
          content: asString(state["content"], ""),
          active: true,
          createdByChallenge: r.created_by_challenge ?? null,
          lastModifiedByChallenge: r.last_modified_by_challenge ?? null,
          createdAt: r.created_at,
        };

        view.set(obj.path, obj);
      }

      return view;
    },

    async applyMutations(handle, challengeRef, mutations: Mutation[]) {
      if (!own(handle)) {
        throw new Error("Not your lab environment");
      }

      for (const m of mutations) {
        if (m.kind === "create") {
          const res = await db
            .from("lab_world_objects")
            .insert({
              user_id: userId,
              lab_id: handle.labId,
              object_type: m.objectType,
              path: m.path,
              name: m.path.split("/").pop() ?? m.path,
              created_by_challenge: challengeRef,
              last_modified_by_challenge: challengeRef,
              current_state: {
                permissions: m.permissions,
                content: m.content,
              },
            })
            .select("object_id")
            .maybeSingle();

          if (res.error && !`${res.error.message}`.includes("duplicate")) {
            throw new Error(res.error.message);
          }
        } else {
          const current = await db
            .from("lab_world_objects")
            .select("current_state")
            .eq("user_id", userId)
            .eq("lab_id", handle.labId)
            .eq("path", m.path)
            .maybeSingle();

          if (current.error) {
            throw new Error(current.error.message);
          }

          const state = asRecord(current.data?.current_state);

          const res = await db
            .from("lab_world_objects")
            .update({
              current_state: {
                permissions: m.permissions ?? asString(state["permissions"], "644"),
                content: m.content ?? asString(state["content"], ""),
              },
              last_modified_by_challenge: challengeRef,
            })
            .eq("user_id", userId)
            .eq("lab_id", handle.labId)
            .eq("path", m.path);

          if (res.error) {
            throw new Error(res.error.message);
          }
        }
      }
    },

    async clearFilesystem(handle) {
      if (!own(handle)) {
        throw new Error("Not your lab environment");
      }

      const res = await db
        .from("lab_world_objects")
        .update({ active: false })
        .eq("user_id", userId)
        .eq("lab_id", handle.labId);

      if (res.error) {
        throw new Error(res.error.message);
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Lifecycle API (authorised before every provider dispatch)           */
/* ------------------------------------------------------------------ */

export type LabSession = {
  provider: ReturnType<typeof selectProvider>["provider"];
  providerId: ReturnType<typeof selectProvider>["providerId"];
  realLinux: {
    available: boolean;
    reason: string;
  };
  handle: EnvironmentHandle;
  instanceId: string;
  descriptor: EnvironmentDescriptor;
  /** V45 runtime security binding; populated for real isolated providers. */
  isolationBinding?: RuntimeBinding;
  isolationVerification?: IsolationVerification;
};

async function persistProviderDescriptor(
  db: Db,
  userId: string,
  labId: string,
  descriptor: EnvironmentDescriptor,
) {
  const result = await db
    .from("lab_instances")
    .update({
      status: descriptor.status,
      snapshot_id: descriptor.snapshotId,
      last_active_at: descriptor.lastActiveAt,
      expires_at: descriptor.expiresAt,
      metadata: descriptor.metadata,
      resource_policy: {
        ...descriptor.resourcePolicy,
        egressAllowlist: [...descriptor.resourcePolicy.egressAllowlist],
      },
      ...(descriptor.metadata["runtime_node_id"]
        ? {
            runtime_node_id: descriptor.metadata["runtime_node_id"],
          }
        : {}),
    })
    .eq("user_id", userId)
    .eq("lab_id", labId)
    .eq("provider", descriptor.handle.provider)
    .eq("environment_id", descriptor.handle.environmentId);

  if (result.error) {
    throw new Error(result.error.message);
  }
}

async function createRealProviderInstance(
  db: Db,
  userId: string,
  labId: string,
  descriptor: EnvironmentDescriptor,
) {
  const result = await db.from("lab_instances").insert({
    user_id: userId,
    lab_id: labId,
    provider: descriptor.handle.provider,
    environment_id: descriptor.handle.environmentId,
    status: descriptor.status,
    snapshot_id: descriptor.snapshotId,
    metadata: descriptor.metadata,
    resource_policy: {
      ...descriptor.resourcePolicy,
      egressAllowlist: [...descriptor.resourcePolicy.egressAllowlist],
    },
    last_active_at: descriptor.lastActiveAt,
    expires_at: descriptor.expiresAt,
  });

  if (result.error) {
    throw new Error(result.error.message);
  }
}

/**
 * Recover a real environment when the control-plane database still has the
 * logical environment but the runtime provider reports that the physical
 * environment no longer exists.
 */
async function recoverMissingRealEnvironment(
  db: Db,
  userId: string,
  lab: LabRow,
  row: InstanceRow,
  provider: ReturnType<typeof selectProvider>["provider"],
  providerId: ProviderId,
): Promise<ProviderResult<EnvironmentDescriptor>> {
  const handle: EnvironmentHandle = {
    /*
     * IMPORTANT:
     * `row.provider` is a database string. It is not sufficiently narrowed
     * for EnvironmentHandle. `providerId` comes from the provider registry and
     * is therefore the canonical ProviderId for this request.
     */
    provider: providerId,
    environmentId: row.environment_id,
    userId,
    labId: lab.id,
  };

  return withLabControlLease(db, userId, row.id, async () => {
    const latest = await getEnvironmentPersistence(db, userId, row.environment_id);

    if (!latest) {
      return providerFail(
        "INTERNAL",
        "Persistent environment state is missing; runtime recovery is unsafe.",
        true,
      );
    }

    /*
     * Re-check the physical runtime while holding
     * the control lease.
     */
    const observed = await provider.getEnvironmentState(handle);

    if (observed.ok) {
      return providerOk(observed.value);
    }

    if (observed.error.code !== "ENVIRONMENT_NOT_FOUND") {
      return providerFail(observed.error.code, observed.error.message, observed.error.retryable);
    }

    if (latest.state !== "ACTIVE" && latest.state !== "QUARANTINED" && latest.state !== "STOPPED") {
      return providerFail(
        "INTERNAL",
        `Physical runtime is missing while persistent environment is ${latest.state}; automatic artifact replacement is not permitted from this state.`,
        true,
      );
    }

    if (latest.state === "ACTIVE" || latest.state === "QUARANTINED") {
      await markEnvironmentStopping({
        db,
        userId,
        environmentId: row.environment_id,
        reason: "Physical runtime artifact is missing; controlled artifact replacement initiated.",
      });

      await markEnvironmentStopped({
        db,
        userId,
        environmentId: row.environment_id,
        fingerprint: null,
      });
    }

    await invalidateTerminalSessionsForInstance(db, userId, row.id, "CLOSED");

    const previousGeneration = latest.environmentGeneration;
    const previousArtifactVersion = latest.artifactVersion;

    const recreated = await provider.createEnvironment({
      environmentId: row.environment_id,
      userId,
      labId: lab.id,
      resourcePolicy: DEFAULT_RESOURCE_POLICY,
      metadata: {
        ...toInstanceRecord(row).metadata,
        lab_key: LAB_KEY,
        lab_title: lab.title,
        artifact_replacement: "true",
        previous_environment_generation: String(previousGeneration),
        previous_artifact_version: String(previousArtifactVersion),
      },
    });

    if (!recreated.ok) {
      return recreated;
    }

    await persistProviderDescriptor(db, userId, lab.id, recreated.value);

    const confirmed = await provider.getEnvironmentState(handle);

    if (!confirmed.ok) {
      await markEnvironmentQuarantined({
        db,
        userId,
        environmentId: row.environment_id,
        reason: "Replacement runtime was created but could not be observed after creation.",
      });

      return providerFail(confirmed.error.code, confirmed.error.message, confirmed.error.retryable);
    }

    if (confirmed.value.status !== "RUNNING" && confirmed.value.status !== "READY") {
      await markEnvironmentQuarantined({
        db,
        userId,
        environmentId: row.environment_id,
        reason: `Replacement runtime entered unexpected state ${confirmed.value.status}.`,
      });

      return providerFail(
        "INTERNAL",
        `Replacement runtime entered unexpected state ${confirmed.value.status}.`,
        true,
      );
    }

    await markEnvironmentReset({
      db,
      userId,
      environmentId: row.environment_id,
    });

    return providerOk(recreated.value);
  });
}

/** Create-or-restore the caller's lab environment; the only entry point. */
export async function ensureLabSession(
  db: Db,
  userId: string,
  options: {
    startIfNeeded?: boolean;
  } = {},
): Promise<ProviderResult<LabSession>> {
  const startIfNeeded = options.startIfNeeded ?? true;

  const lab = await ensureLab(db, userId);

  const store = createSupabaseMockStore(db, userId);

  const selection = selectProvider(store);

  const existing = await db
    .from("lab_instances")
    .select("*")
    .eq("user_id", userId)
    .eq("lab_id", lab.id)
    .eq("provider", selection.providerId)
    .order("last_active_at", {
      ascending: false,
    })
    .limit(1)
    .maybeSingle();

  if (existing.error) {
    throw new Error(existing.error.message);
  }

  let row = existing.data;

  if (!row && !startIfNeeded) {
    return providerFail(
      "ENVIRONMENT_NOT_FOUND",
      "Lab environment has not been allocated yet.",
      false,
    );
  }

  if (!row) {
    const created = await selection.provider.createEnvironment({
      userId,
      labId: lab.id,
      resourcePolicy: DEFAULT_RESOURCE_POLICY,
      metadata: {
        lab_key: LAB_KEY,
        lab_title: lab.title,
      },
    });

    if (!created.ok) {
      return created;
    }

    /*
     * The mock provider uses the injected persistence store because its
     * filesystem itself is stored in Supabase. A real provider owns runtime
     * state outside Supabase, so the control plane persists the returned
     * descriptor explicitly.
     */
    if (selection.providerId !== MOCK_PROVIDER_ID) {
      try {
        await createRealProviderInstance(db, userId, lab.id, created.value);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (!message.includes("duplicate") && !message.includes("unique")) {
          throw error;
        }

        /*
         * Another concurrent allocator won the unique
         * lab/provider binding. Dispose the losing runtime.
         */
        await selection.provider.destroyEnvironment(created.value.handle);
      }
    }

    const reread = await db
      .from("lab_instances")
      .select("*")
      .eq("user_id", userId)
      .eq("lab_id", lab.id)
      .eq("provider", selection.providerId)
      .eq("environment_id", created.value.handle.environmentId)
      .single();

    if (reread.error) {
      throw new Error(reread.error.message);
    }

    row = reread.data;
  }

  /*
   * TypeScript cannot prove that the mutable `row`
   * variable was populated by one of the allocation
   * branches above.
   *
   * At this point every successful path must have a
   * canonical persisted lab_instances row.
   */
  if (!row) {
    return providerFail(
      "ENVIRONMENT_NOT_FOUND",
      "Lab environment could not be resolved to a canonical persisted instance.",
      true,
    );
  }

  /*
   * Keep the canonical DB instance id in a stable string.
   *
   * `row` is intentionally mutable because controlled
   * recreation can replace the physical/logical DB row
   * represented by this local variable. TypeScript must
   * therefore not be asked to narrow `row` across awaits.
   */
  let canonicalInstanceId = row.id;

  await ensureEnvironmentPersistence({
    db,
    userId,
    labId: row.lab_id,
    instanceId: canonicalInstanceId,
    environmentId: row.environment_id,
    artifactRef: row.environment_id,
  });

  let persistence = await getEnvironmentPersistence(db, userId, row.environment_id);

  if (persistence?.state === "DESTROYED") {
    const created = await selection.provider.createEnvironment({
      userId,
      labId: lab.id,
      resourcePolicy: DEFAULT_RESOURCE_POLICY,
      metadata: {
        lab_key: LAB_KEY,
        lab_title: lab.title,
        recreated_after_destroy: "true",
      },
    });

    if (!created.ok) {
      return created;
    }

    try {
      if (selection.providerId !== MOCK_PROVIDER_ID) {
        await createRealProviderInstance(db, userId, lab.id, created.value);
      } else {
        const mockRow = await db
          .from("lab_instances")
          .insert({
            user_id: userId,
            lab_id: lab.id,
            provider: selection.providerId,
            environment_id: created.value.handle.environmentId,
            status: created.value.status,
            snapshot_id: created.value.snapshotId,
            metadata: created.value.metadata,
            resource_policy: {
              ...created.value.resourcePolicy,
              egressAllowlist: [...created.value.resourcePolicy.egressAllowlist],
            },
            last_active_at: created.value.lastActiveAt,
            expires_at: created.value.expiresAt,
          })
          .select("*")
          .single();

        if (mockRow.error) {
          throw new Error(mockRow.error.message);
        }
      }

      const newRow = await db
        .from("lab_instances")
        .select("*")
        .eq("environment_id", created.value.handle.environmentId)
        .eq("user_id", userId)
        .single();

      if (newRow.error) {
        throw new Error(newRow.error.message);
      }

      row = newRow.data;
      canonicalInstanceId = row.id;

      await ensureEnvironmentPersistence({
        db,
        userId,
        labId: row.lab_id,
        instanceId: canonicalInstanceId,
        environmentId: row.environment_id,
        artifactRef: row.environment_id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (!message.includes("duplicate") && !message.includes("unique")) {
        throw error;
      }

      await selection.provider.destroyEnvironment(created.value.handle);

      const winner = await db
        .from("lab_instances")
        .select("*")
        .eq("user_id", userId)
        .eq("lab_id", lab.id)
        .eq("provider", selection.providerId)
        .not("status", "in", "(STOPPED,EXPIRED)")
        .order("last_active_at", {
          ascending: false,
        })
        .limit(1)
        .maybeSingle();

      if (winner.error) {
        throw new Error(winner.error.message);
      }

      if (!winner.data) {
        throw new Error(
          "Concurrent environment recreation lost the allocation race and no canonical environment was found.",
        );
      }

      row = winner.data;
      canonicalInstanceId = row.id;

      await ensureEnvironmentPersistence({
        db,
        userId,
        labId: row.lab_id,
        instanceId: canonicalInstanceId,
        environmentId: row.environment_id,
        artifactRef: row.environment_id,
      });
    }

    persistence = await getEnvironmentPersistence(db, userId, row.environment_id);
  }

  let record = toInstanceRecord(row);

  let currentPersistence = await getEnvironmentPersistence(db, userId, record.environmentId);

  /*
   * Refresh the canonical DB instance after any
   * controlled runtime recovery.
   */
  const refreshCurrentInstance = async (): Promise<void> => {
    const refreshed = await db
      .from("lab_instances")
      .select("*")
      .eq("id", canonicalInstanceId)
      .eq("user_id", userId)
      .single();

    if (refreshed.error) {
      throw new Error(refreshed.error.message);
    }

    row = refreshed.data;
    canonicalInstanceId = row.id;

    record = toInstanceRecord(row);

    currentPersistence = await getEnvironmentPersistence(db, userId, record.environmentId);
  };

  /*
   * Quarantined recovery.
   */
  if (currentPersistence?.state === "QUARANTINED" && selection.providerId !== MOCK_PROVIDER_ID) {
    const recoveryHandle: EnvironmentHandle = {
      provider: selection.providerId,
      environmentId: record.environmentId,
      userId,
      labId: lab.id,
    };

    const observed = await selection.provider.getEnvironmentState(recoveryHandle);

    if (!observed.ok && observed.error.code === "ENVIRONMENT_NOT_FOUND") {
      const recovered = await recoverMissingRealEnvironment(
        db,
        userId,
        lab,
        row,
        selection.provider,
        selection.providerId,
      );

      if (!recovered.ok) {
        return recovered;
      }

      await refreshCurrentInstance();
    } else if (!observed.ok) {
      return providerFail(observed.error.code, observed.error.message, observed.error.retryable);
    } else {
      const observedPersistence =
        await selection.provider.getEnvironmentPersistence(recoveryHandle);

      if (
        observedPersistence.ok &&
        observedPersistence.value.integrityStatus === "VERIFIED" &&
        (observed.value.status === "RUNNING" || observed.value.status === "READY")
      ) {
        await withLabControlLease(db, userId, canonicalInstanceId, async () => {
          const latest = await getEnvironmentPersistence(db, userId, record.environmentId);

          if (!latest || latest.state !== "QUARANTINED") {
            return;
          }

          await markEnvironmentStopping({
            db,
            userId,
            environmentId: record.environmentId,
            reason:
              "Verified runtime artifact recovered from quarantine; controlled restart initiated.",
          });

          const stopped = await selection.provider.stopEnvironment(recoveryHandle);

          if (!stopped.ok) {
            throw new Error(stopped.error.message);
          }

          await persistProviderDescriptor(db, userId, lab.id, stopped.value);

          await markEnvironmentStopped({
            db,
            userId,
            environmentId: record.environmentId,
            fingerprint:
              stopped.value.persistence?.integrityFingerprint ??
              observedPersistence.value.integrityFingerprint,
          });

          const started = await selection.provider.startEnvironment(recoveryHandle);

          if (!started.ok) {
            throw new Error(started.error.message);
          }

          await persistProviderDescriptor(db, userId, lab.id, started.value);

          await markEnvironmentActive({
            db,
            userId,
            environmentId: record.environmentId,
            artifactRef: record.environmentId,
          });

          const latestRow = await db
            .from("lab_instances")
            .update({
              status: "RUNNING",
            })
            .eq("id", canonicalInstanceId)
            .eq("user_id", userId)
            .select("id")
            .maybeSingle();

          if (latestRow.error) {
            throw new Error(latestRow.error.message);
          }
        });

        await refreshCurrentInstance();
      } else {
        return providerFail(
          "INTERNAL",
          "Lab environment is quarantined and requires successful runtime integrity recovery before terminal access.",
          true,
        );
      }
    }
  }

  /*
   * ACTIVE + physical runtime missing.
   */
  if (
    currentPersistence?.state === "ACTIVE" &&
    selection.providerId !== MOCK_PROVIDER_ID &&
    (record.status === "READY" || record.status === "RUNNING")
  ) {
    const activeHandle: EnvironmentHandle = {
      provider: selection.providerId,
      environmentId: record.environmentId,
      userId,
      labId: lab.id,
    };

    const observed = await selection.provider.getEnvironmentState(activeHandle);

    if (!observed.ok && observed.error.code === "ENVIRONMENT_NOT_FOUND") {
      const recovered = await recoverMissingRealEnvironment(
        db,
        userId,
        lab,
        row,
        selection.provider,
        selection.providerId,
      );

      if (!recovered.ok) {
        return recovered;
      }

      await refreshCurrentInstance();
    } else if (!observed.ok) {
      return providerFail(observed.error.code, observed.error.message, observed.error.retryable);
    }
  }

  /*
   * STOPPED is a valid persistent state, but a stopped DB row does not prove
   * that the physical runtime artifact still exists. If the local runtime was
   * cleared/restarted and the artifact disappeared, the ordinary start path
   * would send /start to a non-existent runtime and leak "Environment not
   * found" to the browser. Reconcile that split-brain state first.
   */
  if (
    currentPersistence?.state === "STOPPED" &&
    selection.providerId !== MOCK_PROVIDER_ID
  ) {
    const stoppedHandle: EnvironmentHandle = {
      provider: selection.providerId,
      environmentId: record.environmentId,
      userId,
      labId: lab.id,
    };

    const observed = await selection.provider.getEnvironmentState(stoppedHandle);

    if (!observed.ok && observed.error.code === "ENVIRONMENT_NOT_FOUND") {
      const recovered = await recoverMissingRealEnvironment(
        db,
        userId,
        lab,
        row,
        selection.provider,
        selection.providerId,
      );

      if (!recovered.ok) {
        return recovered;
      }

      await refreshCurrentInstance();
    } else if (!observed.ok) {
      return providerFail(observed.error.code, observed.error.message, observed.error.retryable);
    }
  }

  /*
   * Never turn an abnormal persistence state into ACTIVE.
   */
  if (currentPersistence && currentPersistence.state !== "ACTIVE") {
    if (currentPersistence.state === "STOPPED") {
      if (!startIfNeeded) {
        return providerFail(
          "INTERNAL",
          "Lab environment is stopped and requires an explicit start.",
          false,
        );
      }
    } else if (
      currentPersistence.state === "PROVISIONING" ||
      currentPersistence.state === "READY"
    ) {
      /*
       * Normal provider-start path below.
       */
    } else if (
      currentPersistence.state === "FAILED" ||
      currentPersistence.state === "STOPPING" ||
      currentPersistence.state === "DESTROYING"
    ) {
      return providerFail(
        "INTERNAL",
        `Lab environment is ${currentPersistence.state.toLowerCase()} and requires reconciliation before access.`,
        true,
      );
    } else if (currentPersistence.state === "DESTROYED") {
      return providerFail("INTERNAL", "Lab environment is destroyed and cannot be reused.", false);
    }
  }

  const handle: EnvironmentHandle = {
    provider: selection.providerId,
    environmentId: record.environmentId,
    userId,
    labId: record.labId,
  };

  let isolationBinding: RuntimeBinding | undefined;

  let isolationVerification: IsolationVerification | undefined;

  if (selection.providerId !== MOCK_PROVIDER_ID) {
    const generation = Math.max(1, row.runtime_binding_generation);

    if (row.runtime_binding_generation !== generation) {
      await db
        .from("lab_instances")
        .update({
          runtime_binding_generation: generation,
        })
        .eq("id", canonicalInstanceId)
        .eq("user_id", userId);
    }

    const internalDb = createSupabaseAdminClient();

    isolationBinding = await ensureRuntimeIdentity(internalDb, {
      instanceId: canonicalInstanceId,
      labId: row.lab_id,
      learnerId: userId,
      bindingGeneration: generation,
    });

    const health = await selection.provider.getRuntimeHealth();

    if (health.ok) {
      isolationVerification = await verifyAndPersistRuntimeIsolation(internalDb, {
        binding: isolationBinding,
        instanceId: canonicalInstanceId,
        health: {
          verificationId: crypto.randomUUID(),
          runtimeId: isolationBinding.runtimeId,
          labId: row.lab_id,
          bindingGeneration: generation,
          checkedAt: health.value.checkedAt,
          healthy: health.value.healthy,
          ready: health.value.ready,
          security: health.value.security,
        },
      });
    }
  }

  /*
   * Fast path for an already-ready environment.
   */
  if (
    (record.status === "READY" || record.status === "RUNNING") &&
    currentPersistence?.state === "ACTIVE"
  ) {
    const descriptor: EnvironmentDescriptor = {
      handle,
      status: record.status,
      capabilities: selection.provider.capabilities,
      resourcePolicy: DEFAULT_RESOURCE_POLICY,
      snapshotId: record.snapshotId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastActiveAt: record.lastActiveAt,
      expiresAt: record.expiresAt,
      metadata: record.metadata,
    };

    if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) {
      const restarted = await selection.provider.startEnvironment(handle);

      if (!restarted.ok) {
        return restarted;
      }

      await persistProviderDescriptor(db, userId, lab.id, restarted.value);

      return providerOk<LabSession>({
        provider: selection.provider,
        providerId: selection.providerId,
        realLinux: selection.realLinux,
        handle,
        instanceId: canonicalInstanceId,
        descriptor: restarted.value,
        ...(isolationBinding ? { isolationBinding } : {}),
        ...(isolationVerification ? { isolationVerification } : {}),
      });
    }

    return providerOk<LabSession>({
      provider: selection.provider,
      providerId: selection.providerId,
      realLinux: selection.realLinux,
      handle,
      instanceId: canonicalInstanceId,
      descriptor,
      ...(isolationBinding ? { isolationBinding } : {}),
      ...(isolationVerification ? { isolationVerification } : {}),
    });
  }

  if (!startIfNeeded) {
    const descriptor: EnvironmentDescriptor = {
      handle,
      status: record.status,
      capabilities: selection.provider.capabilities,
      resourcePolicy: DEFAULT_RESOURCE_POLICY,
      snapshotId: record.snapshotId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastActiveAt: record.lastActiveAt,
      expiresAt: record.expiresAt,
      metadata: record.metadata,
    };

    return providerOk<LabSession>({
      provider: selection.provider,
      providerId: selection.providerId,
      realLinux: selection.realLinux,
      handle,
      instanceId: canonicalInstanceId,
      descriptor,
      ...(isolationBinding ? { isolationBinding } : {}),
      ...(isolationVerification ? { isolationVerification } : {}),
    });
  }

  const started = await selection.provider.startEnvironment(handle);

  if (!started.ok) {
    return started;
  }

  await persistProviderDescriptor(db, userId, lab.id, started.value);

  const latestPersistence = await getEnvironmentPersistence(db, userId, record.environmentId);

  if (latestPersistence && latestPersistence.state !== "ACTIVE") {
    if (latestPersistence.state !== "STOPPED" && latestPersistence.state !== "READY") {
      return providerFail(
        "INTERNAL",
        `Persistent environment cannot be activated from ${latestPersistence.state}.`,
        true,
      );
    }

    await markEnvironmentActive({
      db,
      userId,
      environmentId: record.environmentId,
      artifactRef: record.environmentId,
    });
  }

  return providerOk<LabSession>({
    provider: selection.provider,
    providerId: selection.providerId,
    realLinux: selection.realLinux,
    handle,
    instanceId: canonicalInstanceId,
    descriptor: started.value,
    ...(isolationBinding ? { isolationBinding } : {}),
    ...(isolationVerification ? { isolationVerification } : {}),
  });
}

export function statusView(session: LabSession): SandboxStatusView {
  const caps = session.descriptor.capabilities;

  return {
    provider: session.providerId,
    label: caps.label,
    description: caps.description,
    realLinux: caps.realLinux,
    modelled: caps.modelled,
    status: session.descriptor.status,
    available: true,
    unavailableReason: session.realLinux.available ? null : session.realLinux.reason,
    limits: {
      executionTimeoutMs: session.descriptor.resourcePolicy.executionTimeoutMs,
      network: session.descriptor.resourcePolicy.network,
    },
  };
}

/** Mirror a bounded observation of a real lab into narrative world state. */
async function syncObservedFilesystem(
  db: Db,
  userId: string,
  session: LabSession,
  state: import("./contract").FilesystemState,
  challengeId: string | null,
) {
  if (!session.descriptor.capabilities.realLinux) {
    return;
  }

  const observed = state.objects.filter((object) => object.path !== "");

  const existing = await db
    .from("lab_world_objects")
    .select("object_id,path,created_by_challenge")
    .eq("user_id", userId)
    .eq("lab_id", session.handle.labId);

  if (existing.error) {
    throw new Error(existing.error.message);
  }

  const existingByPath = new Map((existing.data ?? []).map((row) => [row.path, row]));

  const observedPaths = new Set(observed.map((object) => object.path));

  for (const object of observed) {
    const current = existingByPath.get(object.path);

    const content =
      object.objectType === "file" ? redactText(object.content.slice(0, 4096)).text : "";

    const currentState = {
      permissions: object.permissions,
      content,
      observed: true,
      modelled: false,
    };

    if (current) {
      const result = await db
        .from("lab_world_objects")
        .update({
          object_type: object.objectType,
          name: object.name,
          current_state: currentState,
          last_modified_by_challenge: challengeId,
          active: true,
        })
        .eq("object_id", current.object_id)
        .eq("user_id", userId);

      if (result.error) {
        throw new Error(result.error.message);
      }
    } else {
      const result = await db.from("lab_world_objects").insert({
        user_id: userId,
        lab_id: session.handle.labId,
        object_type: object.objectType,
        path: object.path,
        name: object.name,
        created_by_challenge: challengeId,
        last_modified_by_challenge: challengeId,
        current_state: currentState,
      });

      if (result.error) {
        throw new Error(result.error.message);
      }
    }
  }

  const stale = (existing.data ?? []).filter((row) => !observedPaths.has(row.path));

  for (const row of stale) {
    const result = await db
      .from("lab_world_objects")
      .update({
        active: false,
      })
      .eq("object_id", row.object_id)
      .eq("user_id", userId);

    if (result.error) {
      throw new Error(result.error.message);
    }
  }
}

/** Persist a redacted execution event. Never stores secrets or provider config. */
export async function recordExecutionEvent(
  db: Db,
  userId: string,
  session: LabSession,
  challengeId: string | null,
  record: ExecutionRecord,
): Promise<void> {
  await syncObservedFilesystem(db, userId, session, record.stateAfter.filesystem, challengeId);

  const safeInput = redactText(record.input);
  const safeStdout = redactText(record.stdout);
  const safeStderr = redactText(record.stderr);

  const redactedFields = [
    ...new Set([
      ...record.redactedFields,
      ...safeInput.redactedFields,
      ...safeStdout.redactedFields,
      ...safeStderr.redactedFields,
    ]),
  ];

  const res = await db.from("lab_command_events").insert({
    user_id: userId,
    lab_instance_id: session.instanceId,
    challenge_id: challengeId,
    provider: record.provider,
    input: safeInput.text.slice(0, 2000),
    cwd_before: record.cwdBefore,
    cwd_after: record.cwdAfter,
    stdout: safeStdout.text.slice(0, 20000),
    stderr: safeStderr.text.slice(0, 20000),
    exit_code: record.exitCode,
    duration_ms: record.durationMs,
    blocked_reason: record.blocked?.reason ?? null,
    state_change_ref: {
      filesystem: record.deltas.filesystem,
      method: record.method,
      outputTruncated: record.outputTruncated,
    },
    metadata: {
      ...record.metadata,
      redactedFields: redactedFields.join(","),
    },
  });

  if (res.error) {
    throw new Error(res.error.message);
  }

  const touch = await db
    .from("lab_instances")
    .update({
      status: record.exitCode === -1 ? "RUNNING" : "READY",
      last_active_at: new Date().toISOString(),
      expires_at: new Date(
        Date.now() + session.descriptor.resourcePolicy.idleExpiryMs,
      ).toISOString(),
    })
    .eq("id", session.instanceId)
    .eq("user_id", userId);

  if (touch.error) {
    throw new Error(touch.error.message);
  }
}

/**
 * Execute learner input in the caller's own environment.
 */
export async function executeInLab(
  db: Db,
  userId: string,
  session: LabSession,
  input: {
    kind: "raw-shell" | "stdin";
    data: string;
  },
  cwd: string,
  challengeId: string | null,
  shell: ShellName = "bash",
  sessionId?: string,
): Promise<ProviderResult<ExecutionRecord>> {
  if (session.handle.userId !== userId) {
    return providerFail("OWNERSHIP_DENIED", "This lab environment belongs to another learner.");
  }

  if (session.descriptor.capabilities.realLinux) {
    if (!session.isolationBinding || !session.isolationVerification) {
      return providerFail("OWNERSHIP_DENIED", "Runtime isolation has not been verified.");
    }

    try {
      authorizeVerifiedRuntimeAccess({
        binding: session.isolationBinding,
        verification: session.isolationVerification,
        learnerId: userId,
        labId: session.handle.labId,
        runtimeId: session.isolationBinding.runtimeId,
        bindingGeneration: session.isolationBinding.bindingGeneration,
      });
    } catch (error) {
      return providerFail(
        "OWNERSHIP_DENIED",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const request = {
    handle: session.handle,
    input:
      input.kind === "stdin"
        ? ({
            kind: "stdin",
            data: input.data,
          } as const)
        : ({
            kind: "raw-shell",
            data: input.data,
          } as const),
    cwd,
    shell,
    ...(sessionId ? { sessionId } : {}),
    challengeRef: challengeId,
    timeoutMs: session.descriptor.resourcePolicy.executionTimeoutMs,
  };

  const result =
    input.kind === "stdin"
      ? await session.provider.sendInput(request)
      : await session.provider.executeCommand(request);

  if (result.ok) {
    await recordExecutionEvent(db, userId, session, challengeId, result.value);
  }

  return result;
}

/** Send a terminal control signal to the foreground process of the caller's lab. */
export const sendTerminalSignal = async (
  db: Db,
  userId: string,
  session: LabSession,
  signal: string,
  cwd: string,
  shell: ShellName = "bash",
  sessionId?: string,
): Promise<ProviderResult<ExecutionRecord>> => {
  if (session.handle.userId !== userId) {
    return providerFail("OWNERSHIP_DENIED", "This lab environment belongs to another learner.");
  }

  if (session.descriptor.capabilities.realLinux) {
    if (!session.isolationBinding || !session.isolationVerification) {
      return providerFail("OWNERSHIP_DENIED", "Runtime isolation has not been verified.");
    }

    try {
      authorizeVerifiedRuntimeAccess({
        binding: session.isolationBinding,
        verification: session.isolationVerification,
        learnerId: userId,
        labId: session.handle.labId,
        runtimeId: session.isolationBinding.runtimeId,
        bindingGeneration: session.isolationBinding.bindingGeneration,
      });
    } catch (error) {
      return providerFail(
        "OWNERSHIP_DENIED",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return session.provider.sendInput({
    handle: session.handle,
    input: {
      kind: "signal",
      data: signal,
    },
    cwd,
    shell,
    ...(sessionId ? { sessionId } : {}),
    challengeRef: null,
    timeoutMs: session.descriptor.resourcePolicy.executionTimeoutMs,
  });
};

/* Lifecycle wrappers used by the authenticated server functions. */

async function runControlledLifecycle<T extends EnvironmentDescriptor>(
  db: Db,
  userId: string,
  session: LabSession,
  kind: "START" | "STOP" | "RESET" | "PAUSE" | "RESUME" | "RESTORE",
  idempotencyKey: string | undefined,
  operation: (operationId: string) => Promise<ProviderResult<T>>,
): Promise<
  ProviderResult<T> & {
    operationId?: string | null;
  }
> {
  if (session.handle.userId !== userId) {
    return {
      ...providerFail("OWNERSHIP_DENIED", "This lab environment belongs to another learner."),
      operationId: null,
    };
  }

  return withLabControlLease(db, userId, session.instanceId, async () => {
    const result = await runTrackedLabOperation(
      db,
      userId,
      session.instanceId,
      kind,
      idempotencyKey,
      operation,
    );

    if (!result.ok) {
      return result;
    }

    const persisted = await persistLifecycleTransition(
      db,
      userId,
      session.instanceId,
      session.descriptor.status,
      result.value.status,
    );

    if (!persisted && session.descriptor.status !== result.value.status) {
      return {
        ...providerFail(
          "INTERNAL",
          "Lab state changed concurrently; reconcile the session before retrying.",
          true,
        ),
        operationId: result.operationId,
      };
    }

    await persistProviderDescriptor(db, userId, session.handle.labId, result.value);

    const persistence = await getEnvironmentPersistence(db, userId, session.handle.environmentId);

    if (persistence) {
      if (kind === "RESET") {
        await markEnvironmentReset({
          db,
          userId,
          environmentId: session.handle.environmentId,
        });
      } else if (kind === "START" || kind === "RESUME" || kind === "RESTORE") {
        await markEnvironmentActive({
          db,
          userId,
          environmentId: session.handle.environmentId,
          artifactRef: session.handle.environmentId,
        });
      }
    }

    return result;
  });
}

export async function stopLab(
  db: Db,
  userId: string,
  session: LabSession,
  idempotencyKey?: string,
) {
  const result = await runControlledLifecycle(db, userId, session, "STOP", idempotencyKey, () =>
    session.provider.stopEnvironment(session.handle),
  );

  if (result.ok) {
    await invalidateTerminalSessionsForInstance(db, userId, session.instanceId, "CLOSED");

    const persistence = await getEnvironmentPersistence(db, userId, session.handle.environmentId);

    if (persistence && persistence.state !== "DESTROYED") {
      await markEnvironmentStopped({
        db,
        userId,
        environmentId: session.handle.environmentId,
        fingerprint: result.value.persistence?.integrityFingerprint ?? null,
      });
    }
  }

  return result;
}

export async function restartLab(
  db: Db,
  userId: string,
  session: LabSession,
  idempotencyKey?: string,
) {
  if (session.handle.userId !== userId) {
    return {
      ...providerFail("OWNERSHIP_DENIED", "This lab environment belongs to another learner."),
      operationId: null,
    };
  }

  return withLabControlLease(db, userId, session.instanceId, async () => {
    const tracked = await runTrackedLabOperation(
      db,
      userId,
      session.instanceId,
      "RESTART",
      idempotencyKey,
      async () => {
        const stopped = await session.provider.stopEnvironment(session.handle);

        if (!stopped.ok) {
          return stopped;
        }

        return session.provider.startEnvironment(session.handle);
      },
    );

    if (!tracked.ok) {
      return tracked;
    }

    const persisted = await persistLifecycleTransition(
      db,
      userId,
      session.instanceId,
      session.descriptor.status,
      tracked.value.status,
    );

    if (!persisted && session.descriptor.status !== tracked.value.status) {
      return {
        ...providerFail(
          "INTERNAL",
          "Lab state changed concurrently; reconcile the session before retrying.",
          true,
        ),
        operationId: tracked.operationId,
      };
    }

    await invalidateTerminalSessionsForInstance(db, userId, session.instanceId, "CLOSED");

    await persistProviderDescriptor(db, userId, session.handle.labId, tracked.value);

    await markEnvironmentActive({
      db,
      userId,
      environmentId: session.handle.environmentId,
      artifactRef: session.handle.environmentId,
    });

    return tracked;
  });
}

export async function resetLab(
  db: Db,
  userId: string,
  session: LabSession,
  idempotencyKey?: string,
) {
  return runControlledLifecycle(db, userId, session, "RESET", idempotencyKey, () =>
    session.provider.resetEnvironment(session.handle),
  );
}

export async function pauseLab(
  db: Db,
  userId: string,
  session: LabSession,
  idempotencyKey?: string,
) {
  return runControlledLifecycle(db, userId, session, "PAUSE", idempotencyKey, () =>
    session.provider.pauseEnvironment(session.handle),
  );
}

export async function resumeLab(
  db: Db,
  userId: string,
  session: LabSession,
  idempotencyKey?: string,
) {
  return runControlledLifecycle(db, userId, session, "RESUME", idempotencyKey, () =>
    session.provider.resumeEnvironment(session.handle),
  );
}

export async function snapshotLab(
  db: Db,
  userId: string,
  session: LabSession,
  idempotencyKey?: string,
) {
  return withLabControlLease(db, userId, session.instanceId, async () => {
    const result = await runTrackedLabOperation(
      db,
      userId,
      session.instanceId,
      "SNAPSHOT",
      idempotencyKey,
      () => session.provider.snapshotEnvironment(session.handle),
    );

    if (result.ok) {
      await db
        .from("lab_instances")
        .update({
          snapshot_id: result.value.snapshotId,
          last_active_at: new Date().toISOString(),
        })
        .eq("id", session.instanceId)
        .eq("user_id", userId);
    }

    return result;
  });
}

export async function restoreLab(
  db: Db,
  userId: string,
  session: LabSession,
  snapshotId: string,
  idempotencyKey?: string,
) {
  return runControlledLifecycle(db, userId, session, "RESTORE", idempotencyKey, () =>
    session.provider.restoreEnvironment(session.handle, snapshotId),
  );
}

export async function destroyLab(
  db: Db,
  userId: string,
  session: LabSession,
  idempotencyKey?: string,
) {
  return withLabControlLease(db, userId, session.instanceId, async () => {
    const result = await runTrackedLabOperation(
      db,
      userId,
      session.instanceId,
      "DESTROY",
      idempotencyKey,
      () => session.provider.destroyEnvironment(session.handle),
    );

    if (!result.ok) {
      return result;
    }

    const persisted = await persistLifecycleTransition(
      db,
      userId,
      session.instanceId,
      session.descriptor.status,
      "STOPPED",
    );

    if (!persisted && session.descriptor.status !== "STOPPED") {
      return {
        ...providerFail(
          "INTERNAL",
          "Lab state changed concurrently; reconcile the session before retrying.",
          true,
        ),
        operationId: result.operationId,
      };
    }

    await invalidateTerminalSessionsForInstance(db, userId, session.instanceId, "CLOSED");

    await db
      .from("lab_instances")
      .update({
        status: "STOPPED",
        last_active_at: new Date().toISOString(),
      })
      .eq("id", session.instanceId)
      .eq("user_id", userId);

    await markEnvironmentDestroyed({
      db,
      userId,
      environmentId: session.handle.environmentId,
    });

    return result;
  });
}

export async function labState(db: Db, userId: string, session: LabSession) {
  const result = await reconcileLabInstance(db, userId, session);

  if (!result.ok) {
    return result;
  }

  const observed = await session.provider.getEnvironmentState(session.handle);

  if (!observed.ok) {
    return observed;
  }

  const persistence = await session.provider.getEnvironmentPersistence(session.handle);

  const enriched = persistence.ok
    ? {
        ...observed.value,
        persistence: persistence.value,
      }
    : observed.value;

  if (persistence.ok && persistence.value.integrityStatus === "FAILED") {
    await markEnvironmentQuarantined({
      db,
      userId,
      environmentId: session.handle.environmentId,
      reason: "Persistent environment artifact integrity verification failed.",
    });
  }

  await persistProviderDescriptor(db, userId, session.handle.labId, enriched);

  const health = await session.provider.getRuntimeHealth();

  const healthPatch = health.ok
    ? {
        last_health_at: health.value.checkedAt,
      }
    : {};

  await db
    .from("lab_instances")
    .update({
      last_reconciled_at: new Date().toISOString(),
      ...healthPatch,
    })
    .eq("id", session.instanceId)
    .eq("user_id", userId);

  return {
    ok: true,
    value: enriched,
  } as const;
}

export async function labFilesystem(db: Db, userId: string, session: LabSession, cwd: string) {
  const result = await session.provider.getFilesystemState(session.handle, cwd);

  if (result.ok) {
    await syncObservedFilesystem(db, userId, session, result.value, null);
  }

  return result;
}

export async function observeLabEnvironment(
  _db: Db,
  _userId: string,
  session: LabSession,
  scope?: import("../environment/types").TargetedObservationScope,
) {
  const { createEnvironmentObserver } = await import("../environment/observer.server");
  const observer = createEnvironmentObserver(session.provider);
  return observer.observe(session.handle, scope ? { scope } : {});
}
