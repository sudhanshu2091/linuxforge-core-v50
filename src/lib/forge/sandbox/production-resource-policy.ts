/**
 * LinuxForge Production Resource Policy & Boundary Enforcement.
 *
 * Enforces strict bounds on CPU, memory, storage, process count, file count,
 * output size, session concurrency, idle timeout, and lifetime.
 * Arbitrary learner or client-supplied resource values are rejected server-side.
 */

import type { ResourcePolicy } from "./contract";

export type ProductionResourceLimits = {
  cpuMillicores: { min: number; max: number; default: number };
  memoryMiB: { min: number; max: number; default: number };
  storageMiB: { min: number; max: number; default: number };
  maxProcesses: { min: number; max: number; default: number };
  maxOpenFiles: { min: number; max: number; default: number };
  maxOutputBytes: { min: number; max: number; default: number };
  executionTimeoutMs: { min: number; max: number; default: number };
  idleExpiryMs: { min: number; max: number; default: number };
  maxConcurrentSessions: { min: number; max: number; default: number };
  maxLifetimeMs: { min: number; max: number; default: number };
};

export const PRODUCTION_RESOURCE_LIMITS: ProductionResourceLimits = {
  cpuMillicores: { min: 250, max: 4000, default: 1000 },
  memoryMiB: { min: 256, max: 8192, default: 2048 },
  storageMiB: { min: 512, max: 40960, default: 20480 },
  maxProcesses: { min: 16, max: 1024, default: 256 },
  maxOpenFiles: { min: 64, max: 8192, default: 2048 },
  maxOutputBytes: { min: 1024, max: 524288, default: 64000 },
  executionTimeoutMs: { min: 1000, max: 60000, default: 15000 },
  idleExpiryMs: { min: 60000, max: 86400000, default: 3600000 },
  maxConcurrentSessions: { min: 1, max: 5, default: 2 },
  maxLifetimeMs: { min: 300000, max: 604800000, default: 43200000 },
};

export const PRODUCTION_DEFAULT_RESOURCE_POLICY: ResourcePolicy = {
  cpuMillicores: PRODUCTION_RESOURCE_LIMITS.cpuMillicores.default,
  memoryMiB: PRODUCTION_RESOURCE_LIMITS.memoryMiB.default,
  storageMiB: PRODUCTION_RESOURCE_LIMITS.storageMiB.default,
  maxProcesses: PRODUCTION_RESOURCE_LIMITS.maxProcesses.default,
  maxOpenFiles: PRODUCTION_RESOURCE_LIMITS.maxOpenFiles.default,
  maxOutputBytes: PRODUCTION_RESOURCE_LIMITS.maxOutputBytes.default,
  executionTimeoutMs: PRODUCTION_RESOURCE_LIMITS.executionTimeoutMs.default,
  idleExpiryMs: PRODUCTION_RESOURCE_LIMITS.idleExpiryMs.default,
  network: "none",
  egressAllowlist: [],
  allowPrivilegeEscalation: false,
  allowHostFilesystem: false,
};

export type ResourceValidationResult =
  { ok: true; policy: ResourcePolicy } | { ok: false; error: string; field?: keyof ResourcePolicy };

/**
 * Validates requested resource parameters against production safety boundaries.
 * Fails closed on any out-of-bounds or non-finite value.
 */
export function validateProductionResourcePolicy(
  requested?: Partial<ResourcePolicy> | null,
): ResourceValidationResult {
  if (!requested) {
    return { ok: true, policy: { ...PRODUCTION_DEFAULT_RESOURCE_POLICY } };
  }

  // Privilege escalation and host filesystem access are NEVER allowed in production
  if ((requested as any).allowPrivilegeEscalation === true) {
    return {
      ok: false,
      error: "Privilege escalation to host is prohibited in production.",
      field: "allowPrivilegeEscalation",
    };
  }
  if ((requested as any).allowHostFilesystem === true) {
    return {
      ok: false,
      error: "Host filesystem access is prohibited in production.",
      field: "allowHostFilesystem",
    };
  }

  function validateField(
    key: keyof typeof PRODUCTION_RESOURCE_LIMITS,
    val: number | undefined,
  ): number | string {
    const limits = PRODUCTION_RESOURCE_LIMITS[key];
    if (val === undefined) return limits.default;
    if (!Number.isFinite(val) || !Number.isInteger(val)) {
      return `${String(key)} must be a finite integer.`;
    }
    if (val < limits.min || val > limits.max) {
      return `${String(key)} must be between ${limits.min} and ${limits.max} (received ${val}).`;
    }
    return val;
  }

  const cpu = validateField("cpuMillicores", requested.cpuMillicores);
  if (typeof cpu === "string") return { ok: false, error: cpu, field: "cpuMillicores" };

  const mem = validateField("memoryMiB", requested.memoryMiB);
  if (typeof mem === "string") return { ok: false, error: mem, field: "memoryMiB" };

  const storage = validateField("storageMiB", requested.storageMiB);
  if (typeof storage === "string") return { ok: false, error: storage, field: "storageMiB" };

  const procs = validateField("maxProcesses", requested.maxProcesses);
  if (typeof procs === "string") return { ok: false, error: procs, field: "maxProcesses" };

  const files = validateField("maxOpenFiles", requested.maxOpenFiles);
  if (typeof files === "string") return { ok: false, error: files, field: "maxOpenFiles" };

  const output = validateField("maxOutputBytes", requested.maxOutputBytes);
  if (typeof output === "string") return { ok: false, error: output, field: "maxOutputBytes" };

  const timeout = validateField("executionTimeoutMs", requested.executionTimeoutMs);
  if (typeof timeout === "string")
    return { ok: false, error: timeout, field: "executionTimeoutMs" };

  const idle = validateField("idleExpiryMs", requested.idleExpiryMs);
  if (typeof idle === "string") return { ok: false, error: idle, field: "idleExpiryMs" };

  const network = requested.network ?? "none";
  if (network !== "none" && network !== "egress-allowlist") {
    return { ok: false, error: "Invalid network policy mode in production.", field: "network" };
  }

  const egressAllowlist = (requested.egressAllowlist ?? []).map((entry) => String(entry).trim());
  for (const entry of egressAllowlist) {
    if (!entry || entry.length > 256 || !/^[a-zA-Z0-9_\-\.:]+$/.test(entry)) {
      return {
        ok: false,
        error: `Invalid egress allowlist entry: '${entry}'`,
        field: "egressAllowlist",
      };
    }
  }

  const policy: ResourcePolicy = {
    cpuMillicores: cpu,
    memoryMiB: mem,
    storageMiB: storage,
    maxProcesses: procs,
    maxOpenFiles: files,
    maxOutputBytes: output,
    executionTimeoutMs: timeout,
    idleExpiryMs: idle,
    network,
    egressAllowlist,
    allowPrivilegeEscalation: false,
    allowHostFilesystem: false,
  };

  return { ok: true, policy };
}
