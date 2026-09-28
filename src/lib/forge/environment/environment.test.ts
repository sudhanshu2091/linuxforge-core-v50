import { describe, expect, it } from "vitest";
import {
  normalizeEnvironment,
  normalizeIdentity,
  normalizeUsers,
  normalizeGroups,
  normalizePackages,
  normalizeNetwork,
  normalizeRuntime,
  type RawRuntimeObservationBundle,
} from "./normalization";
import { createEnvironmentSnapshot, compareSnapshots } from "./snapshots";
import { createMissionArtifact, evaluateArtifactAgainstModel } from "./artifacts";
import type { EnvironmentHandle, RuntimeHealth } from "../sandbox/contract";

const mockHandle: EnvironmentHandle = {
  provider: "real-linux-isolated-v1",
  environmentId: "env-test-kali-001",
  userId: "user-123",
  labId: "lab-kali-basic",
};

describe("Environment Intelligence - Normalization & Evidence Semantics", () => {
  it("normalizes guest identity with version mismatch accurately preserved", () => {
    const bundle: RawRuntimeObservationBundle = {
      handle: mockHandle,
      guestIdentity: {
        environmentId: "env-test-kali-001",
        expectedArtifactRelease: "2026.2",
        guestName: "Kali GNU/Linux Rolling",
        guestVersion: "2026.1",
        guestVersionMatchesArtifact: false,
        kernel: "Linux kali 6.18.12+kali-cloud-arm64",
        verifiedAt: "2026-09-28T10:00:00Z",
      },
      variables: {
        supported: true,
        variables: { USER: "linuxforge", SHELL: "/bin/bash", HOSTNAME: "kali" },
        redactedKeys: [],
      },
    };

    const identity = normalizeIdentity(bundle);
    expect(identity.guestVersion).toBe("2026.1");
    expect(identity.expectedArtifactRelease).toBe("2026.2");
    expect(identity.guestVersionMatchesArtifact).toBe(false);
    expect(identity.kernel).toContain("6.18.12");
    expect(identity.architecture).toBe("aarch64");
    expect(identity.evidence).toBe("OBSERVED_FACT");
    expect(identity.currentUser).toBe("linuxforge");
    expect(identity.hostname).toBe("kali");
    expect(identity.shell).toBe("/bin/bash");
  });

  it("removes unsupported hardcoded facts: missing values become null or unknown", () => {
    // When no user, hostname, shell, or groups are observed, do NOT invent them
    const emptyBundle: RawRuntimeObservationBundle = { handle: mockHandle };

    const identity = normalizeIdentity(emptyBundle);
    expect(identity.currentUser).toBeNull();
    expect(identity.hostname).toBeNull();
    expect(identity.shell).toBeNull();
    expect(identity.privilegeState).toBe("unknown");

    const users = normalizeUsers(emptyBundle);
    expect(users).toHaveLength(0); // MUST NOT invent root/linuxforge

    const groups = normalizeGroups(emptyBundle);
    expect(groups).toHaveLength(0); // MUST NOT invent root/linuxforge/sudo

    const pkgs = normalizePackages(emptyBundle);
    expect(pkgs).toHaveLength(0);
  });

  it("normalizes security metadata honestly from authoritative sources", () => {
    const health: RuntimeHealth = {
      provider: "real-linux-isolated-v1",
      runtimeClass: "vm",
      runtimeVersion: "50.0.0",
      healthy: true,
      ready: true,
      checkedAt: "2026-09-28T10:00:00Z",
      security: {
        networkIsolationEnforced: true,
        hostFilesystemBlocked: true,
        privilegeEscalationBlocked: true,
        metadataAccessBlocked: true,
      },
      capacity: {
        activeEnvironments: 1,
        maxEnvironments: 4,
      },
    };

    const bundle: RawRuntimeObservationBundle = {
      handle: mockHandle,
      runtimeHealth: health,
    };

    const runtime = normalizeRuntime(bundle);
    expect(runtime.evidence).toBe("OBSERVED_FACT");
    expect(runtime.security.networkIsolationEnforced).toBe(true);
    expect(runtime.security.hostFilesystemBlocked).toBe(true);
    expect(runtime.security.privilegeEscalationBlocked).toBe(true);
    expect(runtime.security.metadataAccessBlocked).toBe(true);

    const net = normalizeNetwork(bundle);
    expect(net.networkIsolationEnforced).toBe(true);
  });

  it("distinguishes OBSERVED_FACT from UNKNOWN and STRONG_INFERENCE", () => {
    const emptyBundle: RawRuntimeObservationBundle = { handle: mockHandle };
    const emptyModel = normalizeEnvironment(emptyBundle);

    expect(emptyModel.identity.evidence).toBe("UNKNOWN");
    expect(emptyModel.processes).toHaveLength(0);
    expect(emptyModel.environment.evidence).toBe("UNKNOWN");

    const observedBundle: RawRuntimeObservationBundle = {
      handle: mockHandle,
      inspection: {
        filesystem: [
          {
            path: "/home/linuxforge/project",
            objectType: "file",
            permissions: "644",
            owner: "linuxforge",
            group: "linuxforge",
            sizeBytes: 128,
            content: "echo hello",
            contentTruncated: false,
          },
        ],
        processes: [
          { pid: 1, command: "systemd", state: "S", user: "root" },
          { pid: 105, command: "sshd", state: "S", user: "root" },
        ],
        services: [
          { name: "ssh.service", state: "running", enabled: true },
        ],
        network: [{ port: 22, process: "sshd" }],
        capturedAt: "2026-09-28T10:05:00Z",
      },
      variables: {
        supported: true,
        variables: { SHELL: "/bin/bash", USER: "linuxforge" },
        redactedKeys: ["SSH_AUTH_SOCK", "FORGE_SECRET"],
      },
      packageState: {
        supported: true,
        packageManager: "dpkg",
        packages: [
          { name: "bash", version: "5.2.15-2+b7", status: "installed" },
          { name: "coreutils", version: "9.1-1", status: "installed" },
        ],
      },
    };

    const model = normalizeEnvironment(observedBundle);
    const firstFs = model.filesystem[0];
    expect(firstFs).toBeDefined();
    if (firstFs) {
      expect(firstFs.evidence).toBe("OBSERVED_FACT");
      expect(firstFs.permissions).toBe("644");
    }

    const firstProc = model.processes[0];
    expect(firstProc).toBeDefined();
    if (firstProc) {
      expect(firstProc.evidence).toBe("OBSERVED_FACT");
    }

    const firstSvc = model.services[0];
    expect(firstSvc).toBeDefined();
    if (firstSvc) {
      expect(firstSvc.evidence).toBe("OBSERVED_FACT");
      expect(firstSvc.activeState).toBe("active");
    }

    expect(model.environment.evidence).toBe("OBSERVED_FACT");
    expect(model.environment.variables["USER"]).toBe("linuxforge");
    expect(model.environment.redactedKeys).toContain("FORGE_SECRET");

    expect(model.packages).toHaveLength(2);
    expect(model.packages[0]?.packageName).toBe("bash");
    expect(model.packages[0]?.installed).toBe(true);
    expect(model.packages[0]?.evidence).toBe("OBSERVED_FACT");
  });

  it("creates immutable snapshots that cannot be mutated in place", () => {
    const bundle: RawRuntimeObservationBundle = {
      handle: mockHandle,
      inspection: {
        filesystem: [
          {
            path: "/tmp/flag.txt",
            objectType: "file",
            permissions: "700",
            owner: "root",
            group: "root",
            sizeBytes: 32,
            content: "flag{test}",
            contentTruncated: false,
          },
        ],
        processes: [],
        services: [],
        network: [],
        capturedAt: "2026-09-28T10:00:00Z",
      },
    };

    const model = normalizeEnvironment(bundle);
    const snapshot = createEnvironmentSnapshot({
      environmentId: mockHandle.environmentId,
      generation: 1,
      model,
      observedCategories: ["filesystem"],
    });

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => {
      (snapshot as any).generation = 2;
    }).toThrow();
  });

  it("calculates diffs between two environment snapshots accurately", () => {
    const bundleA: RawRuntimeObservationBundle = {
      handle: mockHandle,
      inspection: {
        filesystem: [
          {
            path: "/home/linuxforge/target",
            objectType: "file",
            permissions: "644",
            owner: "linuxforge",
            group: "linuxforge",
            sizeBytes: 10,
            content: "old",
            contentTruncated: false,
          },
        ],
        processes: [{ pid: 10, command: "sleep", state: "S" }],
        services: [{ name: "ssh.service", state: "stopped", enabled: false }],
        network: [],
        capturedAt: "2026-09-28T10:00:00Z",
      },
      packageState: {
        supported: true,
        packageManager: "dpkg",
        packages: [{ name: "curl", version: "7.88", status: "not-installed" }],
      },
    };

    const bundleB: RawRuntimeObservationBundle = {
      handle: mockHandle,
      inspection: {
        filesystem: [
          {
            path: "/home/linuxforge/target",
            objectType: "file",
            permissions: "755",
            owner: "root",
            group: "root",
            sizeBytes: 10,
            content: "old",
            contentTruncated: false,
          },
          {
            path: "/home/linuxforge/new_file.txt",
            objectType: "file",
            permissions: "600",
            owner: "linuxforge",
            group: "linuxforge",
            sizeBytes: 20,
            content: "new",
            contentTruncated: false,
          },
        ],
        processes: [{ pid: 20, command: "bash", state: "S" }],
        services: [{ name: "ssh.service", state: "running", enabled: true }],
        network: [],
        capturedAt: "2026-09-28T10:05:00Z",
      },
      packageState: {
        supported: true,
        packageManager: "dpkg",
        packages: [{ name: "curl", version: "7.88", status: "installed" }],
      },
    };

    const snapA = createEnvironmentSnapshot({
      environmentId: mockHandle.environmentId,
      generation: 1,
      model: normalizeEnvironment(bundleA),
      observedCategories: ["filesystem", "processes", "services", "packages"],
    });

    const snapB = createEnvironmentSnapshot({
      environmentId: mockHandle.environmentId,
      generation: 2,
      model: normalizeEnvironment(bundleB),
      observedCategories: ["filesystem", "processes", "services", "packages"],
    });

    const diff = compareSnapshots(snapA, snapB);
    expect(diff.hasChanges).toBe(true);

    const permChange = diff.differences.find(
      (d) => d.identifier === "/home/linuxforge/target" && d.detail.includes("Permissions changed"),
    );
    expect(permChange).toBeDefined();

    const ownerChange = diff.differences.find(
      (d) => d.identifier === "/home/linuxforge/target" && d.detail.includes("Ownership changed"),
    );
    expect(ownerChange).toBeDefined();

    const fileAdd = diff.differences.find(
      (d) => d.identifier === "/home/linuxforge/new_file.txt" && d.kind === "added",
    );
    expect(fileAdd).toBeDefined();

    const procStopped = diff.differences.find(
      (d) => d.identifier === "pid_10" && d.kind === "removed",
    );
    expect(procStopped).toBeDefined();

    const svcStarted = diff.differences.find(
      (d) => d.identifier === "ssh.service" && d.kind === "modified",
    );
    expect(svcStarted).toBeDefined();

    const pkgInstalled = diff.differences.find(
      (d) => d.identifier === "curl" && d.category === "packages",
    );
    expect(pkgInstalled).toBeDefined();
  });

  it("evaluates mission artifacts against environment model", () => {
    const artifact = createMissionArtifact({
      id: "art-1",
      kind: "file",
      identifier: "/home/linuxforge/exploit.py",
      expectedState: { permissions: "755", owner: "linuxforge" },
    });

    const pkgArtifact = createMissionArtifact({
      id: "art-2",
      kind: "package",
      identifier: "nmap",
      expectedState: { installed: true },
    });

    const bundle: RawRuntimeObservationBundle = {
      handle: mockHandle,
      inspection: {
        filesystem: [
          {
            path: "/home/linuxforge/exploit.py",
            objectType: "file",
            permissions: "755",
            owner: "linuxforge",
            group: "linuxforge",
            sizeBytes: 256,
            content: "print('pwn')",
            contentTruncated: false,
          },
        ],
        processes: [],
        services: [],
        network: [],
        capturedAt: "2026-09-28T10:10:00Z",
      },
      packageState: {
        supported: true,
        packageManager: "dpkg",
        packages: [{ name: "nmap", version: "7.93", status: "installed" }],
      },
    };

    const model = normalizeEnvironment(bundle);
    const evaluatedFile = evaluateArtifactAgainstModel(artifact, model);
    expect(evaluatedFile.verified).toBe(true);
    expect(evaluatedFile.evidence).toBe("OBSERVED_FACT");

    const evaluatedPkg = evaluateArtifactAgainstModel(pkgArtifact, model);
    expect(evaluatedPkg.verified).toBe(true);
    expect(evaluatedPkg.evidence).toBe("OBSERVED_FACT");
  });
});
