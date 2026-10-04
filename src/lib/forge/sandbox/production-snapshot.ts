/**
 * LinuxForge Production Snapshot & State Boundary.
 *
 * Implements provider-neutral environment state and snapshot management.
 * Invariant: Snapshots must NEVER cross learner ownership boundaries.
 */

export type SnapshotStatus = "CREATING" | "READY" | "RESTORING" | "FAILED" | "PURGED";

export type ProductionSnapshotRecord = {
  snapshotId: string;
  environmentId: string;
  userId: string;
  labId: string;
  status: SnapshotStatus;
  createdAt: string;
  sizeBytes: number | null;
  checksumSha256: string | null;
  storageRef: string;
  metadata: Readonly<Record<string, string>>;
};

export type SnapshotAuthResult =
  | { ok: true }
  | { ok: false; error: string; code: "OWNERSHIP_DENIED" | "INVALID_STATE" | "NOT_FOUND" };

/**
 * Validates that a requested snapshot operation belongs to the authenticated learner
 * and that the environment identity matches.
 */
export function validateSnapshotOwnership(
  snapshot: Pick<ProductionSnapshotRecord, "userId" | "environmentId" | "labId" | "status">,
  requesterUserId: string,
  targetEnvironmentId: string,
): SnapshotAuthResult {
  if (snapshot.userId !== requesterUserId) {
    return {
      ok: false,
      error: "Learner does not own this snapshot.",
      code: "OWNERSHIP_DENIED",
    };
  }

  if (snapshot.environmentId !== targetEnvironmentId) {
    return {
      ok: false,
      error: "Snapshot does not belong to the target environment.",
      code: "OWNERSHIP_DENIED",
    };
  }

  if (snapshot.status !== "READY") {
    return {
      ok: false,
      error: `Snapshot is in state '${snapshot.status}', cannot be restored.`,
      code: "INVALID_STATE",
    };
  }

  return { ok: true };
}

/**
 * Safe client-facing view of a snapshot record.
 * Never exposes raw backend storage paths, credentials, or host filesystem details.
 */
export type ClientSnapshotView = {
  snapshotId: string;
  environmentId: string;
  createdAt: string;
  status: SnapshotStatus;
  sizeBytes: number | null;
};

export function toClientSnapshotView(snapshot: ProductionSnapshotRecord): ClientSnapshotView {
  return {
    snapshotId: snapshot.snapshotId,
    environmentId: snapshot.environmentId,
    createdAt: snapshot.createdAt,
    status: snapshot.status,
    sizeBytes: snapshot.sizeBytes,
  };
}
