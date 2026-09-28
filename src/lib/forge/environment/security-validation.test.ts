import { describe, expect, it } from "vitest";
import { createMockSandboxProvider, type MockBackingStore, type SandboxInstanceRecord } from "../sandbox/mock-provider.server";
import { EnvironmentObserver } from "./observer.server";
import { DEFAULT_RESOURCE_POLICY, type EnvironmentHandle } from "../sandbox/contract";

function createStrictStore(): MockBackingStore {
  const instances = new Map<string, SandboxInstanceRecord>();
  const filesystems = new Map<string, Map<string, any>>();

  return {
    async readInstance(handle: EnvironmentHandle) {
      return instances.get(handle.environmentId) ?? null;
    },
    async createInstance(input) {
      const now = new Date().toISOString();
      const record: SandboxInstanceRecord = {
        environmentId: `strict-env-${Math.random().toString(36).slice(2, 8)}`,
        userId: input.userId,
        labId: input.labId,
        status: "READY",
        snapshotId: null,
        createdAt: now,
        updatedAt: now,
        lastActiveAt: now,
        expiresAt: null,
        metadata: input.metadata ?? {},
      };
      instances.set(record.environmentId, record);
      return record;
    },
    async patchInstance(handle: EnvironmentHandle, patch) {
      const existing = instances.get(handle.environmentId);
      if (!existing) throw new Error("no instance");
      const updated: SandboxInstanceRecord = {
        ...existing,
        ...patch,
      };
      instances.set(handle.environmentId, updated);
      return updated;
    },
    async readFilesystem(handle: EnvironmentHandle) {
      return filesystems.get(handle.environmentId) ?? new Map();
    },
    async applyMutations() {},
    async clearFilesystem(handle: EnvironmentHandle) {
      filesystems.delete(handle.environmentId);
    },
  };
}

describe("Security Validation & Isolation Bounds", () => {
  it("enforces tenant boundary: rejects observation across learners", async () => {
    const store = createStrictStore();
    const provider = createMockSandboxProvider(store);

    // Learner A creates an environment
    const createRes = await provider.createEnvironment({
      labId: "lab-secure",
      userId: "learner-alice",
      metadata: {},
      resourcePolicy: DEFAULT_RESOURCE_POLICY,
    });
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const aliceHandle = createRes.value.handle;

    // Learner Bob attempts to observe Alice's environment
    const unauthorizedHandle: EnvironmentHandle = {
      ...aliceHandle,
      userId: "learner-bob",
    };

    const observer = new EnvironmentObserver(provider);
    const outcome = await observer.observe(unauthorizedHandle);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("OWNERSHIP_DENIED");
      expect(outcome.error.message).toMatch(/belongs to another learner/i);
    }
  });

  it("prohibits host credentials, tokens, and monitor paths from being surfaced", async () => {
    const store = createStrictStore();
    const provider = createMockSandboxProvider(store);

    const createRes = await provider.createEnvironment({
      labId: "lab-audit",
      userId: "learner-auditor",
      metadata: {
        "FORGE_RUNTIME_SERVICE_TOKEN": "super-secret-token",
        "AUTH_SECRET": "db-secret",
        "description": "Safe descriptive text",
      },
      resourcePolicy: DEFAULT_RESOURCE_POLICY,
    });
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const observer = new EnvironmentObserver(provider);
    const outcome = await observer.observe(createRes.value.handle);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // 1. In EnvironmentVariables
    const vars = outcome.model.environment.variables;
    for (const [k, v] of Object.entries(vars)) {
      expect(k.toUpperCase()).not.toMatch(/SECRET|TOKEN|KEY|PASSWORD|CREDENTIAL/);
      expect(v).not.toContain("super-secret");
    }

    // 2. In Runtime Metadata
    expect(outcome.model.runtime.security.hostFilesystemBlocked).toBe(true);
    expect(outcome.model.runtime.security.privilegeEscalationBlocked).toBe(true);
    expect(outcome.model.runtime.security.guestRootAllowed).toBe(true);
  });
});
