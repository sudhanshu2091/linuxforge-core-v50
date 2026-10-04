import { describe, expect, it, vi } from "vitest";
import { ProductionVmSandboxProvider } from "./production-vm-provider.server";
import { PRODUCTION_DEFAULT_RESOURCE_POLICY } from "./production-resource-policy";

describe("Production VM Sandbox Provider", () => {
  const validImage = "kali-linux@sha256:" + "f".repeat(64);

  it("validates constructor parameters in production mode", () => {
    // Valid configuration
    const provider = new ProductionVmSandboxProvider({
      endpoint: "https://vm-pool.internal.linuxforge.dev:18080",
      credential: "test-credential-secret",
      imageRef: validImage,
      runtimeClass: "vm",
      production: true,
    });
    expect(provider.capabilities.realLinux).toBe(true);
    expect(provider.capabilities.runtimeClass).toBe("vm");

    // Insecure HTTP endpoint in production must throw
    expect(
      () =>
        new ProductionVmSandboxProvider({
          endpoint: "http://insecure.remote.host:18080",
          credential: "test-credential-secret",
          imageRef: validImage,
          runtimeClass: "vm",
          production: true,
        }),
    ).toThrow("Production runtime endpoint must use HTTPS");

    // Non-vm runtimeClass must throw
    expect(
      () =>
        new ProductionVmSandboxProvider({
          endpoint: "https://vm-pool.internal.linuxforge.dev:18080",
          credential: "test-credential-secret",
          imageRef: validImage,
          runtimeClass: "container-dev" as any,
          production: true,
        }),
    ).toThrow("requires 'vm' or 'microvm'");

    // Unpinned image must throw
    expect(
      () =>
        new ProductionVmSandboxProvider({
          endpoint: "https://vm-pool.internal.linuxforge.dev:18080",
          credential: "test-credential-secret",
          imageRef: "kali-linux:latest",
          runtimeClass: "vm",
          production: true,
        }),
    ).toThrow("must be pinned by SHA-256 digest");
  });

  it("dispatches createEnvironment and startEnvironment to runtime", async () => {
    const provider = new ProductionVmSandboxProvider({
      endpoint: "https://127.0.0.1:18080",
      credential: "secret",
      imageRef: validImage,
      runtimeClass: "vm",
      production: true,
    });

    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/v1/environments") {
        return new Response(
          JSON.stringify({
            ok: true,
            value: {
              handle: {
                provider: "real-linux-isolated-v1",
                environmentId: "env-prod-1",
                userId: "user-1",
                labId: "lab-1",
              },
              status: "READY",
              capabilities: provider.capabilities,
              resourcePolicy: PRODUCTION_DEFAULT_RESOURCE_POLICY,
              snapshotId: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              lastActiveAt: new Date().toISOString(),
              expiresAt: null,
              metadata: {},
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      } else if (path.includes("/start")) {
        return new Response(
          JSON.stringify({
            ok: true,
            value: {
              handle: {
                provider: "real-linux-isolated-v1",
                environmentId: "env-prod-1",
                userId: "user-1",
                labId: "lab-1",
              },
              status: "RUNNING",
              capabilities: provider.capabilities,
              resourcePolicy: PRODUCTION_DEFAULT_RESOURCE_POLICY,
              snapshotId: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              lastActiveAt: new Date().toISOString(),
              expiresAt: null,
              metadata: {},
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true, value: {} }), { status: 200 });
    });

    vi.stubGlobal("fetch", mockFetch);

    try {
      const created = await provider.createEnvironment({
        userId: "user-1",
        labId: "lab-1",
        resourcePolicy: PRODUCTION_DEFAULT_RESOURCE_POLICY,
        metadata: {},
      });

      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.value.status).toBe("READY");
      expect(created.value.handle.environmentId).toBe("env-prod-1");

      const started = await provider.startEnvironment(created.value.handle);
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      expect(started.value.status).toBe("RUNNING");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("verifies health reports mandatory isolation invariants and fails closed if missing", async () => {
    const provider = new ProductionVmSandboxProvider({
      endpoint: "https://127.0.0.1:18080",
      credential: "secret",
      imageRef: validImage,
      runtimeClass: "microvm",
      production: true,
    });

    // Mock runtime missing host filesystem blocking
    const insecureHealth = {
      provider: "real-linux-isolated-v1",
      runtimeClass: "microvm",
      runtimeVersion: "v50",
      healthy: true,
      ready: true,
      checkedAt: new Date().toISOString(),
      security: {
        networkIsolationEnforced: true,
        hostFilesystemBlocked: false, // VIOLATION!
        privilegeEscalationBlocked: true,
        metadataAccessBlocked: true,
      },
      capacity: { activeEnvironments: 1, maxEnvironments: 20 },
    };

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, value: insecureHealth }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    try {
      const health = await provider.getRuntimeHealth();
      expect(health.ok).toBe(false);
      if (!health.ok) {
        expect(health.error.code).toBe("SAFETY_POLICY_BLOCKED");
        expect(health.error.message).toContain("missing security guarantees");
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
