/**
 * Environment Intelligence Snapshot & Comparison / Diff Foundation.
 *
 * Implements immutable environment snapshotting and deterministic difference
 * analysis between two environment states (Snapshot A vs Snapshot B).
 */

import type {
  CanonicalEnvironmentModel,
  EnvironmentDiffResult,
  EnvironmentDifference,
  EnvironmentSnapshot,
  ObservationCategory,
  ObservationErrorRecord,
  ObservationSource,
  ObservationStatus,
} from "./types";

let snapshotCounter = 0;

export function createEnvironmentSnapshot(params: {
  environmentId: string;
  generation: number;
  model: CanonicalEnvironmentModel;
  observedCategories: ObservationCategory[];
  status?: ObservationStatus;
  errors?: ObservationErrorRecord[];
  provenance?: ObservationSource[];
  snapshotId?: string;
  capturedAt?: string;
}): EnvironmentSnapshot {
  snapshotCounter += 1;
  const snapshotId =
    params.snapshotId ??
    `snap_${Date.now()}_${snapshotCounter}_${params.environmentId.slice(-6)}`;

  const snapshot: EnvironmentSnapshot = {
    snapshotId,
    environmentId: params.environmentId,
    generation: params.generation,
    capturedAt: params.capturedAt ?? new Date().toISOString(),
    observedCategories: [...params.observedCategories],
    model: JSON.parse(JSON.stringify(params.model)) as CanonicalEnvironmentModel,
    status: params.status ?? (params.errors && params.errors.length > 0 ? "PARTIAL" : "SUCCESS"),
    errors: params.errors ? [...params.errors] : [],
    provenance: params.provenance ? [...params.provenance] : [],
  };

  return Object.freeze(snapshot);
}

export function compareSnapshots(
  before: EnvironmentSnapshot,
  after: EnvironmentSnapshot,
): EnvironmentDiffResult {
  const differences: EnvironmentDifference[] = [];

  // 1. Filesystem differences
  const beforeFs = new Map(before.model.filesystem.map((f) => [f.path, f]));
  const afterFs = new Map(after.model.filesystem.map((f) => [f.path, f]));

  for (const [path, curr] of afterFs.entries()) {
    const prev = beforeFs.get(path);
    if (!prev) {
      differences.push({
        category: "filesystem",
        kind: "added",
        identifier: path,
        detail: `File/directory created at ${path}`,
        currentValue: curr,
      });
    } else {
      if (prev.permissions !== curr.permissions) {
        differences.push({
          category: "filesystem",
          kind: "modified",
          identifier: path,
          detail: `Permissions changed on ${path}: ${prev.permissions} -> ${curr.permissions}`,
          previousValue: prev.permissions,
          currentValue: curr.permissions,
        });
      }
      if (prev.owner !== curr.owner || prev.group !== curr.group) {
        differences.push({
          category: "filesystem",
          kind: "modified",
          identifier: path,
          detail: `Ownership changed on ${path}: ${prev.owner}:${prev.group} -> ${curr.owner}:${curr.group}`,
          previousValue: { owner: prev.owner, group: prev.group },
          currentValue: { owner: curr.owner, group: curr.group },
        });
      }
      if (prev.sizeBytes !== curr.sizeBytes || prev.content !== curr.content) {
        differences.push({
          category: "filesystem",
          kind: "modified",
          identifier: path,
          detail: `Content/size modified on ${path}`,
          previousValue: { size: prev.sizeBytes },
          currentValue: { size: curr.sizeBytes },
        });
      }
    }
  }

  for (const [path, prev] of beforeFs.entries()) {
    if (!afterFs.has(path)) {
      differences.push({
        category: "filesystem",
        kind: "removed",
        identifier: path,
        detail: `File/directory deleted at ${path}`,
        previousValue: prev,
      });
    }
  }

  // 2. Process differences
  const beforePids = new Map(before.model.processes.map((p) => [p.pid, p]));
  const afterPids = new Map(after.model.processes.map((p) => [p.pid, p]));

  for (const [pid, curr] of afterPids.entries()) {
    if (!beforePids.has(pid)) {
      differences.push({
        category: "processes",
        kind: "added",
        identifier: `pid_${pid}`,
        detail: `Process started: ${curr.command} (PID ${pid})`,
        currentValue: curr,
      });
    }
  }
  for (const [pid, prev] of beforePids.entries()) {
    if (!afterPids.has(pid)) {
      differences.push({
        category: "processes",
        kind: "removed",
        identifier: `pid_${pid}`,
        detail: `Process terminated: ${prev.command} (PID ${pid})`,
        previousValue: prev,
      });
    }
  }

  // 3. Service differences
  const beforeServices = new Map(before.model.services.map((s) => [s.name, s]));
  const afterServices = new Map(after.model.services.map((s) => [s.name, s]));

  for (const [name, curr] of afterServices.entries()) {
    const prev = beforeServices.get(name);
    if (!prev) {
      differences.push({
        category: "services",
        kind: "added",
        identifier: name,
        detail: `Service ${name} now monitored (${curr.activeState})`,
        currentValue: curr,
      });
    } else if (prev.activeState !== curr.activeState || prev.enabledState !== curr.enabledState) {
      differences.push({
        category: "services",
        kind: "modified",
        identifier: name,
        detail: `Service ${name} state changed: ${prev.activeState}/${prev.enabledState} -> ${curr.activeState}/${curr.enabledState}`,
        previousValue: prev,
        currentValue: curr,
      });
    }
  }

  // 4. Packages differences
  const beforePkgs = new Map(before.model.packages.map((p) => [p.packageName, p]));
  const afterPkgs = new Map(after.model.packages.map((p) => [p.packageName, p]));

  for (const [name, curr] of afterPkgs.entries()) {
    const prev = beforePkgs.get(name);
    if (!prev && curr.installed) {
      differences.push({
        category: "packages",
        kind: "added",
        identifier: name,
        detail: `Package installed: ${name} (version ${curr.version ?? "unknown"})`,
        currentValue: curr,
      });
    } else if (prev && prev.installed !== curr.installed) {
      differences.push({
        category: "packages",
        kind: "modified",
        identifier: name,
        detail: `Package ${name} installation state changed: ${prev.installed} -> ${curr.installed}`,
        previousValue: prev,
        currentValue: curr,
      });
    }
  }

  return {
    fromSnapshotId: before.snapshotId,
    toSnapshotId: after.snapshotId,
    differences,
    hasChanges: differences.length > 0,
  };
}
