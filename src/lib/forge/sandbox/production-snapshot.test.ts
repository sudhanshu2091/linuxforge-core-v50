import { describe, expect, it } from "vitest";
import {
  toClientSnapshotView,
  validateSnapshotOwnership,
  type ProductionSnapshotRecord,
} from "./production-snapshot";

describe("Production Snapshot & State Boundary", () => {
  const snapshot: ProductionSnapshotRecord = {
    snapshotId: "snap-123",
    environmentId: "env-abc",
    userId: "learner-1",
    labId: "lab-core-1",
    status: "READY",
    createdAt: new Date().toISOString(),
    sizeBytes: 1024 * 1024 * 50,
    checksumSha256: "c".repeat(64),
    storageRef: "/internal/snapshots/snap-123.qcow2",
    metadata: { note: "checkpoint before nmap" },
  };

  it("validates authorized snapshot restore for owning learner", () => {
    const res = validateSnapshotOwnership(snapshot, "learner-1", "env-abc");
    expect(res.ok).toBe(true);
  });

  it("rejects unauthorized cross-learner snapshot access", () => {
    const res = validateSnapshotOwnership(snapshot, "attacker-2", "env-abc");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("OWNERSHIP_DENIED");
      expect(res.error).toContain("Learner does not own this snapshot");
    }
  });

  it("rejects restoring snapshot into wrong environment", () => {
    const res = validateSnapshotOwnership(snapshot, "learner-1", "env-other-lab");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("OWNERSHIP_DENIED");
    }
  });

  it("rejects restoring snapshot when state is not READY", () => {
    const unready = { ...snapshot, status: "CREATING" as const };
    const res = validateSnapshotOwnership(unready, "learner-1", "env-abc");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("INVALID_STATE");
    }
  });

  it("creates sanitized client view without exposing storage paths or credentials", () => {
    const clientView = toClientSnapshotView(snapshot);
    expect(clientView.snapshotId).toBe("snap-123");
    expect(clientView.environmentId).toBe("env-abc");
    expect(clientView.status).toBe("READY");
    expect((clientView as any).storageRef).toBeUndefined();
  });
});
