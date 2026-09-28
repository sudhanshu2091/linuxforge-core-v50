/**
 * LinuxForge sandbox execution provider contract (client-safe types only).
 *
 * This module is the single canonical boundary between the *learning systems*
 * (story engine, deterministic verifier, observer, progression) and whatever
 * actually executes learner input.
 *
 * Two rules the contract exists to enforce:
 *
 * 1. Learner input is NEVER executed in the browser, in the app server, in the
 *    database, on the host, or against the host filesystem. Execution is only
 *    ever dispatched to a registered {@link SandboxProvider} adapter through an
 *    authenticated, ownership-checked server boundary.
 * 2. The provider is replaceable. The mock provider remains available for tests
 *    and local fallback, while `real-linux-isolated-v1` is the adapter for the
 *    authenticated isolated Kali runtime. Both providers must satisfy this same
 *    observation/execution contract.
 *
 * The interface deliberately does not assume `argv`: input is raw shell text or
 * stdin, and it carries cwd, streaming chunks, exit codes, durations, resize
 * semantics and state deltas so an interactive real provider can be dropped in
 * later without touching UI, story, evaluation or learner systems.
 */

/* ------------------------------------------------------------------ */
/* Provider identity                                                   */
/* ------------------------------------------------------------------ */

export const MOCK_PROVIDER_ID = "mock-modelled-v1";
export const REAL_LINUX_PROVIDER_ID = "real-linux-isolated-v1";

export type ProviderId = typeof MOCK_PROVIDER_ID | typeof REAL_LINUX_PROVIDER_ID;

export const PROVIDER_IDS: readonly ProviderId[] = [MOCK_PROVIDER_ID, REAL_LINUX_PROVIDER_ID];

export const RUNTIME_CLASSES = ["modelled", "container-dev", "vm", "microvm"] as const;
export type RuntimeClass = (typeof RUNTIME_CLASSES)[number];

export const isRuntimeClass = (value: unknown): value is RuntimeClass =>
  typeof value === "string" && (RUNTIME_CLASSES as readonly string[]).includes(value);

export const isProviderId = (value: unknown): value is ProviderId =>
  typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);

/** What the UI is allowed to tell the learner about the active provider. */
export type ProviderCapabilities = {
  id: ProviderId;
  /** Short label rendered in the terminal chrome. */
  label: string;
  /** One-line honest description of what this provider is. */
  description: string;
  /** True ONLY for a verified isolated Linux environment. Mock is always false. */
  realLinux: boolean;
  /** Runtime boundary backing this provider. */
  runtimeClass: RuntimeClass;
  /** Narrow modelled behaviour rather than an arbitrary shell. */
  modelled: boolean;
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

/* ------------------------------------------------------------------ */
/* Lifecycle + resource policy                                         */
/* ------------------------------------------------------------------ */

export const ENVIRONMENT_STATUSES = [
  "CREATING",
  "READY",
  "RUNNING",
  "PAUSED",
  "RESETTING",
  "STOPPED",
  "ERROR",
  "EXPIRED",
] as const;

export type EnvironmentStatus = (typeof ENVIRONMENT_STATUSES)[number];

export const isEnvironmentStatus = (value: unknown): value is EnvironmentStatus =>
  typeof value === "string" && (ENVIRONMENT_STATUSES as readonly string[]).includes(value);

/**
 * Guard rails a provider MUST enforce. The modelled provider does not consume
 * cpu/memory/storage, but the policy is still declared and persisted so a real
 * provider inherits identical limits without a contract change.
 */
export type ResourcePolicy = {
  /** Hard wall-clock limit for a single execution. */
  executionTimeoutMs: number;
  /** Whole-environment idle lifetime before it is expired and cleaned up. */
  idleExpiryMs: number;
  cpuMillicores: number;
  memoryMiB: number;
  storageMiB: number;
  maxProcesses: number;
  maxOpenFiles: number;
  maxOutputBytes: number;
  /** "none" means no listeners, no egress, no inbound exposure. */
  network: "none" | "egress-allowlist";
  egressAllowlist: readonly string[];
  /** Privilege escalation inside the environment is never permitted. */
  allowPrivilegeEscalation: false;
  /** The environment must never be able to reach app/db/host credentials. */
  allowHostFilesystem: false;
};

export const DEFAULT_RESOURCE_POLICY: ResourcePolicy = {
  executionTimeoutMs: 10_000,
  idleExpiryMs: 1000 * 60 * 60 * 12,
  cpuMillicores: 500,
  memoryMiB: 256,
  storageMiB: 128,
  maxProcesses: 32,
  maxOpenFiles: 256,
  maxOutputBytes: 64_000,
  network: "none",
  egressAllowlist: [],
  allowPrivilegeEscalation: false,
  allowHostFilesystem: false,
};

export type EnvironmentHandle = {
  provider: ProviderId;
  /** Provider-scoped environment reference. Never a host path or a secret. */
  environmentId: string;
  /** Owning learner. Every provider call is ownership-checked before dispatch. */
  userId: string;
  labId: string;
};

export type RuntimeHealth = {
  provider: ProviderId;
  runtimeClass: RuntimeClass;
  runtimeVersion: string;
  healthy: boolean;
  ready: boolean;
  checkedAt: string;
  /** Security controls reported by the runtime, never inferred by the AI. */
  security: {
    networkIsolationEnforced: boolean;
    hostFilesystemBlocked: boolean;
    privilegeEscalationBlocked: boolean;
    metadataAccessBlocked: boolean;
  };
  capacity: {
    activeEnvironments: number;
    maxEnvironments: number | null;
  };
};

export const ENVIRONMENT_PERSISTENCE_STATES = [
  "PROVISIONING",
  "READY",
  "ACTIVE",
  "STOPPING",
  "STOPPED",
  "FAILED",
  "QUARANTINED",
  "DESTROYING",
  "DESTROYED",
] as const;
export type EnvironmentPersistenceState = (typeof ENVIRONMENT_PERSISTENCE_STATES)[number];

export type EnvironmentPersistence = {
  state: EnvironmentPersistenceState;
  environmentGeneration: number;
  artifactVersion: number;
  artifactRef: string | null;
  integrityStatus: "UNVERIFIED" | "VERIFIED" | "FAILED";
  integrityFingerprint: string | null;
  lastPersistedAt: string | null;
  lastVerifiedAt: string | null;
  lastRestoredAt: string | null;
  destroyedAt: string | null;
};

export type EnvironmentDescriptor = {
  handle: EnvironmentHandle;
  status: EnvironmentStatus;
  capabilities: ProviderCapabilities;
  resourcePolicy: ResourcePolicy;
  snapshotId: string | null;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
  expiresAt: string | null;
  /** Redaction-safe metadata only: no tokens, secrets or connection strings. */
  metadata: Readonly<Record<string, string>>;
  /** Durable learner-environment state; distinct from ephemeral runtime state. */
  persistence?: EnvironmentPersistence;
};

/* ------------------------------------------------------------------ */
/* Observed environment state                                          */
/* ------------------------------------------------------------------ */

export type SandboxObjectType = "directory" | "file";

export type InspectionPath = {
  path: string;
  includeContent?: boolean;
};

export type InspectionFilesystemObject = {
  path: string;
  objectType: SandboxObjectType;
  permissions: string;
  owner: string | null;
  group: string | null;
  sizeBytes: number | null;
  content: string | null;
  contentTruncated: boolean;
};

export type EnvironmentInspection = {
  filesystem: InspectionFilesystemObject[];
  processes: ProcessState["processes"];
  services: ServiceState["services"];
  network: NetworkState["listeners"];
  capturedAt: string;
};

/**
 * One observed filesystem entry. This is an *observation record*, not a
 * fictional operating system: a real provider reports the same fields from a
 * genuine environment inspection.
 */
export type SandboxFsObject = {
  objectId: string;
  objectType: SandboxObjectType;
  path: string;
  name: string;
  /** Octal string, e.g. "750". */
  permissions: string;
  content: string;
  active: boolean;
  createdByChallenge: string | null;
  lastModifiedByChallenge: string | null;
  createdAt: string;
};

/** Path-keyed view of the observed filesystem. */
export type SandboxFsView = Map<string, SandboxFsObject>;

export type FilesystemState = {
  /** Home root the learner sees, e.g. "/home/learner". */
  root: string;
  cwd: string;
  objects: SandboxFsObject[];
  /** True when entries are modelled rather than read from a real kernel. */
  modelled: boolean;
};

export type FilesystemDelta = {
  kind: "created" | "modified" | "permissions" | "deleted";
  path: string;
  objectType: SandboxObjectType;
  permissions: string | null;
  contentBytes: number | null;
};

export type ProcessState = {
  supported: boolean;
  processes: { pid: number; command: string; state: string; user?: string }[];
};

export type ServiceState = {
  supported: boolean;
  services: { name: string; state: "running" | "stopped" | "unknown"; enabled: boolean }[];
};

export type NetworkState = {
  supported: boolean;
  policy: ResourcePolicy["network"];
  /** Always empty while network policy is "none". */
  listeners: { port: number; process: string }[];
};

export type PackageState = {
  supported: boolean;
  packageManager: "dpkg" | "apt" | "rpm" | "pacman" | "unknown";
  packages: Array<{
    name: string;
    version: string;
    status: string;
  }>;
};

export type EnvironmentVariablesState = {
  supported: boolean;
  /** Only non-sensitive variables are ever returned. */
  variables: Readonly<Record<string, string>>;
  /** Keys withheld by redaction policy. */
  redactedKeys: string[];
};

export type EnvironmentObservation = {
  status: EnvironmentStatus;
  filesystem: FilesystemState;
  processes: ProcessState;
  services: ServiceState;
  network: NetworkState;
  environmentVariables: EnvironmentVariablesState;
  observedAt: string;
};

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

export type ExecutionInput =
  /** Raw shell text as typed. Not argv — the provider owns parsing. */
  | { kind: "raw-shell"; data: string }
  /** Bytes written to an already-running foreground process. */
  | { kind: "stdin"; data: string }
  /** Control signal for interactive sessions (e.g. "SIGINT"). */
  | { kind: "signal"; data: string };

export const SHELLS = ["bash", "zsh", "sh"] as const;
export type ShellName = (typeof SHELLS)[number];

export const DEFAULT_SHELL: ShellName = "bash";

export type ExecutionRequest = {
  handle: EnvironmentHandle;
  /** Interactive shell selected for this terminal session. */
  shell?: ShellName;
  /** Stable terminal-tab session id. Each tab owns its own PTY/process state. */
  sessionId?: string;
  input: ExecutionInput;
  cwd: string;
  /** Optional narrative reference used only for attribution in stored events. */
  challengeRef: string | null;
  timeoutMs?: number;
};

export type StreamChunk = {
  seq: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
  atMs: number;
};

/**
 * Generic, provider-neutral description of *how* the learner worked. The
 * evaluator consumes this instead of inspecting provider internals or matching
 * exact command strings.
 */
export type MethodObservation = {
  statements: string[];
  usedLoopConstruct: boolean;
  /** Effective state-changing operations performed. */
  effectiveOperations: number;
  /** Separate command invocations the learner typed. */
  invocations: number;
};

export type ExecutionRecord = {
  /** Shell that owned this execution/session request. */
  shell: ShellName;
  provider: ProviderId;
  environmentId: string;
  /** Input after redaction policy has been applied. */
  input: string;
  inputKind: ExecutionInput["kind"];
  cwdBefore: string;
  cwdAfter: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  chunks: StreamChunk[];
  outputTruncated: boolean;
  /** Set when the provider's safety policy refused the input. */
  blocked: { reason: string } | null;
  stateBefore: EnvironmentObservation;
  stateAfter: EnvironmentObservation;
  deltas: {
    filesystem: FilesystemDelta[];
    processes: ProcessState["processes"];
    services: ServiceState["services"];
    network: NetworkState["listeners"];
  };
  method: MethodObservation;
  metadata: Readonly<Record<string, string>>;
  redactedFields: string[];
};

/* ------------------------------------------------------------------ */
/* Errors + result envelope                                            */
/* ------------------------------------------------------------------ */

export type ProviderErrorCode =
  | "PROVIDER_NOT_CONFIGURED"
  | "NOT_IMPLEMENTED"
  | "OWNERSHIP_DENIED"
  | "ENVIRONMENT_NOT_FOUND"
  | "ENVIRONMENT_NOT_READY"
  | "UNSUPPORTED_OPERATION"
  | "SAFETY_POLICY_BLOCKED"
  | "RESOURCE_LIMIT"
  | "TIMEOUT"
  | "INTERNAL";

export type ProviderError = {
  code: ProviderErrorCode;
  message: string;
  retryable: boolean;
};

export type ProviderResult<T> = { ok: true; value: T } | { ok: false; error: ProviderError };

export const providerOk = <T>(value: T): ProviderResult<T> => ({ ok: true, value });
export const providerFail = <T>(
  code: ProviderErrorCode,
  message: string,
  retryable = false,
): ProviderResult<T> => ({ ok: false, error: { code, message, retryable } });

/* ------------------------------------------------------------------ */
/* The provider interface                                              */
/* ------------------------------------------------------------------ */

export type CreateEnvironmentRequest = {
  /**
   * Optional canonical environment identity.
   *
   * Normal provisioning may omit this and let the runtime allocate an ID.
   * Recovery/reconciliation supplies the existing logical environment ID so
   * physical artifact replacement does not silently create a second logical
   * environment.
   */
  environmentId?: string;
  userId: string;
  labId: string;
  resourcePolicy: ResourcePolicy;
  metadata: Readonly<Record<string, string>>;
};
export type SnapshotRef = { snapshotId: string; createdAt: string };

/**
 * Canonical execution provider contract. Adapters implement it; the learning
 * engine only ever talks to this interface.
 */
export type SandboxProvider = {
  readonly capabilities: ProviderCapabilities;

  createEnvironment(
    request: CreateEnvironmentRequest,
  ): Promise<ProviderResult<EnvironmentDescriptor>>;
  startEnvironment(handle: EnvironmentHandle): Promise<ProviderResult<EnvironmentDescriptor>>;
  stopEnvironment(handle: EnvironmentHandle): Promise<ProviderResult<EnvironmentDescriptor>>;
  executeCommand(request: ExecutionRequest): Promise<ProviderResult<ExecutionRecord>>;
  sendInput(request: ExecutionRequest): Promise<ProviderResult<ExecutionRecord>>;
  resizeTerminal(
    handle: EnvironmentHandle,
    size: { cols: number; rows: number },
  ): Promise<ProviderResult<{ cols: number; rows: number }>>;
  getEnvironmentState(handle: EnvironmentHandle): Promise<ProviderResult<EnvironmentDescriptor>>;
  getEnvironmentPersistence(
    handle: EnvironmentHandle,
  ): Promise<ProviderResult<EnvironmentPersistence>>;
  getRuntimeHealth(): Promise<ProviderResult<RuntimeHealth>>;
  getFilesystemState(
    handle: EnvironmentHandle,
    cwd: string,
  ): Promise<ProviderResult<FilesystemState>>;
  getProcessState(handle: EnvironmentHandle): Promise<ProviderResult<ProcessState>>;
  getServiceState(handle: EnvironmentHandle): Promise<ProviderResult<ServiceState>>;
  getEnvironmentVariables(
    handle: EnvironmentHandle,
  ): Promise<ProviderResult<EnvironmentVariablesState>>;
  inspectEnvironment(
    handle: EnvironmentHandle,
    paths: InspectionPath[],
  ): Promise<ProviderResult<EnvironmentInspection>>;
  resetEnvironment(handle: EnvironmentHandle): Promise<ProviderResult<EnvironmentDescriptor>>;
  snapshotEnvironment(handle: EnvironmentHandle): Promise<ProviderResult<SnapshotRef>>;
  restoreEnvironment(
    handle: EnvironmentHandle,
    snapshotId: string,
  ): Promise<ProviderResult<EnvironmentDescriptor>>;
  pauseEnvironment(handle: EnvironmentHandle): Promise<ProviderResult<EnvironmentDescriptor>>;
  resumeEnvironment(handle: EnvironmentHandle): Promise<ProviderResult<EnvironmentDescriptor>>;
  destroyEnvironment(handle: EnvironmentHandle): Promise<ProviderResult<{ destroyed: true }>>;
  getPackageState?(
    handle: EnvironmentHandle,
    packageNames?: string[],
  ): Promise<ProviderResult<PackageState>>;
  getGuestIdentity?(handle: EnvironmentHandle): Promise<ProviderResult<{
    environmentId: string;
    expectedArtifactRelease: string;
    guestName: string;
    guestVersion: string;
    guestVersionMatchesArtifact: boolean;
    kernel: string;
    verifiedAt: string;
  }>>;
};

/** Client-safe projection the terminal UI renders for honest labelling. */
export type SandboxStatusView = {
  provider: ProviderId;
  label: string;
  description: string;
  realLinux: boolean;
  modelled: boolean;
  status: EnvironmentStatus;
  available: boolean;
  unavailableReason: string | null;
  limits: { executionTimeoutMs: number; network: ResourcePolicy["network"] };
};
