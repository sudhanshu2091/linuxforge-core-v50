import { describe, expect, it } from "vitest";
import { createMockSandboxProvider, type MockBackingStore, type SandboxInstanceRecord } from "../sandbox/mock-provider.server";
import { EnvironmentObserver } from "./observer.server";
import { DEFAULT_RESOURCE_POLICY, type EnvironmentHandle } from "../sandbox/contract";

function createInMemoryStore(): MockBackingStore {
  const instances = new Map<string, SandboxInstanceRecord>();
  const filesystems = new Map<string, Map<string, any>>();

  return {
    async readInstance(handle: EnvironmentHandle) {
      return instances.get(handle.environmentId) ?? null;
    },
    async createInstance(input) {
      const now = new Date().toISOString();
      const record: SandboxInstanceRecord = {
        environmentId: `mock-env-${Math.random().toString(36).slice(2, 8)}`,
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
        metadata: patch.metadata ?? existing.metadata,
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

describe("EnvironmentObserver & Security Boundary", () => {
  it("executes observation through SandboxProvider without host leakages", async () => {
    const store = createInMemoryStore();
    const provider = createMockSandboxProvider(store);

    const createRes = await provider.createEnvironment({
      labId: "lab-1",
      userId: "user-1",
      metadata: {},
      resourcePolicy: DEFAULT_RESOURCE_POLICY,
    });
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const handle = createRes.value.handle;
    const observer = new EnvironmentObserver(provider);

    const outcome = await observer.observe(handle);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.snapshot.environmentId).toBe(handle.environmentId);
    expect(outcome.model.identity.provider).toBe("mock-modelled-v1");
    expect(outcome.model.runtime.security.hostFilesystemBlocked).toBe(true);
    expect(outcome.model.runtime.security.privilegeEscalationBlocked).toBe(true);
    expect(outcome.model.runtime.security.guestRootAllowed).toBe(true);

    const envVars = outcome.model.environment.variables;
    for (const key of Object.keys(envVars)) {
      expect(key.toUpperCase()).not.toContain("SECRET");
      expect(key.toUpperCase()).not.toContain("TOKEN");
      expect(key.toUpperCase()).not.toContain("PASSWORD");
    }
  });

  it("handles targeted observation queries accurately including packageState", async () => {
    const store = createInMemoryStore();
    const provider = createMockSandboxProvider(store);

    const createRes = await provider.createEnvironment({
      labId: "lab-2",
      userId: "user-2",
      metadata: {},
      resourcePolicy: DEFAULT_RESOURCE_POLICY,
    });
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const handle = createRes.value.handle;
    const observer = new EnvironmentObserver(provider);

    // Targeted filesystem query
    const fsObjects = await observer.observeFilesystem(handle, [
      { path: "/home/learner" },
    ]);
    expect(Array.isArray(fsObjects)).toBe(true);

    // Targeted packages query
    const pkgs = await observer.observePackages(handle, ["bash", "coreutils"]);
    expect(pkgs).toHaveLength(2);
    expect(pkgs[0]?.packageName).toBe("bash");
    expect(pkgs[0]?.installed).toBe(true);

    // Targeted identity query
    const identity = await observer.observeIdentity(handle);
    expect(identity.environmentId).toBe(handle.environmentId);

    // Targeted runtime query
    const runtime = await observer.observeRuntime(handle);
    expect(runtime.capabilities).toBeDefined();
    expect(runtime.security.networkIsolationEnforced).toBe(true);
  });

  it("gracefully records error when observing an unconfigured or non-existent environment", async () => {
    const store = createInMemoryStore();
    const provider = createMockSandboxProvider(store);

    const badHandle: EnvironmentHandle = {
      provider: "mock-modelled-v1",
      environmentId: "non-existent-env",
      userId: "user-x",
      labId: "lab-x",
    };

    const observer = new EnvironmentObserver(provider);
    const outcome = await observer.observe(badHandle);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBeDefined();
    }
  });
});
