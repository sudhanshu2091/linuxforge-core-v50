/**
 * Canonical Environment Intelligence Model & Contracts.
 *
 * This module defines the authoritative, strongly-typed representations of
 * Linux / Kali environment state observed through deterministic provider APIs.
 *
 * Evidence semantics:
 *   OBSERVED_FACT         - Directly retrieved from the running guest/runtime
 *   STRONG_INFERENCE      - Derived deterministically from multiple observed facts
 *   POSSIBLE_INTERPRETATION - Plausible interpretation (never used for critical decisions)
 *   UNKNOWN               - Insufficient evidence / unobserved / unverified
 */

import type {
  EnvironmentStatus,
  ProviderId,
  RuntimeClass,
  SandboxObjectType,
} from "../sandbox/contract";

/* ------------------------------------------------------------------ */
/* Evidence and Provenance                                            */
/* ------------------------------------------------------------------ */

export const EVIDENCE_LEVELS = [
  "OBSERVED_FACT",
  "STRONG_INFERENCE",
  "POSSIBLE_INTERPRETATION",
  "UNKNOWN",
] as const;

export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export type ObservationSource = {
  category: ObservationCategory;
  provider: ProviderId;
  method: string;
  observedAt: string;
  endpoint?: string | undefined;
  evidence: EvidenceLevel;
};

export type ObservedValue<T> = {
  value: T;
  evidence: EvidenceLevel;
  source?: ObservationSource | undefined;
};

export const OBSERVATION_STATUSES = [
  "SUCCESS",
  "PARTIAL",
  "FAILED",
  "UNSUPPORTED",
  "UNKNOWN",
] as const;

export type ObservationStatus = (typeof OBSERVATION_STATUSES)[number];

export const OBSERVATION_CATEGORIES = [
  "identity",
  "users",
  "groups",
  "filesystem",
  "processes",
  "services",
  "packages",
  "environment",
  "network",
  "system",
  "runtime",
  "artifacts",
] as const;

export type ObservationCategory = (typeof OBSERVATION_CATEGORIES)[number];

/* ------------------------------------------------------------------ */
/* Category Models                                                    */
/* ------------------------------------------------------------------ */

export type EnvironmentIdentity = {
  environmentId: string;
  labId: string | null;
  userId: string | null;
  provider: ProviderId;
  runtimeClass: RuntimeClass;
  guestName: string | null;
  distribution: string | null;
  guestVersion: string | null;
  expectedArtifactRelease: string | null;
  guestVersionMatchesArtifact: boolean;
  architecture: string | null;
  kernel: string | null;
  hostname: string | null;
  shell: string | null;
  currentUser: string | null;
  privilegeState: "root" | "sudo_capable" | "unprivileged" | "unknown";
  evidence: EvidenceLevel;
};

export type EnvironmentUser = {
  username: string;
  uid: number | null;
  primaryGid: number | null;
  homeDirectory: string | null;
  shell: string | null;
  accountState?: "active" | "locked" | "system" | "unknown" | undefined;
  sudoCapable?: boolean | undefined;
  evidence: EvidenceLevel;
};

export type EnvironmentGroup = {
  groupName: string;
  gid: number | null;
  members: string[];
  evidence: EvidenceLevel;
};

export type EnvironmentFilesystemObject = {
  path: string;
  objectType: SandboxObjectType | "symlink" | "unknown";
  exists: boolean;
  permissions: string | null;
  owner: string | null;
  group: string | null;
  sizeBytes: number | null;
  content: string | null;
  contentTruncated: boolean;
  target?: string | null | undefined;
  evidence: EvidenceLevel;
};

export type EnvironmentProcess = {
  pid: number;
  ppid?: number | null | undefined;
  command: string;
  user?: string | null | undefined;
  state: string;
  evidence: EvidenceLevel;
};

export type EnvironmentService = {
  name: string;
  activeState: "active" | "inactive" | "failed" | "unknown";
  enabledState: "enabled" | "disabled" | "masked" | "unknown";
  statusDescription?: string | null | undefined;
  evidence: EvidenceLevel;
};

export type EnvironmentPackage = {
  packageName: string;
  packageManager: "dpkg" | "apt" | "rpm" | "pacman" | "unknown";
  installed: boolean;
  version: string | null;
  architecture?: string | null | undefined;
  evidence: EvidenceLevel;
};

export type EnvironmentVariables = {
  variables: Record<string, string>;
  redactedKeys: string[];
  evidence: EvidenceLevel;
};

export type EnvironmentNetwork = {
  supported: boolean;
  networkIsolationEnforced: boolean;
  listeners: Array<{ port: number; process: string; ip?: string }>;
  interfaces?: Array<{ name: string; ip?: string | undefined }> | undefined;
  evidence: EvidenceLevel;
};

export type EnvironmentSystem = {
  os: string | null;
  distribution: string | null;
  version: string | null;
  kernel: string | null;
  architecture: string | null;
  hostname: string | null;
  uptimeSeconds?: number | null | undefined;
  evidence: EvidenceLevel;
};

export type EnvironmentRuntimeMetadata = {
  provider: ProviderId;
  runtimeClass: RuntimeClass;
  runtimeVersion?: string | undefined;
  capabilities: {
    interactiveShell: boolean;
    streaming: boolean;
    resize: boolean;
    processes: boolean;
    services: boolean;
    environmentVariables: boolean;
    network: boolean;
    snapshots: boolean;
    pauseResume: boolean;
    packages?: boolean | undefined;
  };
  security: {
    guestRootAllowed: boolean;
    hostFilesystemBlocked: boolean;
    privilegeEscalationBlocked: boolean;
    metadataAccessBlocked: boolean;
    networkIsolationEnforced: boolean;
  };
  lifecycleState: EnvironmentStatus | string;
  environmentGeneration?: number | undefined;
  artifactVersion?: number | undefined;
  evidence: EvidenceLevel;
};

/* ------------------------------------------------------------------ */
/* Mission Artifact Tracking                                          */
/* ------------------------------------------------------------------ */

export type MissionArtifactKind =
  | "file"
  | "directory"
  | "user"
  | "group"
  | "service"
  | "package"
  | "permission"
  | "ownership";

export type MissionArtifact = {
  id: string;
  kind: MissionArtifactKind;
  identifier: string;
  expectedState?: Record<string, unknown> | undefined;
  observedState?: Record<string, unknown> | null;
  verified: boolean;
  evidence: EvidenceLevel;
};

/* ------------------------------------------------------------------ */
/* Canonical Normalized Environment Model                             */
/* ------------------------------------------------------------------ */

export type CanonicalEnvironmentModel = {
  identity: EnvironmentIdentity;
  users: EnvironmentUser[];
  groups: EnvironmentGroup[];
  filesystem: EnvironmentFilesystemObject[];
  processes: EnvironmentProcess[];
  services: EnvironmentService[];
  packages: EnvironmentPackage[];
  environment: EnvironmentVariables;
  network: EnvironmentNetwork;
  system: EnvironmentSystem;
  runtime: EnvironmentRuntimeMetadata;
  artifacts: MissionArtifact[];
  capturedAt: string;
};

/* ------------------------------------------------------------------ */
/* Environment Snapshot (Immutable)                                  */
/* ------------------------------------------------------------------ */

export type EnvironmentSnapshot = {
  snapshotId: string;
  environmentId: string;
  generation: number;
  capturedAt: string;
  observedCategories: ObservationCategory[];
  model: CanonicalEnvironmentModel;
  status: ObservationStatus;
  errors: ObservationErrorRecord[];
  provenance: ObservationSource[];
};

export type ObservationErrorRecord = {
  category: ObservationCategory;
  code:
    | "RUNTIME_UNAVAILABLE"
    | "GUEST_UNAVAILABLE"
    | "TIMEOUT"
    | "PERMISSION_DENIED"
    | "UNSUPPORTED_CAPABILITY"
    | "MALFORMED_RESPONSE"
    | "AUTHORIZATION_FAILURE"
    | "COMMAND_FAILED"
    | "NOT_FOUND";
  message: string;
  occurredAt: string;
};

/* ------------------------------------------------------------------ */
/* Observation Scope / Request                                        */
/* ------------------------------------------------------------------ */

export type FilesystemObservationTarget = {
  path: string;
  includeContent?: boolean | undefined;
};

export type ProcessObservationTarget = {
  commandFilter?: string | undefined;
  userFilter?: string | undefined;
  pid?: number | undefined;
};

export type ServiceObservationTarget = {
  serviceNames?: string[] | undefined;
};

export type PackageObservationTarget = {
  packageNames?: string[] | undefined;
};

export type TargetedObservationScope = {
  categories?: ObservationCategory[] | undefined;
  filesystemTargets?: FilesystemObservationTarget[] | undefined;
  processTargets?: ProcessObservationTarget | undefined;
  serviceTargets?: ServiceObservationTarget | undefined;
  packageTargets?: PackageObservationTarget | undefined;
  environmentVariableAllowlist?: string[] | undefined;
  trackArtifacts?: Array<Pick<MissionArtifact, "id" | "kind" | "identifier" | "expectedState">> | undefined;
};

/* ------------------------------------------------------------------ */
/* Diff Foundation                                                    */
/* ------------------------------------------------------------------ */

export type EnvironmentDifference = {
  category: ObservationCategory;
  kind: "added" | "removed" | "modified";
  identifier: string;
  detail: string;
  previousValue?: unknown;
  currentValue?: unknown;
};

export type EnvironmentDiffResult = {
  fromSnapshotId: string;
  toSnapshotId: string;
  differences: EnvironmentDifference[];
  hasChanges: boolean;
};
