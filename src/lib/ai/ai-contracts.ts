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

  const rawStage = obj["stage"];
  if (typeof rawStage !== "string" || !(HINT_STAGES as readonly string[]).includes(rawStage)) {
    return { ok: false, error: `Invalid or missing tutor hint stage: ${String(rawStage)}` };
  }
  const stage = rawStage as HintStage;

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
  let category: ObservationCategory | null = null;
  if (rawCat !== null && rawCat !== undefined) {
    if (typeof rawCat !== "string" || !(OBSERVATION_CATEGORIES as readonly string[]).includes(rawCat)) {
      return { ok: false, error: `Invalid diagnosis observation category: ${String(rawCat)}` };
    }
    category = rawCat as ObservationCategory;
  }

  const rawUnderstanding = obj["conceptUnderstanding"];
  if (
    rawUnderstanding !== "solid" &&
    rawUnderstanding !== "partial" &&
    rawUnderstanding !== "unclear"
  ) {
    return { ok: false, error: `Invalid conceptUnderstanding: ${String(rawUnderstanding)}; must be unclear, partial, or solid` };
  }
  const conceptUnderstanding = rawUnderstanding;

  if (typeof obj["skillDemonstrated"] !== "boolean") {
    return { ok: false, error: "Diagnosis skillDemonstrated must be a boolean" };
  }
  const skillDemonstrated = obj["skillDemonstrated"];

  if (typeof obj["intent"] !== "string" || !obj["intent"].trim()) {
    return { ok: false, error: "Diagnosis intent must be a non-empty string" };
  }
  if (typeof obj["approach"] !== "string" || !obj["approach"].trim()) {
    return { ok: false, error: "Diagnosis approach must be a non-empty string" };
  }
  if (typeof obj["coaching"] !== "string" || !obj["coaching"].trim()) {
    return { ok: false, error: "Diagnosis coaching must be a non-empty string" };
  }
  if (!Array.isArray(obj["evidence"])) {
    return { ok: false, error: "Diagnosis evidence must be an array" };
  }

  const coaching = obj["coaching"].trim().slice(0, 1000);
  const evidence = obj["evidence"].filter((e): e is string => typeof e === "string").slice(0, 10);

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

  const rawStage = obj["stage"];
  if (typeof rawStage !== "string" || !(HINT_STAGES as readonly string[]).includes(rawStage)) {
    return { ok: false, error: `Invalid or missing hint stage: ${String(rawStage)}` };
  }
  const stage = rawStage as HintStage;

  if (typeof obj["teachingNote"] !== "string") {
    return { ok: false, error: "Hint teachingNote must be a string" };
  }

  return {
    ok: true,
    data: {
      text: obj["text"].trim().slice(0, 2000),
      stage,
      teachingNote: obj["teachingNote"].slice(0, 1000),
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

  const rawSkills = exerciseCandidate["skills"];
  if (!Array.isArray(rawSkills) || rawSkills.length === 0) {
    return { ok: false, error: "Mission must target at least one skill in an array" };
  }
  for (const s of rawSkills) {
    if (typeof s !== "string" || !(VALID_SKILL_IDS as readonly string[]).includes(s)) {
      return { ok: false, error: `Invalid skill ID in mission skills: ${String(s)}` };
    }
  }
  const skills = rawSkills as SkillId[];

  const rawDiff = exerciseCandidate["difficulty"];
  if (
    typeof rawDiff !== "number" ||
    !Number.isInteger(rawDiff) ||
    rawDiff < 1 ||
    rawDiff > 5
  ) {
    return { ok: false, error: `Invalid mission difficulty: ${String(rawDiff)}; must be integer 1-5` };
  }
  const difficulty = rawDiff;

  const plan = exerciseCandidate["evaluationPlan"];
  if (!plan || typeof plan !== "object") {
    return { ok: false, error: "Executable mission candidate requires evaluationPlan" };
  }
  const planObj = plan as Record<string, unknown>;
  if (!Array.isArray(planObj["objectives"]) || planObj["objectives"].length === 0) {
    return { ok: false, error: "Mission evaluationPlan must have non-empty objectives array" };
  }
  for (let i = 0; i < planObj["objectives"].length; i++) {
    const o = planObj["objectives"][i];
    if (!o || typeof o !== "object") {
      return { ok: false, error: `Mission evaluationPlan objective[${i}] must be an object` };
    }
    const ob = o as Record<string, unknown>;
    if (typeof ob["label"] !== "string" || !ob["label"].trim()) {
      return { ok: false, error: `Mission evaluationPlan objective[${i}] missing label` };
    }
    if (typeof ob["path"] !== "string" || !ob["path"].trim()) {
      return { ok: false, error: `Mission evaluationPlan objective[${i}] missing path` };
    }
    if (ob["objectType"] !== "file" && ob["objectType"] !== "directory") {
      return { ok: false, error: `Mission evaluationPlan objective[${i}] invalid objectType: ${String(ob["objectType"])}` };
    }
  }

  // Deterministic ID: use provided id if non-empty string, else assign deterministic id from skills, difficulty, and title slug
  const titleSlug = exerciseCandidate["title"]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  const id = typeof exerciseCandidate["id"] === "string" && exerciseCandidate["id"].trim()
    ? exerciseCandidate["id"].trim()
    : `adaptive-${skills[0]}-${difficulty}-${titleSlug || "mission"}`;

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
    evaluationPlan: plan as NonNullable<AdaptiveExercise["evaluationPlan"]>,
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
  if (typeof rawMode !== "string" || !(LEARNING_MODES as readonly string[]).includes(rawMode)) {
    return { ok: false, error: `Invalid learning mode: ${String(rawMode)}` };
  }
  const recommendedMode = rawMode as LearningMode;

  const rawPrimary = obj["primarySkill"];
  if (typeof rawPrimary !== "string" || !(VALID_SKILL_IDS as readonly string[]).includes(rawPrimary)) {
    return { ok: false, error: `Invalid primary skill ID: ${String(rawPrimary)}` };
  }
  const primarySkill = rawPrimary as SkillId;

  const rawSupporting = obj["supportingSkills"];
  if (!Array.isArray(rawSupporting)) {
    return { ok: false, error: "supportingSkills must be an array" };
  }
  for (const s of rawSupporting) {
    if (typeof s !== "string" || !(VALID_SKILL_IDS as readonly string[]).includes(s)) {
      return { ok: false, error: `Invalid supporting skill ID: ${String(s)}` };
    }
  }
  const supportingSkills = (rawSupporting as SkillId[]).filter((s) => s !== primarySkill);

  const rawDiff = obj["difficulty"];
  if (
    typeof rawDiff !== "number" ||
    !Number.isInteger(rawDiff) ||
    rawDiff < 1 ||
    rawDiff > 5
  ) {
    return { ok: false, error: `Invalid difficulty: ${String(rawDiff)}; must be integer 1-5` };
  }
  const difficulty = rawDiff;

  if (typeof obj["pedagogicalRationale"] !== "string" || !obj["pedagogicalRationale"].trim()) {
    return { ok: false, error: "Missing pedagogicalRationale in adaptive reasoning response" };
  }
  const pedagogicalRationale = obj["pedagogicalRationale"].slice(0, 1000);

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
      pedagogicalRationale,
      focusMistakes,
      alternativeFraming: typeof obj["alternativeFraming"] === "string" ? obj["alternativeFraming"].slice(0, 500) : undefined,
    },
  };
}
