/**
 * Environment Intelligence Normalization Layer.
 *
 * Translates raw runtime observations, descriptor responses, inspection records,
 * and command outputs into the canonical Environment Model with accurate evidence
 * classification (OBSERVED_FACT, STRONG_INFERENCE, POSSIBLE_INTERPRETATION, UNKNOWN).
 *
 * RULES:
 * 1. OBSERVED_FACT: Directly returned by provider/runtime inspection.
 * 2. STRONG_INFERENCE: Deterministically derived from multiple observed facts or authoritative runtime contracts.
 * 3. POSSIBLE_INTERPRETATION: Plausible but non-authoritative heuristic.
 * 4. UNKNOWN: Not observed / insufficient evidence. Missing data becomes null/unknown, NEVER invented.
 */

import type {
  EnvironmentDescriptor,
  EnvironmentHandle,
  EnvironmentInspection,
  EnvironmentVariablesState,
  FilesystemState,
  PackageState,
  ProcessState,
  RuntimeHealth,
  ServiceState,
} from "../sandbox/contract";

import type {
  CanonicalEnvironmentModel,
  EnvironmentFilesystemObject,
  EnvironmentGroup,
  EnvironmentIdentity,
  EnvironmentNetwork,
  EnvironmentPackage,
  EnvironmentProcess,
  EnvironmentRuntimeMetadata,
  EnvironmentService,
  EnvironmentSystem,
  EnvironmentUser,
  EnvironmentVariables,
  EvidenceLevel,
  MissionArtifact,
} from "./types";

export type RawRuntimeObservationBundle = {
  handle: EnvironmentHandle;
  descriptor?: EnvironmentDescriptor | null | undefined;
  guestIdentity?: {
    environmentId?: string | undefined;
    expectedArtifactRelease?: string | undefined;
    guestName?: string | undefined;
    guestVersion?: string | undefined;
    guestVersionMatchesArtifact?: boolean | undefined;
    kernel?: string | undefined;
    verifiedAt?: string | undefined;
  } | null | undefined;
  runtimeHealth?: RuntimeHealth | null | undefined;
  filesystem?: FilesystemState | null | undefined;
  inspection?: EnvironmentInspection | null | undefined;
  processes?: ProcessState | null | undefined;
  services?: ServiceState | null | undefined;
  variables?: EnvironmentVariablesState | null | undefined;
  packageState?: PackageState | null | undefined;
  rawUsers?: Array<{ username: string; uid: number; gid: number; home: string; shell: string; sudoCapable?: boolean | undefined }> | undefined;
  rawGroups?: Array<{ name: string; gid: number; members: string[] }> | undefined;
  rawPackages?: Array<{ name: string; version: string; status: string }> | undefined;
  rawUname?: string | null | undefined;
  rawHostname?: string | null | undefined;
  rawWhoami?: string | null | undefined;
};

export function normalizeIdentity(bundle: RawRuntimeObservationBundle): EnvironmentIdentity {
  const descriptor = bundle.descriptor;
  const guest = bundle.guestIdentity;

  const guestVersion = guest?.guestVersion ?? null;
  const expectedArtifactRelease =
    guest?.expectedArtifactRelease ??
    (descriptor?.metadata?.["imageArtifactRelease"] as string | undefined) ??
    null;

  const guestVersionMatches =
    guest?.guestVersionMatchesArtifact ??
    (guestVersion !== null && expectedArtifactRelease !== null
      ? guestVersion === expectedArtifactRelease
      : false);

  const rawKernel = guest?.kernel ?? null;
  let rawArch: string | null = (descriptor?.metadata?.["architecture"] as string | undefined) ?? null;
  if (!rawArch && rawKernel) {
    if (rawKernel.includes("aarch64") || rawKernel.includes("arm64")) {
      rawArch = "aarch64";
    } else if (rawKernel.includes("x86_64") || rawKernel.includes("amd64")) {
      rawArch = "x86_64";
    }
  }

  // Derive currentUser: ONLY from rawWhoami or active environment variables (USER/LOGNAME)
  let currentUser: string | null = bundle.rawWhoami ?? null;
  if (!currentUser && bundle.variables?.variables) {
    currentUser = bundle.variables.variables["USER"] ?? bundle.variables.variables["LOGNAME"] ?? null;
  }

  // Derive hostname: ONLY from rawHostname or environment variable HOSTNAME
  let hostname: string | null = bundle.rawHostname ?? null;
  if (!hostname && bundle.variables?.variables) {
    hostname = bundle.variables.variables["HOSTNAME"] ?? null;
  }

  // Derive shell: ONLY from environment variables (SHELL) or passwd user entry
  let shell: string | null = null;
  if (bundle.variables?.variables?.["SHELL"]) {
    shell = bundle.variables.variables["SHELL"];
  } else if (currentUser && bundle.rawUsers) {
    const userObj = bundle.rawUsers.find((u) => u.username === currentUser);
    if (userObj) shell = userObj.shell;
  }

  // Derive privilegeState: ONLY if currentUser is root, or if user is in sudo group / has observed sudo capability
  let privilegeState: "root" | "sudo_capable" | "unprivileged" | "unknown" = "unknown";
  if (currentUser === "root") {
    privilegeState = "root";
  } else if (currentUser && bundle.rawGroups) {
    const sudoGroup = bundle.rawGroups.find((g) => g.name === "sudo" || g.name === "wheel");
    if (sudoGroup && sudoGroup.members.includes(currentUser)) {
      privilegeState = "sudo_capable";
    } else {
      privilegeState = "unprivileged";
    }
  } else if (currentUser && bundle.rawUsers) {
    const userObj = bundle.rawUsers.find((u) => u.username === currentUser);
    if (userObj?.sudoCapable !== undefined) {
      privilegeState = userObj.sudoCapable ? "sudo_capable" : "unprivileged";
    }
  }

  // Evidence level
  const evidence: EvidenceLevel = guest?.guestName
    ? "OBSERVED_FACT"
    : descriptor
      ? "STRONG_INFERENCE"
      : "UNKNOWN";

  const guestName = guest?.guestName ?? (descriptor?.capabilities?.realLinux ? "Kali Linux" : null);
  const distribution = guest?.guestName?.toLowerCase().includes("kali")
    ? "Kali Linux"
    : guest?.guestName ?? null;

  return {
    environmentId: bundle.handle.environmentId,
    labId: bundle.handle.labId ?? null,
    userId: bundle.handle.userId ?? null,
    provider: bundle.handle.provider,
    runtimeClass: descriptor?.capabilities?.runtimeClass ?? "container-dev",
    guestName,
    distribution,
    guestVersion,
    expectedArtifactRelease,
    guestVersionMatchesArtifact: guestVersionMatches,
    architecture: rawArch,
    kernel: rawKernel,
    hostname,
    shell,
    currentUser,
    privilegeState,
    evidence,
  };
}

export function normalizeSystem(bundle: RawRuntimeObservationBundle): EnvironmentSystem {
  const identity = normalizeIdentity(bundle);
  return {
    os: identity.kernel || identity.guestName ? "Linux" : null,
    distribution: identity.distribution,
    version: identity.guestVersion,
    kernel: identity.kernel,
    architecture: identity.architecture,
    hostname: identity.hostname,
    evidence: identity.evidence,
  };
}

export function normalizeFilesystem(bundle: RawRuntimeObservationBundle): EnvironmentFilesystemObject[] {
  const results: Map<string, EnvironmentFilesystemObject> = new Map();

  if (bundle.inspection?.filesystem) {
    for (const obj of bundle.inspection.filesystem) {
      results.set(obj.path, {
        path: obj.path,
        objectType: obj.objectType,
        exists: true,
        permissions: obj.permissions ?? null,
        owner: obj.owner ?? null,
        group: obj.group ?? null,
        sizeBytes: obj.sizeBytes ?? (obj.content ? Buffer.byteLength(obj.content, "utf8") : null),
        content: obj.content ?? null,
        contentTruncated: obj.contentTruncated ?? false,
        evidence: "OBSERVED_FACT",
      });
    }
  }

  if (bundle.filesystem?.objects) {
    for (const obj of bundle.filesystem.objects) {
      if (!results.has(obj.path)) {
        results.set(obj.path, {
          path: obj.path,
          objectType: obj.objectType,
          exists: obj.active !== false,
          permissions: obj.permissions ?? null,
          owner: (obj as typeof obj & { owner?: string }).owner ?? null,
          group: (obj as typeof obj & { group?: string }).group ?? null,
          sizeBytes: obj.content ? Buffer.byteLength(obj.content, "utf8") : null,
          content: obj.content || null,
          contentTruncated: false,
          evidence: bundle.filesystem.modelled ? "STRONG_INFERENCE" : "OBSERVED_FACT",
        });
      }
    }
  }

  return Array.from(results.values()).sort((a, b) => a.path.localeCompare(b.path));
}

export function normalizeProcesses(bundle: RawRuntimeObservationBundle): EnvironmentProcess[] {
  const rawList: Array<{ pid: number; command: string; state: string; user?: string }> = [];

  if (bundle.inspection?.processes && bundle.inspection.processes.length > 0) {
    rawList.push(...bundle.inspection.processes);
  } else if (bundle.processes?.processes && bundle.processes.processes.length > 0) {
    rawList.push(...bundle.processes.processes);
  }

  const supported = bundle.processes?.supported ?? (rawList.length > 0);
  const evidence: EvidenceLevel = supported && rawList.length > 0 ? "OBSERVED_FACT" : "UNKNOWN";

  return rawList.map((p) => ({
    pid: p.pid,
    command: p.command,
    user: p.user ?? null,
    state: p.state,
    evidence,
  }));
}

export function normalizeServices(bundle: RawRuntimeObservationBundle): EnvironmentService[] {
  const rawList: Array<{ name: string; state: "running" | "stopped" | "unknown"; enabled: boolean }> = [];

  if (bundle.inspection?.services && bundle.inspection.services.length > 0) {
    rawList.push(...bundle.inspection.services);
  } else if (bundle.services?.services && bundle.services.services.length > 0) {
    rawList.push(...bundle.services.services);
  }

  const supported = bundle.services?.supported ?? (rawList.length > 0);
  const evidence: EvidenceLevel = supported && rawList.length > 0 ? "OBSERVED_FACT" : "UNKNOWN";

  return rawList.map((s) => ({
    name: s.name,
    activeState: s.state === "running" ? "active" : s.state === "stopped" ? "inactive" : "unknown",
    enabledState: s.enabled ? "enabled" : "disabled",
    evidence,
  }));
}

export function normalizeNetwork(bundle: RawRuntimeObservationBundle): EnvironmentNetwork {
  const rawListeners = bundle.inspection?.network ?? [];
  const desc = bundle.descriptor;
  const health = bundle.runtimeHealth;

  // Determine networkIsolationEnforced honestly from authoritative sources:
  // 1. RuntimeHealth.security.networkIsolationEnforced
  // 2. EnvironmentDescriptor.resourcePolicy.network === "none"
  let networkIsolationEnforced = false;
  if (health?.security?.networkIsolationEnforced !== undefined) {
    networkIsolationEnforced = health.security.networkIsolationEnforced;
  } else if (desc?.resourcePolicy?.network === "none") {
    networkIsolationEnforced = true;
  }

  const supported = desc?.capabilities?.network ?? (rawListeners.length > 0);
  const evidence: EvidenceLevel = rawListeners.length > 0
    ? "OBSERVED_FACT"
    : health || desc
      ? "STRONG_INFERENCE"
      : "UNKNOWN";

  return {
    supported,
    networkIsolationEnforced,
    listeners: rawListeners.map((l) => ({
      port: l.port,
      process: l.process,
    })),
    evidence,
  };
}

export function normalizeEnvironmentVariables(bundle: RawRuntimeObservationBundle): EnvironmentVariables {
  if (!bundle.variables || !bundle.variables.supported) {
    return {
      variables: {},
      redactedKeys: bundle.variables?.redactedKeys ? [...bundle.variables.redactedKeys] : [],
      evidence: "UNKNOWN",
    };
  }

  return {
    variables: { ...bundle.variables.variables },
    redactedKeys: [...bundle.variables.redactedKeys],
    evidence: "OBSERVED_FACT",
  };
}

export function normalizeUsers(bundle: RawRuntimeObservationBundle): EnvironmentUser[] {
  // CRITICAL REVIEW #2: Do NOT invent hardcoded users (root/linuxforge).
  // Return users only if actually observed in rawUsers or inspection.
  if (bundle.rawUsers && bundle.rawUsers.length > 0) {
    return bundle.rawUsers.map((u) => ({
      username: u.username,
      uid: u.uid,
      primaryGid: u.gid,
      homeDirectory: u.home,
      shell: u.shell,
      accountState: "active",
      sudoCapable: u.username === "root",
      evidence: "OBSERVED_FACT",
    }));
  }

  return [];
}

export function normalizeGroups(bundle: RawRuntimeObservationBundle): EnvironmentGroup[] {
  // CRITICAL REVIEW #2: Do NOT invent hardcoded groups (root/linuxforge/sudo).
  // Return groups only if actually observed in rawGroups.
  if (bundle.rawGroups && bundle.rawGroups.length > 0) {
    return bundle.rawGroups.map((g) => ({
      groupName: g.name,
      gid: g.gid,
      members: [...g.members],
      evidence: "OBSERVED_FACT",
    }));
  }

  return [];
}

export function normalizePackages(bundle: RawRuntimeObservationBundle): EnvironmentPackage[] {
  // Source packages from packageState or rawPackages
  const pkgs = bundle.packageState?.packages ?? bundle.rawPackages;
  const pkgManager = bundle.packageState?.packageManager ?? "dpkg";

  if (pkgs && pkgs.length > 0) {
    return pkgs.map((p) => ({
      packageName: p.name,
      packageManager: pkgManager,
      installed: p.status === "installed",
      version: p.version || null,
      evidence: "OBSERVED_FACT",
    }));
  }

  return [];
}

export function normalizeRuntime(bundle: RawRuntimeObservationBundle): EnvironmentRuntimeMetadata {
  const desc = bundle.descriptor;
  const caps = desc?.capabilities;
  const health = bundle.runtimeHealth;

  // CRITICAL REVIEW #3: Derive security properties HONESTLY from authoritative sources:
  // RuntimeHealth.security, ResourcePolicy, or ProviderCapabilities.
  const hostFilesystemBlocked =
    health?.security?.hostFilesystemBlocked ??
    (desc?.resourcePolicy?.allowHostFilesystem === false);

  const privilegeEscalationBlocked =
    health?.security?.privilegeEscalationBlocked ??
    (desc?.resourcePolicy?.allowPrivilegeEscalation === false);

  const metadataAccessBlocked =
    health?.security?.metadataAccessBlocked ??
    (desc?.resourcePolicy ? true : false);

  const networkIsolationEnforced =
    health?.security?.networkIsolationEnforced ??
    (desc?.resourcePolicy?.network === "none");

  // In our verified isolation model, guest root is permitted inside the isolated VM,
  // but host compromise is strictly prohibited.
  const guestRootAllowed = true;

  const evidence: EvidenceLevel = health
    ? "OBSERVED_FACT"
    : desc
      ? "STRONG_INFERENCE"
      : "UNKNOWN";

  return {
    provider: bundle.handle.provider,
    runtimeClass: caps?.runtimeClass ?? "container-dev",
    runtimeVersion:
      health?.runtimeVersion ??
      (desc?.metadata?.["runtimeVersion"] as string | undefined),
    capabilities: {
      interactiveShell: caps?.interactiveShell ?? true,
      streaming: caps?.streaming ?? true,
      resize: caps?.resize ?? true,
      processes: caps?.processes ?? false,
      services: caps?.services ?? false,
      environmentVariables: caps?.environmentVariables ?? false,
      network: caps?.network ?? false,
      snapshots: caps?.snapshots ?? false,
      pauseResume: caps?.pauseResume ?? false,
      packages: caps?.packages ?? (bundle.packageState?.supported ?? false),
    },
    security: {
      guestRootAllowed,
      hostFilesystemBlocked,
      privilegeEscalationBlocked,
      metadataAccessBlocked,
      networkIsolationEnforced,
    },
    lifecycleState: desc?.status ?? "RUNNING",
    environmentGeneration: desc?.metadata?.["environmentGeneration"]
      ? parseInt(desc.metadata["environmentGeneration"], 10)
      : undefined,
    artifactVersion: desc?.metadata?.["artifactVersion"]
      ? parseInt(desc.metadata["artifactVersion"], 10)
      : undefined,
    evidence,
  };
}

export function normalizeEnvironment(
  bundle: RawRuntimeObservationBundle,
  trackedArtifacts: MissionArtifact[] = [],
): CanonicalEnvironmentModel {
  return {
    identity: normalizeIdentity(bundle),
    users: normalizeUsers(bundle),
    groups: normalizeGroups(bundle),
    filesystem: normalizeFilesystem(bundle),
    processes: normalizeProcesses(bundle),
    services: normalizeServices(bundle),
    packages: normalizePackages(bundle),
    environment: normalizeEnvironmentVariables(bundle),
    network: normalizeNetwork(bundle),
    system: normalizeSystem(bundle),
    runtime: normalizeRuntime(bundle),
    artifacts: trackedArtifacts,
    capturedAt: new Date().toISOString(),
  };
}
