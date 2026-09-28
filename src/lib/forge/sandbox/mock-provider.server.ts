/**
 * Modelled (mock) sandbox provider — server only.
 *
 * This adapter implements {@link SandboxProvider} on top of the already-shipped
 * deterministic model executor. It is NOT Linux and never claims to be: it
 * models a narrow, approved set of educational filesystem and permission
 * behaviour over rows the learner owns.
 *
 * Nothing here spawns a process, touches a host filesystem, opens a socket, or
 * evaluates learner input as code. The provider is pure over an injected
 * backing store, so the store (and therefore all persistence) is owned by the
 * authenticated server layer, not by the executor.
 */

import {
  DEFAULT_RESOURCE_POLICY,
  MOCK_PROVIDER_ID,
  providerFail,
  providerOk,
  type EnvironmentDescriptor,
  type EnvironmentHandle,
  type EnvironmentObservation,
  type ExecutionRecord,
  type ExecutionRequest,
  type FilesystemDelta,
  type FilesystemState,
  type ProviderCapabilities,
  type ProviderResult,
  type ResourcePolicy,
  type SandboxFsObject,
  type SandboxFsView,
  type SandboxProvider,
  type SnapshotRef,
  type StreamChunk,
} from "./contract";
import { modelExecutor, type Mutation } from "../executor.server";

export const MOCK_CAPABILITIES: ProviderCapabilities = {
  id: MOCK_PROVIDER_ID,
  label: "Modelled training sandbox",
  description:
    "A deterministic model of a small set of approved filesystem and permission operations. This is not a real Linux machine and has no host, network or shell access.",
  realLinux: false,
  runtimeClass: "modelled",
  modelled: true,
  interactiveShell: false,
  streaming: false,
  resize: true,
  processes: false,
  services: false,
  environmentVariables: false,
  network: false,
  snapshots: true,
  pauseResume: true,
};

/** Persisted lab-instance shape the provider reads and patches via the store. */
export type SandboxInstanceRecord = {
  environmentId: string;
  userId: string;
  labId: string;
  status: EnvironmentDescriptor["status"];
  snapshotId: string | null;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
  expiresAt: string | null;
  metadata: Readonly<Record<string, string>>;
};

/**
 * Persistence seam. The authenticated server layer supplies an implementation
 * backed by the learner's own rows (RLS-scoped); tests supply an in-memory one.
 */
export type MockBackingStore = {
  readInstance(handle: EnvironmentHandle): Promise<SandboxInstanceRecord | null>;
  createInstance(input: {
    userId: string;
    labId: string;
    metadata: Readonly<Record<string, string>>;
  }): Promise<SandboxInstanceRecord>;
  patchInstance(
    handle: EnvironmentHandle,
    patch: Partial<
      Pick<
        SandboxInstanceRecord,
        "status" | "snapshotId" | "lastActiveAt" | "expiresAt" | "metadata"
      >
    >,
  ): Promise<SandboxInstanceRecord>;
  readFilesystem(handle: EnvironmentHandle): Promise<SandboxFsView>;
  applyMutations(
    handle: EnvironmentHandle,
    challengeRef: string | null,
    mutations: Mutation[],
  ): Promise<void>;
  clearFilesystem(handle: EnvironmentHandle): Promise<void>;
};

const FS_ROOT = "/home/learner";

const clone = (o: SandboxFsObject): SandboxFsObject => ({ ...o });

function fsState(view: SandboxFsView, cwd: string): FilesystemState {
  return {
    root: FS_ROOT,
    cwd,
    objects: [...view.values()].map(clone).sort((a, b) => a.path.localeCompare(b.path)),
    modelled: true,
  };
}

function observation(
  status: EnvironmentDescriptor["status"],
  view: SandboxFsView,
  cwd: string,
  policy: ResourcePolicy,
): EnvironmentObservation {
  return {
    status,
    filesystem: fsState(view, cwd),
    processes: { supported: false, processes: [] },
    services: { supported: false, services: [] },
    network: { supported: false, policy: policy.network, listeners: [] },
    environmentVariables: { supported: false, variables: {}, redactedKeys: [] },
    observedAt: new Date().toISOString(),
  };
}

function descriptor(record: SandboxInstanceRecord, policy: ResourcePolicy): EnvironmentDescriptor {
  const persistenceState = record.status === "STOPPED" ? "STOPPED" : "ACTIVE";
  return {
    handle: {
      provider: MOCK_PROVIDER_ID,
      environmentId: record.environmentId,
      userId: record.userId,
      labId: record.labId,
    },
    status: record.status,
    capabilities: MOCK_CAPABILITIES,
    resourcePolicy: policy,
    snapshotId: record.snapshotId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastActiveAt: record.lastActiveAt,
    expiresAt: record.expiresAt,
    metadata: record.metadata,
    persistence: {
      state: persistenceState,
      environmentGeneration: 1,
      artifactVersion: 1,
      artifactRef: record.environmentId,
      integrityStatus: "VERIFIED",
      integrityFingerprint: null,
      lastPersistedAt: record.status === "STOPPED" ? record.updatedAt : null,
      lastVerifiedAt: record.updatedAt,
      lastRestoredAt: record.status === "RUNNING" ? record.updatedAt : null,
      destroyedAt: null,
    },
  };
}

/** Metadata redaction: only short, non-sensitive descriptive values survive. */
const SENSITIVE_KEY = /(secret|token|key|password|passwd|credential|authorization|cookie|session)/i;

export function redactMetadata(metadata: Readonly<Record<string, string>>): {
  metadata: Record<string, string>;
  redactedFields: string[];
} {
  const out: Record<string, string> = {};
  const redactedFields: string[] = [];
  for (const [k, v] of Object.entries(metadata)) {
    if (SENSITIVE_KEY.test(k)) {
      redactedFields.push(k);
      continue;
    }
    out[k] = v.slice(0, 200);
  }
  return { metadata: out, redactedFields };
}

/** Input redaction: never persist anything that looks like a credential. */
export function redactInput(input: string): { input: string; redactedFields: string[] } {
  const redactedFields: string[] = [];
  let out = input;
  const patterns: { re: RegExp; field: string }[] = [
    {
      re: /(--?(?:password|token|secret|api[-_]?key)[=\s]+)(\S+)/gi,
      field: "input.credential-flag",
    },
    {
      re: /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,})\b/g,
      field: "input.jwt",
    },
    { re: /\b(sb_(?:secret|publishable)_[A-Za-z0-9_-]{8,})\b/g, field: "input.api-key" },
  ];
  for (const p of patterns) {
    if (p.re.test(out)) {
      redactedFields.push(p.field);
      out = out.replace(p.re, (_m, prefix: string | undefined) => `${prefix ?? ""}[redacted]`);
    }
    p.re.lastIndex = 0;
  }
  return { input: out, redactedFields };
}

function deltasFor(mutations: Mutation[], after: SandboxFsView): FilesystemDelta[] {
  return mutations.map((m) => {
    const obj = after.get(m.path);
    return {
      kind: m.kind === "create" ? "created" : m.permissions ? "permissions" : "modified",
      path: m.path,
      objectType: m.kind === "create" ? m.objectType : (obj?.objectType ?? "file"),
      permissions:
        m.kind === "create" ? m.permissions : (m.permissions ?? obj?.permissions ?? null),
      contentBytes: obj ? obj.content.length : null,
    };
  });
}

export function createMockSandboxProvider(store: MockBackingStore): SandboxProvider {
  const policy: ResourcePolicy = DEFAULT_RESOURCE_POLICY;

  const requireOwned = async (
    handle: EnvironmentHandle,
  ): Promise<ProviderResult<SandboxInstanceRecord>> => {
    if (handle.provider !== MOCK_PROVIDER_ID)
      return providerFail(
        "PROVIDER_NOT_CONFIGURED",
        "Only the modelled sandbox provider is configured.",
      );
    const record = await store.readInstance(handle);
    if (!record)
      return providerFail("ENVIRONMENT_NOT_FOUND", "No lab environment exists for this learner.");
    if (record.userId !== handle.userId)
      return providerFail("OWNERSHIP_DENIED", "This lab environment belongs to another learner.");
    return providerOk(record);
  };

  const touch = async (
    handle: EnvironmentHandle,
    status: EnvironmentDescriptor["status"],
  ): Promise<EnvironmentDescriptor> => {
    const now = new Date();
    const record = await store.patchInstance(handle, {
      status,
      lastActiveAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + policy.idleExpiryMs).toISOString(),
    });
    return descriptor(record, policy);
  };

  return {
    capabilities: MOCK_CAPABILITIES,

    async createEnvironment(request) {
      const { metadata } = redactMetadata(request.metadata);
      const record = await store.createInstance({
        userId: request.userId,
        labId: request.labId,
        metadata: { ...metadata, provider_kind: "modelled", real_linux: "false" },
      });
      return providerOk(descriptor(record, policy));
    },

    async stopEnvironment(handle) {
      const current = await store.readInstance(handle);
      if (!current) return providerFail("ENVIRONMENT_NOT_FOUND", "Lab environment not found.");
      return providerOk(
        descriptor(await store.patchInstance(handle, { status: "STOPPED" }), policy),
      );
    },
    async startEnvironment(handle) {
      const owned = await requireOwned(handle);
      if (!owned.ok) return owned;
      return providerOk(await touch(handle, "READY"));
    },

    async executeCommand(request) {
      const owned = await requireOwned(request.handle);
      if (!owned.ok) return owned;
      if (request.input.kind !== "raw-shell")
        return providerFail(
          "UNSUPPORTED_OPERATION",
          "The modelled sandbox accepts whole command lines only; interactive stdin arrives with a real isolated provider.",
        );
      if (owned.value.status === "PAUSED")
        return providerFail(
          "ENVIRONMENT_NOT_READY",
          "Resume the lab before running commands.",
          true,
        );

      const view = await store.readFilesystem(request.handle);
      const before = observation("RUNNING", view, request.cwd, policy);
      const startedAt = Date.now();

      const execution = modelExecutor.execute(view, request.cwd, request.input.data);

      if (execution.mutations.length > 0)
        await store.applyMutations(request.handle, request.challengeRef, execution.mutations);

      const durationMs = Math.max(1, Date.now() - startedAt);
      const after = observation("READY", view, execution.cwd, policy);

      const chunks: StreamChunk[] = execution.lines.map((l, i) => ({
        seq: i,
        stream: l.kind === "error" ? "stderr" : l.kind === "system" ? "system" : "stdout",
        text: l.text,
        atMs: durationMs,
      }));

      const joined = (kinds: StreamChunk["stream"][]) =>
        chunks
          .filter((c) => kinds.includes(c.stream))
          .map((c) => c.text)
          .join("\n");

      let stdout = joined(["stdout", "system"]);
      let stderr = joined(["stderr"]);
      const outputTruncated = stdout.length + stderr.length > policy.maxOutputBytes;
      if (outputTruncated) {
        stdout = stdout.slice(0, policy.maxOutputBytes);
        stderr = stderr.slice(0, policy.maxOutputBytes);
      }

      const redaction = redactInput(request.input.data);
      const record = await touch(request.handle, "READY");

      return providerOk<ExecutionRecord>({
        shell: request.shell ?? "bash",
        provider: MOCK_PROVIDER_ID,
        environmentId: request.handle.environmentId,
        input: redaction.input,
        inputKind: "raw-shell",
        cwdBefore: request.cwd,
        cwdAfter: execution.cwd,
        stdout,
        stderr,
        exitCode: execution.blocked ? 126 : stderr ? 1 : 0,
        durationMs,
        chunks,
        outputTruncated,
        blocked: execution.blocked,
        stateBefore: before,
        stateAfter: after,
        deltas: {
          filesystem: deltasFor(execution.mutations, view),
          processes: [],
          services: [],
          network: [],
        },
        method: {
          statements: execution.evidence.commands,
          usedLoopConstruct: execution.evidence.usedLoop,
          effectiveOperations: execution.evidence.operations,
          invocations: execution.evidence.invocations,
        },
        metadata: { ...record.metadata, modelled: "true" },
        redactedFields: redaction.redactedFields,
      });
    },

    async sendInput() {
      return providerFail(
        "UNSUPPORTED_OPERATION",
        "The modelled sandbox has no long-running foreground process to receive stdin. A real isolated provider supplies interactive input.",
      );
    },

    async resizeTerminal(handle, size) {
      const owned = await requireOwned(handle);
      if (!owned.ok) return owned;
      const cols = Math.max(20, Math.min(400, Math.round(size.cols)));
      const rows = Math.max(5, Math.min(200, Math.round(size.rows)));
      await store.patchInstance(handle, {
        metadata: { ...owned.value.metadata, cols: String(cols), rows: String(rows) },
      });
      return providerOk({ cols, rows });
    },

    async getRuntimeHealth() {
      return providerOk({
        provider: MOCK_PROVIDER_ID,
        runtimeClass: "modelled",
        runtimeVersion: "modelled-v1",
        healthy: true,
        ready: true,
        checkedAt: new Date().toISOString(),
        security: {
          networkIsolationEnforced: true,
          hostFilesystemBlocked: true,
          privilegeEscalationBlocked: true,
          metadataAccessBlocked: true,
        },
        capacity: { activeEnvironments: 0, maxEnvironments: null },
      });
    },

    async getEnvironmentState(handle) {
      const owned = await requireOwned(handle);
      if (!owned.ok) return owned;
      const expired =
        owned.value.expiresAt !== null && new Date(owned.value.expiresAt).getTime() < Date.now();
      return providerOk(
        descriptor(expired ? { ...owned.value, status: "EXPIRED" } : owned.value, policy),
      );
    },

    async getEnvironmentPersistence(handle) {
      const owned = await requireOwned(handle);
      if (!owned.ok) return owned;
      const state = owned.value.status === "STOPPED" ? "STOPPED" : "ACTIVE";
      return providerOk({
        state,
        environmentGeneration: 1,
        artifactVersion: 1,
        artifactRef: owned.value.environmentId,
        integrityStatus: "VERIFIED",
        integrityFingerprint: null,
        lastPersistedAt: state === "STOPPED" ? owned.value.updatedAt : null,
        lastVerifiedAt: owned.value.updatedAt,
        lastRestoredAt: state === "ACTIVE" ? owned.value.updatedAt : null,
        destroyedAt: null,
      });
    },

    async getFilesystemState(handle, cwd) {
      const owned = await requireOwned(handle);
      if (!owned.ok) return owned;
      return providerOk(fsState(await store.readFilesystem(handle), cwd));
    },

    async getProcessState(handle) {
      const owned = await requireOwned(handle);
      if (!owned.ok) return owned;
      return providerOk({ supported: false, processes: [] });
    },

    async getServiceState(handle) {
      const owned = await requireOwned(handle);
      if (!owned.ok) return owned;
      return providerOk({ supported: false, services: [] });
    },

    async getEnvironmentVariables(handle) {
      const owned = await requireOwned(handle);
      if (!owned.ok) return owned;
      // The modelled sandbox intentionally exposes no environment variables:
      // it must never surface app, database or provider configuration.
      return providerOk({ supported: false, variables: {}, redactedKeys: [] });
    },

    async inspectEnvironment(handle, paths) {
      const owned = await requireOwned(handle);
      if (!owned.ok) return owned;
      const view = await store.readFilesystem(handle);
      const requested = new Set(paths.map((entry) => entry.path));
      const filesystem = [...view.values()]
        .filter((object) => requested.has(object.path))
        .map((object) => ({
          path: object.path,
          objectType: object.objectType,
          permissions: object.permissions,
          owner: "learner",
          group: "learner",
          sizeBytes: Buffer.byteLength(object.content, "utf8"),
          content: paths.find((entry) => entry.path === object.path)?.includeContent
            ? object.content.slice(0, 64_000)
            : null,
          contentTruncated: object.content.length > 64_000,
        }));
      return providerOk({
        filesystem,
        processes: [],
        services: [],
        network: [],
        capturedAt: new Date().toISOString(),
      });
    },

    async resetEnvironment(handle) {
      const owned = await requireOwned(handle);
      if (!owned.ok) return owned;
      await store.patchInstance(handle, { status: "RESETTING" });
      await store.clearFilesystem(handle);
      return providerOk(await touch(handle, "READY"));
    },

    async snapshotEnvironment(handle) {
      const owned = await requireOwned(handle);
      if (!owned.ok) return owned;
      const snapshotId = `mock-snap-${Date.now().toString(36)}`;
      await store.patchInstance(handle, { snapshotId });
      return providerOk<SnapshotRef>({ snapshotId, createdAt: new Date().toISOString() });
    },

    async restoreEnvironment(handle, snapshotId) {
      const owned = await requireOwned(handle);
      if (!owned.ok) return owned;
      if (owned.value.snapshotId !== snapshotId)
        return providerFail(
          "UNSUPPORTED_OPERATION",
          "That snapshot is not available for this modelled environment.",
        );
      // The modelled provider records snapshot references only; it does not
      // fabricate historical filesystem images.
      return providerOk(await touch(handle, "READY"));
    },

    async pauseEnvironment(handle) {
      const owned = await requireOwned(handle);
      if (!owned.ok) return owned;
      return providerOk(await touch(handle, "PAUSED"));
    },

    async resumeEnvironment(handle) {
      const owned = await requireOwned(handle);
      if (!owned.ok) return owned;
      return providerOk(await touch(handle, "READY"));
    },

    async destroyEnvironment(handle) {
      const owned = await requireOwned(handle);
      if (!owned.ok) return owned;
      await store.clearFilesystem(handle);
      await store.patchInstance(handle, { status: "STOPPED" });
      return providerOk({ destroyed: true as const });
    },

    async getPackageState(handle, packageNames) {
      const owned = await requireOwned(handle);
      if (!owned.ok) return owned;
      const allMockPackages = [
        { name: "bash", version: "5.2.15-2+b7", status: "installed" },
        { name: "coreutils", version: "9.1-1", status: "installed" },
        { name: "curl", version: "7.88.1-10+deb12u5", status: "installed" },
        { name: "nmap", version: "7.93+dfsg1-1", status: "installed" },
      ];
      const selected = packageNames && packageNames.length > 0
        ? allMockPackages.filter((p) => packageNames.includes(p.name))
        : allMockPackages;
      return providerOk({
        supported: true,
        packageManager: "dpkg" as const,
        packages: selected,
      });
    },

    async getGuestIdentity(handle) {
      const owned = await requireOwned(handle);
      if (!owned.ok) return owned;
      return providerOk({
        environmentId: handle.environmentId,
        expectedArtifactRelease: "2026.2",
        guestName: "Modelled Linux",
        guestVersion: "2026.2",
        guestVersionMatchesArtifact: true,
        kernel: "6.18.0-modelled",
        verifiedAt: new Date().toISOString(),
      });
    },
  };
}
