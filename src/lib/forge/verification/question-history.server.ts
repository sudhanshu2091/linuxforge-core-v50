import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { buildSemanticFingerprint } from "./semantic-identity";
import type { GeneratedDefinition } from "../generated-contract.server";
import type { ExerciseContract, VerificationRequirement } from "./types";

type Db = SupabaseClient<Database>;

export function generatedDefinitionToExerciseContract(
  definition: GeneratedDefinition,
): ExerciseContract {
  const requirements: VerificationRequirement[] = [];

  for (const [index, objective] of definition.evaluationPlan.objectives.entries()) {
    const id = `objective-${index + 1}`;
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
 * M5-facing guard for future question selection. A directly consumed question
 * identity or semantically equivalent fingerprint is not eligible again.
 * It intentionally does not ban the underlying concepts.
 */
export async function isQuestionConsumed(input: {
  db: Db;
  userId: string;
  contract: ExerciseContract;
}): Promise<boolean> {
  const fingerprint = buildSemanticFingerprint(input.contract);
  const questionId = input.contract.questionId ?? input.contract.exerciseId;
  const exact = await input.db
    .from("lab_exercise_attempts")
    .select("attempt_id")
    .eq("user_id", input.userId)
    .eq("consumed", true)
    .eq("question_id", questionId)
    .limit(1);
  if (exact.error) throw new Error(exact.error.message);
  if ((exact.data?.length ?? 0) > 0) return true;

  const semantic = await input.db
    .from("lab_exercise_attempts")
    .select("attempt_id")
    .eq("user_id", input.userId)
    .eq("consumed", true)
    .eq("semantic_fingerprint", fingerprint)
    .limit(1);
  if (semantic.error) throw new Error(semantic.error.message);
  return (semantic.data?.length ?? 0) > 0;
}
