/**
 * LinuxForge AI Intelligence Layer Contracts & Schema Validators.
 *
 * All AI interactions in LinuxForge depend on these strongly-typed,
 * provider-neutral contracts. No vendor SDK types leak into core logic.
 *
 * Invariant: AI proposals are NEVER authoritative.
 * Every response must pass deterministic schema validation before use.
 */

import type {
  AdaptiveExercise,
  ObservationCategory,
  SkillId,
  SkillMemoryView,
} from "@/lib/forge/types";
export type { SkillId };
import type { TrainingDecision } from "./adaptive-training";
import type { MissionBlueprint } from "./mission-generator";

/* ------------------------------------------------------------------ */
/* Canonical Constants & Enumerations                                 */
/* ------------------------------------------------------------------ */

export const OBSERVATION_CATEGORIES: readonly ObservationCategory[] = [
  "TYPO",
  "WRONG_COMMAND",
  "WRONG_ARGUMENT",
  "WRONG_PATH",
  "WRONG_FILENAME",
  "MISREAD_QUESTION",
  "CONCEPT_CONFUSION",
  "PARTIAL_UNDERSTANDING",
  "UNSAFE_APPROACH",
  "RANDOM_TRIAL_AND_ERROR",
  "SKILL_BYPASS",
  "VALID_ALTERNATIVE",
  "INDEPENDENT_SOLUTION",
] as const;

export const HINT_STAGES = [
  "CONCEPT",
  "DIRECTION",
  "COMMAND",
  "NEAR_SOLUTION",
  "SOLUTION",
] as const;

export type HintStage = (typeof HINT_STAGES)[number];

export const VALID_SKILL_IDS: readonly SkillId[] = [
  "filesystem",
  "permissions",
  "iteration",
  "shell-scripting",
  "processes",
  "networking",
  "hardening",
] as const;

export const LEARNING_MODES = [
  "REMEDIATION",
  "GUIDED_PRACTICE",
  "SPACED_REVIEW",
  "TRANSFER",
  "PROGRESSION",
  "ASSESSMENT",
] as const;

export type LearningMode = (typeof LEARNING_MODES)[number];

/* ------------------------------------------------------------------ */
/* 1. Tutor Contract                                                  */
/* ------------------------------------------------------------------ */

export type TutorRequest = {
  message: string;
  language: "English" | "Hinglish" | "Mix both";
  depth: "nudge" | "hint" | "explain" | "walkthrough";
  context?: {
    mission?: {
      title: string;
      objective: string;
      requiredSkills: string[];
      allowedApproaches?: string[] | undefined;
    } | undefined;
    progression?: { level: number } | undefined;
    skills?: Array<{ skillId: string; mastery: number }> | undefined;
    recentMistakes?: string[] | undefined;
    lastVerification?: { status: string; score: number } | null | undefined;
    lastObservation?: { category: string | null; coaching?: string | undefined } | null | undefined;
    currentHintLevel?: number | undefined;
    maxHintLevel?: number | undefined;
    allowedStage?: HintStage | undefined;
    boundedTranscript?: string[] | undefined;
  } | undefined;
};

export type TutorResponse = {
  text: string;
  stage: HintStage;
  coachingNotes?: string | undefined;
  suggestedAction?: string | undefined;
  sourceRefs?: Array<{ id: string; name: string; url: string }> | undefined;
};

/* ------------------------------------------------------------------ */
/* 2. Diagnosis Contract                                              */
/* ------------------------------------------------------------------ */

export type DiagnosisRequest = {
  contract: {
    id: string;
    title: string;
    objective: string;
    requiredSkills: string[];
    allowedApproaches?: string[] | undefined;
    bannedShortcuts?: string[] | undefined;
  };
  rawCommand: string;
  execution: {
    exitCode: number;
    lines: Array<{ kind: "output" | "error" | "system"; text: string }>;
    mutationCount: number;
    blockedReason?: string | null | undefined;
  };
  verification: {
    status: string;
    score: number;
    objectives: Array<{ label: string; met: boolean; evidence?: string | undefined }>;
  };
  history: string[];
  hintsUsed: number;
  language: "English" | "Hinglish" | "Mix both";
  learnerSkills?: Array<{ skillId: string; mastery: number }> | undefined;
};

export type DiagnosisResponse = {
  intent: string;
  approach: string;
  category: ObservationCategory | null;
  conceptUnderstanding: "unclear" | "partial" | "solid";
  skillDemonstrated: boolean;
  coaching: string;
  evidence: string[];
};

/* ------------------------------------------------------------------ */
/* 3. Hint Contract                                                   */
/* ------------------------------------------------------------------ */

export type HintRequest = {
  objective: string;
  requiredSkills: string[];
  level: number;
  totalLevels: number;
  stage: HintStage;
  baseHint: string;
  observation?: {
    category: string | null;
    conceptUnderstanding: string;
    skillDemonstrated: boolean;
  } | null | undefined;
  recentMistakes?: string[] | undefined;
  failedCommands?: number | undefined;
  learnerLevel?: number | undefined;
  language?: "English" | "Hinglish" | "Mix both" | undefined;
};

export type HintResponse = {
  text: string;
  stage: HintStage;
  teachingNote: string;
  conceptGap?: string | null | undefined;
};

/* ------------------------------------------------------------------ */
/* 4. Mission Generation Contract                                     */
/* ------------------------------------------------------------------ */

export type MissionGenerationRequest = {
  trainingDecision: TrainingDecision;
  blueprint: MissionBlueprint;
  skills: readonly SkillMemoryView[];
  recentMistakes?: readonly string[] | undefined;
  recentTopics?: readonly string[] | undefined;
  knownScenarioArtifacts?: readonly string[] | undefined;
  difficulty: number;
  environment?: import("@/lib/forge/environment/types").CanonicalEnvironmentModel | undefined;
  supportedCommandKinds?: readonly string[] | undefined;
};

export type MissionGenerationResponse = {
  exercise: AdaptiveExercise;
  pedagogicalRationale: string;
};

/* ------------------------------------------------------------------ */
/* 5. Adaptive Reasoning Contract                                     */
/* ------------------------------------------------------------------ */

export type AdaptiveReasoningRequest = {
  skills: readonly SkillMemoryView[];
  recentMistakes: readonly string[];
  currentDifficulty: number;
  lastAssessment?: {
    learningSignal: string;
    grade: number;
    mistakeBreakdown: Array<{ category: string; count: number }>;
  } | undefined;
};

export type AdaptiveReasoningResponse = {
  recommendedMode: LearningMode;
  primarySkill: SkillId;
  supportingSkills: SkillId[];
  difficulty: number;
  pedagogicalRationale: string;
  focusMistakes: string[];
  alternativeFraming?: string | undefined;
};

/* ------------------------------------------------------------------ */
/* Telemetry Contract                                                 */
/* ------------------------------------------------------------------ */

export type AiOperationName =
  | "tutor"
  | "diagnosis"
  | "hint"
  | "mission_generation"
  | "adaptive_reasoning";

export type AiTelemetryEvent = {
  id: string;
  operation: AiOperationName;
  provider: string;
  model: string;
  success: boolean;
  latencyMs: number;
  attempts: number;
  tokens?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null | undefined;
  schemaValid: boolean;
  fallbackUsed: boolean;
  error?: string | undefined;
  timestamp: string;
};

/* ------------------------------------------------------------------ */
/* Deterministic Schema Validators                                    */
/* ------------------------------------------------------------------ */

export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export function validateTutorResponse(data: unknown): ValidationResult<TutorResponse> {
  if (!data || typeof data !== "object") {
    return { ok: false, error: "Response must be a JSON object" };
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj["text"] !== "string" || !obj["text"].trim()) {
    return { ok: false, error: "Tutor response text must be a non-empty string" };
  }

  const stage = (typeof obj["stage"] === "string" && HINT_STAGES.includes(obj["stage"] as HintStage)
    ? obj["stage"]
    : "CONCEPT") as HintStage;

  return {
    ok: true,
    data: {
      text: obj["text"].trim().slice(0, 4000),
      stage,
      coachingNotes: typeof obj["coachingNotes"] === "string" ? obj["coachingNotes"].slice(0, 1000) : undefined,
      suggestedAction: typeof obj["suggestedAction"] === "string" ? obj["suggestedAction"].slice(0, 1000) : undefined,
      sourceRefs: Array.isArray(obj["sourceRefs"])
        ? obj["sourceRefs"].filter((r): r is { id: string; name: string; url: string } =>
            Boolean(r && typeof r === "object" && typeof r.id === "string" && typeof r.name === "string" && typeof r.url === "string"),
          )
        : undefined,
    },
  };
}

export function validateDiagnosisResponse(data: unknown): ValidationResult<DiagnosisResponse> {
  if (!data || typeof data !== "object") {
    return { ok: false, error: "Response must be a JSON object" };
  }
  const obj = data as Record<string, unknown>;

  const rawCat = obj["category"];
  const category =
    typeof rawCat === "string" && (OBSERVATION_CATEGORIES as readonly string[]).includes(rawCat)
      ? (rawCat as ObservationCategory)
      : null;

  const rawUnderstanding = obj["conceptUnderstanding"];
  const conceptUnderstanding =
    rawUnderstanding === "solid" || rawUnderstanding === "partial" ? rawUnderstanding : "unclear";

  const skillDemonstrated = obj["skillDemonstrated"] === true;
  const coaching = typeof obj["coaching"] === "string" && obj["coaching"].trim()
    ? obj["coaching"].trim().slice(0, 1000)
    : "Review the mission objective and try again.";

  const evidence = Array.isArray(obj["evidence"])
    ? obj["evidence"].filter((e): e is string => typeof e === "string").slice(0, 10)
    : [];

  return {
    ok: true,
    data: {
      intent: typeof obj["intent"] === "string" ? obj["intent"].slice(0, 500) : "Solve the mission",
      approach: typeof obj["approach"] === "string" ? obj["approach"].slice(0, 500) : "Interactive shell commands",
      category,
      conceptUnderstanding,
      skillDemonstrated,
      coaching,
      evidence,
    },
  };
}

export function validateHintResponse(data: unknown): ValidationResult<HintResponse> {
  if (!data || typeof data !== "object") {
    return { ok: false, error: "Response must be a JSON object" };
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj["text"] !== "string" || !obj["text"].trim()) {
    return { ok: false, error: "Hint response text must be a non-empty string" };
  }

  const stage = (typeof obj["stage"] === "string" && HINT_STAGES.includes(obj["stage"] as HintStage)
    ? obj["stage"]
    : "CONCEPT") as HintStage;

  return {
    ok: true,
    data: {
      text: obj["text"].trim().slice(0, 2000),
      stage,
      teachingNote: typeof obj["teachingNote"] === "string" ? obj["teachingNote"].slice(0, 1000) : "",
      conceptGap: typeof obj["conceptGap"] === "string" ? obj["conceptGap"].slice(0, 500) : null,
    },
  };
}

export function validateMissionGenerationResponse(data: unknown): ValidationResult<MissionGenerationResponse> {
  if (!data || typeof data !== "object") {
    return { ok: false, error: "Response must be a JSON object" };
  }
  const obj = data as Record<string, unknown>;

  // May be nested inside { exercise: ... } or flat
  const exerciseCandidate = (obj["exercise"] && typeof obj["exercise"] === "object" ? obj["exercise"] : obj) as Record<string, unknown>;

  if (typeof exerciseCandidate["title"] !== "string" || !exerciseCandidate["title"].trim()) {
    return { ok: false, error: "Missing mission title" };
  }
  if (typeof exerciseCandidate["objective"] !== "string" || !exerciseCandidate["objective"].trim()) {
    return { ok: false, error: "Missing mission objective" };
  }

  // Authoritative executable validation: Skills must be non-empty and all valid
  const rawSkills = Array.isArray(exerciseCandidate["skills"]) ? exerciseCandidate["skills"] : [];
  if (!rawSkills.length) {
    return { ok: false, error: "Mission must target at least one valid skill" };
  }
  for (const s of rawSkills) {
    if (typeof s !== "string" || !(VALID_SKILL_IDS as readonly string[]).includes(s)) {
      return { ok: false, error: `Invalid skill '${String(s)}' specified in mission` };
    }
  }
  const skills = rawSkills as SkillId[];

  // Authoritative executable validation: Difficulty must be finite integer between 1 and 5
  if (exerciseCandidate["difficulty"] !== undefined) {
    if (
      typeof exerciseCandidate["difficulty"] !== "number" ||
      !Number.isInteger(exerciseCandidate["difficulty"]) ||
      exerciseCandidate["difficulty"] < 1 ||
      exerciseCandidate["difficulty"] > 5
    ) {
      return { ok: false, error: "Mission difficulty must be an integer between 1 and 5" };
    }
  }
  const difficulty = typeof exerciseCandidate["difficulty"] === "number" ? exerciseCandidate["difficulty"] : 1;

  // Authoritative executable validation: evaluationPlan and objectives safety
  const rawPlan = exerciseCandidate["evaluationPlan"];
  if (!rawPlan || typeof rawPlan !== "object") {
    return { ok: false, error: "Executable mission candidate requires evaluationPlan" };
  }
  const plan = rawPlan as Record<string, unknown>;

  if (!Array.isArray(plan["objectives"]) || plan["objectives"].length < 1 || plan["objectives"].length > 12) {
    return { ok: false, error: "Evaluation plan requires between 1 and 12 objectives" };
  }

  const CANONICAL_CAPABILITIES = new Set([
    "interactiveShell",
    "streaming",
    "resize",
    "processes",
    "services",
    "environmentVariables",
    "network",
    "snapshots",
    "pauseResume",
    "packages",
  ]);

  if (plan["requiredCapabilities"] !== undefined) {
    if (!Array.isArray(plan["requiredCapabilities"])) {
      return { ok: false, error: "requiredCapabilities must be an array of capability strings" };
    }
    for (const cap of plan["requiredCapabilities"]) {
      if (typeof cap !== "string" || !CANONICAL_CAPABILITIES.has(cap.trim())) {
        return { ok: false, error: `Unknown or unsupported capability '${String(cap)}' in evaluation plan` };
      }
    }
  }

  if (plan["minimumMutations"] !== undefined) {
    if (
      typeof plan["minimumMutations"] !== "number" ||
      !Number.isInteger(plan["minimumMutations"]) ||
      plan["minimumMutations"] < 0
    ) {
      return { ok: false, error: "minimumMutations must be a non-negative integer" };
    }
  }

  const VALID_OBJECT_TYPES = new Set(["file", "directory", "process", "network"]);
  for (const rawObj of plan["objectives"]) {
    if (!rawObj || typeof rawObj !== "object") {
      return { ok: false, error: "Evaluation objective must be an object" };
    }
    const item = rawObj as Record<string, unknown>;
    if (typeof item["label"] !== "string" || !item["label"].trim()) {
      return { ok: false, error: "Evaluation objective requires non-empty label" };
    }
    if (typeof item["path"] !== "string" || !item["path"].trim()) {
      return { ok: false, error: "Evaluation objective requires non-empty path" };
    }
    const pathStr = item["path"].trim();
    if (pathStr.startsWith("/") || pathStr.includes("..")) {
      return { ok: false, error: `Unsafe filesystem path '${pathStr}' in objective` };
    }
    const pathParts = pathStr.split("/").filter(Boolean);
    if (pathParts.some((part) => part === "." || !/^[A-Za-z0-9._-]+$/.test(part))) {
      return { ok: false, error: `Objective path '${pathStr}' contains invalid characters` };
    }
    if (typeof item["objectType"] !== "string" || !VALID_OBJECT_TYPES.has(item["objectType"])) {
      return { ok: false, error: `Invalid objective objectType '${String(item["objectType"])}'` };
    }
    if (item["permissions"] !== undefined) {
      if (typeof item["permissions"] !== "string" || !/^\d{3}$/.test(item["permissions"])) {
        return { ok: false, error: `Permissions must be exactly three octal digits, got '${String(item["permissions"])}'` };
      }
    }
  }

  // Safe normalization for non-authoritative presentation/pedagogical fields
  const id = typeof exerciseCandidate["id"] === "string" && exerciseCandidate["id"].trim()
    ? exerciseCandidate["id"].trim()
    : `adaptive-${skills[0]}-${difficulty}`;

  const textList = (v: unknown, fallback: string[]): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 10) : fallback;

  const exercise: AdaptiveExercise = {
    id,
    kind: "mission",
    title: String(exerciseCandidate["title"]).slice(0, 160),
    scenario: String(exerciseCandidate["scenario"] ?? "").slice(0, 2000),
    objective: String(exerciseCandidate["objective"]).slice(0, 1000),
    skills,
    difficulty,
    estimatedMinutes: Math.max(5, Math.min(60, Number(exerciseCandidate["estimatedMinutes"]) || difficulty * 10)),
    sourceRefs: Array.isArray(exerciseCandidate["sourceRefs"])
      ? exerciseCandidate["sourceRefs"].filter((r): r is { id: string; name: string; url: string } =>
          Boolean(r && typeof r === "object" && typeof r.id === "string" && typeof r.name === "string" && typeof r.url === "string"),
        )
      : [{ id: "kali-training", name: "Kali Training", url: "https://kali.training/" }],
    evaluationFocus: textList(exerciseCandidate["evaluationFocus"], ["objective completion", "skill demonstration"]),
    learnerReason: typeof exerciseCandidate["learnerReason"] === "string" ? exerciseCandidate["learnerReason"].slice(0, 1200) : "Adaptive mission tailored for learner needs.",
    allowedApproaches: textList(exerciseCandidate["allowedApproaches"], ["Use supported Linux commands."]),
    bannedShortcuts: textList(exerciseCandidate["bannedShortcuts"], ["Do not attempt to access host resources."]),
    hints: textList(exerciseCandidate["hints"], ["Inspect the directory and execute the required commands."]),
    successStory: typeof exerciseCandidate["successStory"] === "string" ? exerciseCandidate["successStory"].slice(0, 500) : "Successfully completed the mission.",
    failureStory: typeof exerciseCandidate["failureStory"] === "string" ? exerciseCandidate["failureStory"].slice(0, 500) : "The mission requirements were not verified.",
    remediation: textList(exerciseCandidate["remediation"], ["Review the command syntax and try again."]),
    evaluationPlan: plan as unknown as NonNullable<AdaptiveExercise["evaluationPlan"]>,
  };

  return {
    ok: true,
    data: {
      exercise,
      pedagogicalRationale: typeof obj["pedagogicalRationale"] === "string" ? obj["pedagogicalRationale"].slice(0, 1000) : exercise.learnerReason,
    },
  };
}

export function validateAdaptiveReasoningResponse(data: unknown): ValidationResult<AdaptiveReasoningResponse> {
  if (!data || typeof data !== "object") {
    return { ok: false, error: "Response must be a JSON object" };
  }
  const obj = data as Record<string, unknown>;

  const rawMode = obj["recommendedMode"];
  const recommendedMode = (typeof rawMode === "string" && (LEARNING_MODES as readonly string[]).includes(rawMode)
    ? rawMode
    : "GUIDED_PRACTICE") as LearningMode;

  const rawPrimary = obj["primarySkill"];
  const primarySkill = (typeof rawPrimary === "string" && (VALID_SKILL_IDS as readonly string[]).includes(rawPrimary)
    ? rawPrimary
    : "filesystem") as SkillId;

  const rawSupporting = Array.isArray(obj["supportingSkills"]) ? obj["supportingSkills"] : [];
  const supportingSkills = rawSupporting.filter((s): s is SkillId =>
    typeof s === "string" && (VALID_SKILL_IDS as readonly string[]).includes(s) && s !== primarySkill,
  );

  const difficulty = typeof obj["difficulty"] === "number" && Number.isFinite(obj["difficulty"])
    ? Math.max(1, Math.min(5, Math.floor(obj["difficulty"])))
    : 1;

  const focusMistakes = Array.isArray(obj["focusMistakes"])
    ? obj["focusMistakes"].filter((m): m is string => typeof m === "string").slice(0, 10)
    : [];

  return {
    ok: true,
    data: {
      recommendedMode,
      primarySkill,
      supportingSkills,
      difficulty,
      pedagogicalRationale: typeof obj["pedagogicalRationale"] === "string" ? obj["pedagogicalRationale"].slice(0, 1000) : "Adaptive selection based on learner mastery and mistake history.",
      focusMistakes,
      alternativeFraming: typeof obj["alternativeFraming"] === "string" ? obj["alternativeFraming"].slice(0, 500) : undefined,
    },
  };
}
