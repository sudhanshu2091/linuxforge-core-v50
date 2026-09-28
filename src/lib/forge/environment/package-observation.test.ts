import { describe, expect, it, vi } from "vitest";
import { createRealLinuxSandboxProvider } from "../sandbox/real-linux-provider.server";
import { createMockSandboxProvider, type MockBackingStore, type SandboxInstanceRecord } from "../sandbox/mock-provider.server";
import { EnvironmentObserver } from "./observer.server";
import { normalizePackages } from "./normalization";
import { createMissionArtifact, evaluateArtifactAgainstModel } from "./artifacts";
import { DEFAULT_RESOURCE_POLICY, type EnvironmentHandle, type SandboxProvider } from "../sandbox/contract";
import type { CanonicalEnvironmentModel } from "./types";

function createInMemoryStore(): MockBackingStore {
  const instances = new Map<string, SandboxInstanceRecord>();
  return {
    async readInstance(handle: EnvironmentHandle) {
      return instances.get(handle.environmentId) ?? null;
    },
    async createInstance(input) {
      const now = new Date().toISOString();
      const record: SandboxInstanceRecord = {
        environmentId: `mock-pkg-env-${Math.random().toString(36).slice(2, 8)}`,
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
    async patchInstance(handle, patch) {
      const existing = instances.get(handle.environmentId);
      if (!existing) throw new Error("no instance");
      const updated = { ...existing, ...patch };
      instances.set(handle.environmentId, updated);
      return updated;
    },
    async readFilesystem() {
      return new Map();
    },
    async applyMutations() {},
    async clearFilesystem() {},
  };
}

describe("Package Observation Provider-Neutral Pipeline", () => {
  it("1. real provider adapter calls the runtime package endpoint", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, opts: any) => {
      if (url.includes("/packages")) {
        const body = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            value: {
              supported: true,
              packageManager: "dpkg",
              packages: body.packageNames.map((name: string) => ({
                name,
                version: "1.0.0",
                status: "installed",
              })),
            },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, value: {} }),
      };
    });

    vi.stubGlobal("fetch", fetchMock);

    try {
      const provider = createRealLinuxSandboxProvider({
        FORGE_SANDBOX_ENDPOINT: "http://127.0.0.1:18080",
        FORGE_SANDBOX_CREDENTIAL: "test-credential",
        FORGE_SANDBOX_IMAGE: "kali-2026.2-arm64",
        FORGE_SANDBOX_RUNTIME_MODE: "development",
        FORGE_SANDBOX_RUNTIME_CLASS: "container-dev",
      });

      expect(typeof provider.getPackageState).toBe("function");

      const handle: EnvironmentHandle = {
        provider: "real-linux-isolated-v1",
        environmentId: "env-pkg-real-test",
        userId: "user-1",
        labId: "lab-1",
      };

      const result = await provider.getPackageState!(handle, ["bash", "coreutils"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.supported).toBe(true);
        expect(result.value.packages).toHaveLength(2);
        expect(result.value.packages[0]?.name).toBe("bash");
      }

      // Verify URL and payload passed to fetch
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:18080/v1/environments/env-pkg-real-test/packages",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            authorization: "Bearer test-credential",
          }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("2. mock provider returns deterministic package state", async () => {
    const store = createInMemoryStore();
    const provider = createMockSandboxProvider(store);

    const createRes = await provider.createEnvironment({
      labId: "lab-pkg-mock",
      userId: "user-mock",
      metadata: {},
      resourcePolicy: DEFAULT_RESOURCE_POLICY,
    });
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const handle = createRes.value.handle;
    expect(typeof provider.getPackageState).toBe("function");

    const resAll = await provider.getPackageState!(handle);
    expect(resAll.ok).toBe(true);
    if (resAll.ok) {
      expect(resAll.value.supported).toBe(true);
      expect(resAll.value.packages.length).toBeGreaterThanOrEqual(4);
    }

    const resFilter = await provider.getPackageState!(handle, ["bash", "nmap"]);
    expect(resFilter.ok).toBe(true);
    if (resFilter.ok) {
      expect(resFilter.value.packages).toHaveLength(2);
      expect(resFilter.value.packages.map((p) => p.name)).toEqual(["bash", "nmap"]);
    }
  });

  it("3. observer can request specific packages via targeted scope", async () => {
    const store = createInMemoryStore();
    const provider = createMockSandboxProvider(store);

    const createRes = await provider.createEnvironment({
      labId: "lab-pkg-target",
      userId: "user-target",
      metadata: {},
      resourcePolicy: DEFAULT_RESOURCE_POLICY,
    });
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const observer = new EnvironmentObserver(provider);
    const pkgs = await observer.observePackages(createRes.value.handle, ["coreutils"]);
    expect(pkgs).toHaveLength(1);
    expect(pkgs[0]?.packageName).toBe("coreutils");
    expect(pkgs[0]?.installed).toBe(true);
    expect(pkgs[0]?.evidence).toBe("OBSERVED_FACT");
  });

  it("4. normalizePackages() receives actual provider data and marks OBSERVED_FACT", () => {
    const pkgs = normalizePackages({
      handle: {
        provider: "real-linux-isolated-v1",
        environmentId: "env-1",
        userId: "u-1",
        labId: "l-1",
      },
      packageState: {
        supported: true,
        packageManager: "dpkg",
        packages: [
          { name: "tcpdump", version: "4.99.3-1", status: "installed" },
        ],
      },
    });

    expect(pkgs).toHaveLength(1);
    expect(pkgs[0]?.packageName).toBe("tcpdump");
    expect(pkgs[0]?.version).toBe("4.99.3-1");
    expect(pkgs[0]?.installed).toBe(true);
    expect(pkgs[0]?.evidence).toBe("OBSERVED_FACT");
  });

  it("5. package artifact verification works", () => {
    const artifact = createMissionArtifact({
      id: "pkg-art-1",
      kind: "package",
      identifier: "wireshark",
      expectedState: { installed: true },
    });

    const mockModel: Partial<CanonicalEnvironmentModel> = {
      packages: [
        {
          packageName: "wireshark",
          packageManager: "dpkg",
          installed: true,
          version: "4.0.0",
          evidence: "OBSERVED_FACT",
        },
      ],
    };

    const evaluated = evaluateArtifactAgainstModel(artifact, mockModel as CanonicalEnvironmentModel);
    expect(evaluated.verified).toBe(true);
    expect(evaluated.evidence).toBe("OBSERVED_FACT");
    expect(evaluated.observedState).toEqual({
      packageName: "wireshark",
      installed: true,
      version: "4.0.0",
    });
  });

  it("6. unsupported package observation is represented honestly", async () => {
    const minimalProvider: SandboxProvider = {
      capabilities: {
        id: "mock-modelled-v1",
        label: "Minimal Provider",
        description: "Minimal",
        realLinux: false,
        runtimeClass: "modelled",
        modelled: true,
        interactiveShell: false,
        streaming: false,
        resize: false,
        processes: false,
        services: false,
        environmentVariables: false,
        network: false,
        snapshots: false,
        pauseResume: false,
        packages: false,
      },
      async createEnvironment() { throw new Error("not impl"); },
      async startEnvironment() { throw new Error("not impl"); },
      async stopEnvironment() { throw new Error("not impl"); },
      async executeCommand() { throw new Error("not impl"); },
      async sendInput() { throw new Error("not impl"); },
      async resizeTerminal() { throw new Error("not impl"); },
      async getEnvironmentState(handle) {
        return {
          ok: true,
          value: {
            handle,
            status: "RUNNING",
            capabilities: this.capabilities,
            resourcePolicy: DEFAULT_RESOURCE_POLICY,
            snapshotId: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastActiveAt: new Date().toISOString(),
            expiresAt: null,
            metadata: {},
          },
        };
      },
      async getEnvironmentPersistence() { throw new Error("not impl"); },
      async getRuntimeHealth() {
        return {
          ok: true,
          value: {
            provider: "mock-modelled-v1",
            runtimeClass: "modelled",
            runtimeVersion: "1.0",
            healthy: true,
            ready: true,
            checkedAt: new Date().toISOString(),
            security: {
              networkIsolationEnforced: true,
              hostFilesystemBlocked: true,
              privilegeEscalationBlocked: true,
              metadataAccessBlocked: true,
            },
            capacity: { activeEnvironments: 0, maxEnvironments: 1 },
          },
        };
      },
      async getFilesystemState() { throw new Error("not impl"); },
      async getProcessState() { throw new Error("not impl"); },
      async getServiceState() { throw new Error("not impl"); },
      async getEnvironmentVariables() { throw new Error("not impl"); },
      async inspectEnvironment() {
        return {
          ok: true,
          value: {
            filesystem: [],
            processes: [],
            services: [],
            network: [],
            capturedAt: new Date().toISOString(),
          },
        };
      },
      async resetEnvironment() { throw new Error("not impl"); },
      async snapshotEnvironment() { throw new Error("not impl"); },
      async restoreEnvironment() { throw new Error("not impl"); },
      async pauseEnvironment() { throw new Error("not impl"); },
      async resumeEnvironment() { throw new Error("not impl"); },
      async destroyEnvironment() { throw new Error("not impl"); },
      // Note: getPackageState is deliberately omitted here
    };

    const observer = new EnvironmentObserver(minimalProvider);
    const handle: EnvironmentHandle = {
      provider: "mock-modelled-v1",
      environmentId: "env-unsupported-pkg",
      userId: "u-1",
      labId: "l-1",
    };

    const outcome = await observer.observe(handle, {
      scope: { categories: ["packages"] },
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      // Must not fabricate packages
      expect(outcome.model.packages).toHaveLength(0);
      // An explicit UNSUPPORTED_CAPABILITY error record must be captured
      const pkgError = outcome.errors.find((e) => e.category === "packages");
      expect(pkgError).toBeDefined();
      expect(pkgError?.code).toBe("UNSUPPORTED_CAPABILITY");
    }
  });
});
