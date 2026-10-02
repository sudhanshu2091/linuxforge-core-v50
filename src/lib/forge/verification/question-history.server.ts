import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { buildSemanticFingerprint } from "./semantic-identity";
import type { GeneratedDefinition } from "../generated-contract.server";
import type { CompletionMode, ExerciseContract, VerificationRequirement } from "./types";

type Db = SupabaseClient<Database>;

export type QuestionLifecycleStatus =
  | "UNSEEN"
  | "RETIRED"
  | "ELIGIBLE_REVIEW"
  | "FAILED"
  | "PARTIAL_ASSISTED"
  | "IN_PROGRESS";

export type QuestionLifecycleRecord = {
  questionId: string;
  questionVariantId?: string | null;
  semanticFingerprint: string;
  status: QuestionLifecycleStatus;
  attemptsCount: number;
  hasIndependentSuccess: boolean;
  hasAssistedSuccess: boolean;
  hasFailures: boolean;
  lastAttemptAt: string | null;
  lastVerdict: string | null;
  lastCompletionMode: CompletionMode;
  totalHintsUsed: number;
  solutionRevealed: boolean;
  isRetired: boolean;
  isEligibleAgain: boolean;
  eligibilityReason: string;
};

export type QuestionEligibilityResult = {
  eligible: boolean;
  lifecycleStatus: QuestionLifecycleStatus;
  reason: string;
  isExactRetired: boolean;
  isSemanticDuplicate: boolean;
  attemptsCount: number;
};

export function generatedDefinitionToExerciseContract(
  definition: GeneratedDefinition,
): ExerciseContract {
  const requirements: VerificationRequirement[] = [];

  for (const [index, objective] of definition.evaluationPlan.objectives.entries()) {
    const id = `objective-${index + 1}`;
    if (objective.objectType === "process") {
      requirements.push({
        id,
        kind: "process",
        command: objective.path === "processes" ? "ps" : objective.path,
        exists: !objective.mustNotExist,
      });
    } else if (objective.objectType === "network") {
      requirements.push({
        id,
        kind: "network",
        port: 0,
        listening: true,
      });
    } else {
      const objType = objective.objectType === "directory" ? "directory" : "file";
      requirements.push({
        id,
        kind: "filesystem",
        path: objective.path,
        objectType: objType,
        exists: !objective.mustNotExist,
      });
      if (objective.permissions) {
        requirements.push({
          id: `${id}-permissions`,
          kind: "permissions",
          path: objective.path,
          permissions: objective.permissions,
        });
      }
      if (objective.contentEquals !== undefined) {
        requirements.push({
          id: `${id}-content`,
          kind: "content",
          path: objective.path,
          mode: "exact",
          value: objective.contentEquals,
        });
      }
      if (objective.contentContains !== undefined) {
        requirements.push({
          id: `${id}-content-contains`,
          kind: "content",
          path: objective.path,
          mode: "contains",
          value: objective.contentContains,
        });
      }
    }
  }

  return {
    exerciseId: definition.id,
    questionId: definition.id,
    questionVariantId: definition.id,
    version: 1,
    title: definition.title,
    objective: definition.objective,
    concepts: definition.skills,
    difficulty: definition.difficulty,
    constraints: {
      requiredMethod: definition.evaluationPlan.requiredCommandKinds?.join(",") || null,
      forbiddenActions: definition.bannedShortcuts,
    },
    scenarioType: definition.kind,
    reasoningPattern: definition.evaluationFocus.join(","),
    requirements,
  };
}

/**
 * Retrieves the complete lifecycle record for a question or contract.
 * Preserves all historical attempts while determining current retirement/eligibility.
 */
export async function getQuestionLifecycleRecord(input: {
  db: Db;
  userId: string;
  questionId?: string;
  contract?: ExerciseContract;
  semanticFingerprint?: string;
}): Promise<QuestionLifecycleRecord> {
  const questionId =
    input.questionId ?? input.contract?.questionId ?? input.contract?.exerciseId ?? "";
  const fingerprint =
    input.semanticFingerprint ??
    (input.contract ? buildSemanticFingerprint(input.contract) : "");

  let query = input.db
    .from("lab_exercise_attempts")
    .select(
      "attempt_id, question_id, question_variant_id, semantic_fingerprint, completion_mode, consumed, hints_used, solution_revealed, verdict, created_at",
    )
    .eq("user_id", input.userId);

  if (questionId && fingerprint) {
    query = query.or(`question_id.eq.${questionId},semantic_fingerprint.eq.${fingerprint}`);
  } else if (questionId) {
    query = query.eq("question_id", questionId);
  } else if (fingerprint) {
    query = query.eq("semantic_fingerprint", fingerprint);
  }

  const { data: attempts, error } = await query.order("created_at", { ascending: false });
  if (error) throw new Error(error.message);

  const attemptList = attempts ?? [];
  const attemptsCount = attemptList.length;

  if (attemptsCount === 0) {
    return {
      questionId,
      questionVariantId: input.contract?.questionVariantId ?? null,
      semanticFingerprint: fingerprint,
      status: "UNSEEN",
      attemptsCount: 0,
      hasIndependentSuccess: false,
      hasAssistedSuccess: false,
      hasFailures: false,
      lastAttemptAt: null,
      lastVerdict: null,
      lastCompletionMode: null,
      totalHintsUsed: 0,
      solutionRevealed: false,
      isRetired: false,
      isEligibleAgain: true,
      eligibilityReason: "Question has never been attempted by the learner.",
    };
  }

  const hasIndependentSuccess = attemptList.some((a) => a.consumed === true);
  const hasAssistedSuccess = attemptList.some(
    (a) => a.verdict === "PASS" && a.consumed === false,
  );
  const hasFailures = attemptList.some((a) => a.verdict !== "PASS");
  const totalHintsUsed = attemptList.reduce((sum, a) => sum + (a.hints_used ?? 0), 0);
  const solutionRevealed = attemptList.some((a) => a.solution_revealed === true);

  const latest = attemptList[0]!;
  const lastAttemptAt = latest.created_at;
  const lastVerdict = latest.verdict;
  const lastCompletionMode = latest.completion_mode as CompletionMode;

  let status: QuestionLifecycleStatus = "IN_PROGRESS";
  let isRetired = false;
  let isEligibleAgain = false;
  let eligibilityReason = "";

  if (hasIndependentSuccess) {
    status = "RETIRED";
    isRetired = true;
    isEligibleAgain = false;
    eligibilityReason =
      "Question was completed independently and correctly. Retired to prevent duplicate presentation.";
  } else if (hasAssistedSuccess) {
    status = "ELIGIBLE_REVIEW";
    isRetired = false;
    isEligibleAgain = true;
    eligibilityReason =
      "Question was completed with assistance/hints. Not retired as independent mastery evidence; eligible for review.";
  } else if (hasFailures) {
    status = "FAILED";
    isRetired = false;
    isEligibleAgain = true;
    eligibilityReason =
      "Question was attempted but not passed. Retained for remediation or retry.";
  } else {
    status = "PARTIAL_ASSISTED";
    isRetired = false;
    isEligibleAgain = true;
    eligibilityReason = "Partial understanding recorded. Eligible for follow-up.";
  }

  return {
    questionId: latest.question_id || questionId,
    questionVariantId: latest.question_variant_id ?? input.contract?.questionVariantId ?? null,
    semanticFingerprint: latest.semantic_fingerprint || fingerprint,
    status,
    attemptsCount,
    hasIndependentSuccess,
    hasAssistedSuccess,
    hasFailures,
    lastAttemptAt,
    lastVerdict,
    lastCompletionMode,
    totalHintsUsed,
    solutionRevealed,
    isRetired,
    isEligibleAgain,
    eligibilityReason,
  };
}

/**
 * Evaluates whether a candidate question/contract is eligible to be presented to the learner.
 * Distinguishes exact question retirement from semantic duplicate protection while keeping
 * the underlying topic/skills active.
 */
export async function evaluateQuestionEligibility(input: {
  db: Db;
  userId: string;
  contract: ExerciseContract;
}): Promise<QuestionEligibilityResult> {
  const questionId = input.contract.questionId ?? input.contract.exerciseId;
  const fingerprint = buildSemanticFingerprint(input.contract);

  // 1. Check exact question identity for independent retirement
  const exact = await input.db
    .from("lab_exercise_attempts")
    .select("attempt_id, consumed, completion_mode, verdict")
    .eq("user_id", input.userId)
    .eq("question_id", questionId);

  if (exact.error) throw new Error(exact.error.message);

  const exactAttempts = exact.data ?? [];
  const exactRetired = exactAttempts.some((a) => a.consumed === true);
  if (exactRetired) {
    return {
      eligible: false,
      lifecycleStatus: "RETIRED",
      reason: "Exact question has been completed independently and is retired.",
      isExactRetired: true,
      isSemanticDuplicate: false,
      attemptsCount: exactAttempts.length,
    };
  }

  // 2. Check semantic fingerprint for independent retirement
  const semantic = await input.db
    .from("lab_exercise_attempts")
    .select("attempt_id, consumed, completion_mode, verdict")
    .eq("user_id", input.userId)
    .eq("semantic_fingerprint", fingerprint);

  if (semantic.error) throw new Error(semantic.error.message);

  const semanticAttempts = semantic.data ?? [];
  const semanticDuplicate = semanticAttempts.some((a) => a.consumed === true);
  if (semanticDuplicate) {
    return {
      eligible: false,
      lifecycleStatus: "RETIRED",
      reason:
        "A semantically identical question has already been completed independently. Use a different variant.",
      isExactRetired: false,
      isSemanticDuplicate: true,
      attemptsCount: semanticAttempts.length,
    };
  }

  // 3. Question has not been retired. Check prior attempt history for status.
  const totalAttempts = Math.max(exactAttempts.length, semanticAttempts.length);
  if (totalAttempts === 0) {
    return {
      eligible: true,
      lifecycleStatus: "UNSEEN",
      reason: "Fresh question eligible for presentation.",
      isExactRetired: false,
      isSemanticDuplicate: false,
      attemptsCount: 0,
    };
  }

  const hasAssisted =
    exactAttempts.some((a) => a.verdict === "PASS") ||
    semanticAttempts.some((a) => a.verdict === "PASS");

  return {
    eligible: true,
    lifecycleStatus: hasAssisted ? "ELIGIBLE_REVIEW" : "FAILED",
    reason: hasAssisted
      ? "Prior attempts required assistance; eligible for review or variant practice."
      : "Prior attempt failed; eligible for targeted retry or remediation.",
    isExactRetired: false,
    isSemanticDuplicate: false,
    attemptsCount: totalAttempts,
  };
}

/**
 * M5-facing guard for future question selection. A directly consumed question
 * identity or semantically equivalent fingerprint is not eligible again.
 * It intentionally does not ban the underlying concepts.
 */
export async function isQuestionConsumed(input: {
  db: Db;
  userId: string;
  contract: ExerciseContract;
}): Promise<boolean> {
  const result = await evaluateQuestionEligibility(input);
  return !result.eligible && result.lifecycleStatus === "RETIRED";
}
