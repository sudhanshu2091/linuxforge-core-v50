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

  if (
    typeof obj["stage"] !== "string" ||
    !(HINT_STAGES as readonly string[]).includes(obj["stage"])
  ) {
    return { ok: false, error: `Invalid or missing tutor stage: ${String(obj["stage"])}` };
  }
  const stage = obj["stage"] as HintStage;

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

  if (typeof obj["intent"] !== "string" || !obj["intent"].trim()) {
    return { ok: false, error: "Diagnosis intent must be a non-empty string" };
  }
  if (typeof obj["approach"] !== "string" || !obj["approach"].trim()) {
    return { ok: false, error: "Diagnosis approach must be a non-empty string" };
  }

  const rawCat = obj["category"];
  let category: ObservationCategory | null = null;
  if (rawCat !== null && rawCat !== undefined) {
    if (typeof rawCat !== "string" || !(OBSERVATION_CATEGORIES as readonly string[]).includes(rawCat)) {
      return { ok: false, error: `Invalid observation category: ${String(rawCat)}` };
    }
    category = rawCat as ObservationCategory;
  }

  const rawUnderstanding = obj["conceptUnderstanding"];
  if (rawUnderstanding !== "unclear" && rawUnderstanding !== "partial" && rawUnderstanding !== "solid") {
    return { ok: false, error: `Invalid conceptUnderstanding: ${String(rawUnderstanding)}` };
  }
  const conceptUnderstanding = rawUnderstanding;

  if (typeof obj["skillDemonstrated"] !== "boolean") {
    return { ok: false, error: "skillDemonstrated must be a boolean" };
  }
  const skillDemonstrated = obj["skillDemonstrated"];

  if (typeof obj["coaching"] !== "string" || !obj["coaching"].trim()) {
    return { ok: false, error: "Diagnosis coaching must be a non-empty string" };
  }
  const coaching = obj["coaching"].trim().slice(0, 1000);

  const evidence = Array.isArray(obj["evidence"])
    ? obj["evidence"].filter((e): e is string => typeof e === "string").slice(0, 10)
    : [];

  return {
    ok: true,
    data: {
      intent: obj["intent"].trim().slice(0, 500),
      approach: obj["approach"].trim().slice(0, 500),
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

  if (
    typeof obj["stage"] !== "string" ||
    !(HINT_STAGES as readonly string[]).includes(obj["stage"])
  ) {
    return { ok: false, error: `Invalid or missing hint stage: ${String(obj["stage"])}` };
  }
  const stage = obj["stage"] as HintStage;

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
    return { ok: false, error: "Missing or empty mission title" };
  }
  if (typeof exerciseCandidate["objective"] !== "string" || !exerciseCandidate["objective"].trim()) {
    return { ok: false, error: "Missing or empty mission objective" };
  }

  const rawSkills = exerciseCandidate["skills"];
  if (!Array.isArray(rawSkills) || rawSkills.length === 0) {
    return { ok: false, error: "Mission skills must be a non-empty array" };
  }
  for (const s of rawSkills) {
    if (typeof s !== "string" || !(VALID_SKILL_IDS as readonly string[]).includes(s as SkillId)) {
      return { ok: false, error: `Invalid skill in mission skills: ${String(s)}` };
    }
  }
  const skills = rawSkills as SkillId[];

  const rawDifficulty = exerciseCandidate["difficulty"];
  if (
    typeof rawDifficulty !== "number" ||
    !Number.isInteger(rawDifficulty) ||
    rawDifficulty < 1 ||
    rawDifficulty > 5
  ) {
    return { ok: false, error: "Mission difficulty must be an integer between 1 and 5" };
  }
  const difficulty = rawDifficulty;

  const rawKind = exerciseCandidate["kind"];
  if (
    rawKind !== undefined &&
    rawKind !== "mission" &&
    rawKind !== "task" &&
    rawKind !== "question" &&
    rawKind !== "mock_exam"
  ) {
    return { ok: false, error: `Invalid exercise kind: ${String(rawKind)}` };
  }
  const kind = (rawKind ?? "mission") as "mission" | "task" | "question" | "mock_exam";
  const executable = kind === "mission" || kind === "task";

  const plan = exerciseCandidate["evaluationPlan"];
  if (executable) {
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
      return { ok: false, error: "Executable mission candidate requires evaluationPlan object" };
    }
    const planObj = plan as Record<string, unknown>;
    const rawObjectives = planObj["objectives"];
    if (!Array.isArray(rawObjectives) || rawObjectives.length === 0) {
      return { ok: false, error: "evaluationPlan must contain at least one objective" };
    }
    for (const o of rawObjectives) {
      if (!o || typeof o !== "object") {
        return { ok: false, error: "Malformed objective in evaluationPlan" };
      }
      const objRec = o as Record<string, unknown>;
      if (typeof objRec["label"] !== "string" || !objRec["label"].trim()) {
        return { ok: false, error: "evaluationPlan objective label must be a non-empty string" };
      }
      if (
        typeof objRec["path"] !== "string" ||
        !objRec["path"].trim() ||
        objRec["path"].startsWith("/") ||
        objRec["path"].includes("..")
      ) {
        return { ok: false, error: "evaluationPlan objective path must be a safe relative path" };
      }
      if (objRec["objectType"] !== "file" && objRec["objectType"] !== "directory") {
        return { ok: false, error: "evaluationPlan objective objectType must be 'file' or 'directory'" };
      }
    }
  }

  // Deterministic ID: use clean provided ID or derive deterministically without Date.now()
  const rawId = exerciseCandidate["id"];
  const id =
    typeof rawId === "string" && /^[a-zA-Z0-9_-]+$/.test(rawId.trim())
      ? rawId.trim()
      : `adaptive-${skills[0]}-diff${difficulty}`;

  const textList = (v: unknown, fallback: string[]): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 10) : fallback;

  const exercise: AdaptiveExercise = {
    id,
    kind,
    title: String(exerciseCandidate["title"]).trim().slice(0, 160),
    scenario: String(exerciseCandidate["scenario"] ?? "").trim().slice(0, 2000),
    objective: String(exerciseCandidate["objective"]).trim().slice(0, 1000),
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
    ...(executable && plan ? { evaluationPlan: plan as NonNullable<AdaptiveExercise["evaluationPlan"]> } : {}),
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
  if (
    typeof rawMode !== "string" ||
    !(LEARNING_MODES as readonly string[]).includes(rawMode as LearningMode)
  ) {
    return { ok: false, error: `Invalid or missing recommendedMode: ${String(rawMode)}` };
  }
  const recommendedMode = rawMode as LearningMode;

  const rawPrimary = obj["primarySkill"];
  if (
    typeof rawPrimary !== "string" ||
    !(VALID_SKILL_IDS as readonly string[]).includes(rawPrimary as SkillId)
  ) {
    return { ok: false, error: `Invalid or missing primarySkill: ${String(rawPrimary)}` };
  }
  const primarySkill = rawPrimary as SkillId;

  const rawSupporting = obj["supportingSkills"];
  if (rawSupporting !== undefined && !Array.isArray(rawSupporting)) {
    return { ok: false, error: "supportingSkills must be an array" };
  }
  const supportingSkills: SkillId[] = [];
  if (Array.isArray(rawSupporting)) {
    for (const s of rawSupporting) {
      if (typeof s !== "string" || !(VALID_SKILL_IDS as readonly string[]).includes(s as SkillId)) {
        return { ok: false, error: `Invalid supporting skill: ${String(s)}` };
      }
      if (s !== primarySkill && !supportingSkills.includes(s as SkillId)) {
        supportingSkills.push(s as SkillId);
      }
    }
  }

  const rawDifficulty = obj["difficulty"];
  if (
    typeof rawDifficulty !== "number" ||
    !Number.isInteger(rawDifficulty) ||
    rawDifficulty < 1 ||
    rawDifficulty > 5
  ) {
    return { ok: false, error: "Difficulty must be an integer between 1 and 5" };
  }
  const difficulty = rawDifficulty;

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
