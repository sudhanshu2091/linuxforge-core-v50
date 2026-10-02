export type SerializableValue =
  string | number | boolean | null | { [key: string]: SerializableValue } | SerializableValue[];

export type VerificationVerdict =
  "NOT_STARTED" | "IN_PROGRESS" | "PASS" | "PARTIAL" | "FAIL" | "BLOCKED" | "INVALID";

export type CompletionMode =
  "DIRECT" | "ASSISTED" | "HEAVILY_ASSISTED" | "SOLUTION_REVEALED" | null;

export type FailureClassification =
  | "TYPO"
  | "WRONG_COMMAND"
  | "WRONG_ARGUMENT"
  | "WRONG_PATH"
  | "WRONG_FILENAME"
  | "PERMISSION_ERROR"
  | "MISSING_STEP"
  | "ORDERING_ERROR"
  | "CONCEPT_MISUNDERSTANDING"
  | "ENVIRONMENT_MISUNDERSTANDING"
  | "INCOMPLETE"
  | "SUCCESSFUL_ALTERNATIVE"
  | "UNKNOWN";

export type VerificationRequirement =
  | {
      id: string;
      kind: "filesystem";
      path: string;
      objectType?: "file" | "directory";
      exists?: boolean;
    }
  | {
      id: string;
      kind: "permissions";
      path: string;
      permissions: string;
    }
  | {
      id: string;
      kind: "ownership";
      path: string;
      owner?: string;
      group?: string;
    }
  | {
      id: string;
      kind: "content";
      path: string;
      mode: "exact" | "contains" | "regex" | "normalized";
      value: string;
    }
  | {
      id: string;
      kind: "process";
      command: string;
      state?: string;
      user?: string;
      exists?: boolean;
    }
  | {
      id: string;
      kind: "service";
      name: string;
      state?: "running" | "stopped";
      enabled?: boolean;
    }
  | {
      id: string;
      kind: "network";
      port: number;
      listening: boolean;
      process?: string;
    };

export type ExerciseContract = {
  exerciseId: string;
  questionId?: string;
  questionVariantId?: string;
  version: number;
  title?: string;
  objective: string;
  concepts: string[];
  prerequisites?: string[];
  reasoningPattern?: string;
  scenarioType?: string;
  difficulty?: number;
  constraints?: {
    requiredMethod?: string | null;
    forbiddenActions?: string[];
  };
  requirements: VerificationRequirement[];
};

export type VerificationFilesystemObject = {
  path: string;
  objectType: "file" | "directory";
  permissions: string;
  owner: string | null;
  group: string | null;
  sizeBytes: number | null;
  content: string | null;
  contentTruncated: boolean;
};

export type VerificationEvidence = {
  filesystem: VerificationFilesystemObject[];
  processes: Array<{ pid: number; command: string; state: string; user?: string }>;
  services: Array<{ name: string; state: "running" | "stopped" | "unknown"; enabled: boolean }>;
  network: Array<{ port: number; process: string }>;
  capturedAt: string;
  environmentId: string;
  environmentGeneration: number;
  runtimeId: string | null;
  runtimeLifecycleGeneration: number | null;
};

export type RequirementResult = {
  requirementId: string;
  met: boolean;
  evidence: string;
  observed: SerializableValue;
};

export type VerificationResult = {
  verdict: VerificationVerdict;
  requirements: RequirementResult[];
  score: number;
  failureClassification: FailureClassification | null;
  evidence: VerificationEvidence;
  verifierVersion: string;
  contractVersion: number;
};

export type CompletionQualityInput = {
  verdict: VerificationVerdict;
  hintsUsed: number;
  solutionRevealed: boolean;
  tutorInterventionCount?: number;
  skillDemonstrated?: boolean;
  bypassed?: boolean;
};

export type CompletionQuality = {
  mode: CompletionMode;
  independent: boolean;
  consumed: boolean;
  consumedReason: "DIRECT_COMPLETION" | "ASSISTED" | "BYPASS" | "NONE" | null;
};
