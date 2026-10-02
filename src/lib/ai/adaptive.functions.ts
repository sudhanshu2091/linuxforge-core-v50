import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { loadTutorContext } from "@/lib/forge/engine.server";
import { generateAdaptiveExercise } from "./provider.server";
import { aiAdaptiveReasoningService } from "./ai-service.server";
import { buildMissionBlueprint } from "./mission-generator";
import { analyzeLearner } from "./learner-intelligence";
import { selectAdaptiveTraining } from "./adaptive-training";
import type { AdaptiveExercise, SkillId } from "@/lib/forge/types";
import {
  generatedDefinitionToExerciseContract,
  isQuestionConsumed,
} from "@/lib/forge/verification/question-history.server";

const skillIds = new Set([
  "filesystem",
  "permissions",
  "iteration",
  "shell-scripting",
  "processes",
  "networking",
  "hardening",
]);

function asGeneratedDefinition(exercise: AdaptiveExercise) {
  if (!exercise.evaluationPlan) return null;
  const definition = {
    id: exercise.id,
    kind: exercise.kind,
    title: exercise.title,
    scenario: exercise.scenario,
    objective: exercise.objective,
    skills: exercise.skills.filter((skill) => skillIds.has(skill)),
    difficulty: exercise.difficulty,
    estimatedMinutes: exercise.estimatedMinutes,
    sourceRefs: exercise.sourceRefs,
    evaluationFocus: exercise.evaluationFocus,
    learnerReason: exercise.learnerReason,
    allowedApproaches: exercise.allowedApproaches ?? [],
    bannedShortcuts: exercise.bannedShortcuts ?? [],
    hints: exercise.hints ?? [],
    successStory: exercise.successStory ?? "Exercise complete.",
    failureStory: exercise.failureStory ?? "Exercise is not complete yet.",
    remediation: exercise.remediation ?? [],
    evaluationPlan: exercise.evaluationPlan,
  };
  // Validate the machine-verifiable portion before it ever reaches the DB.
  generatedDefinitionToExerciseContract(definition);
  return definition;
}

export const generateAdaptiveExerciseFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { kind?: "question" | "task" | "mission" | "mock_exam"; topic?: string }) => data)
  .handler(async ({ data, context }): Promise<AdaptiveExercise> => {
    const learner = await loadTutorContext(context.supabase, context.userId);
    const progression = learner.progression;
    const skillViews = learner.skills.map((s) => ({
      skillId: s.skill_id as SkillId,
      mastery: s.mastery,
      attempts: s.attempts,
      successfulAttempts: s.successful_attempts,
      recentScore: s.recent_score ?? null,
      recentMistakes: s.recent_mistakes ?? [],
      hintDependency: s.hint_dependency,
      lastPracticed: s.last_practiced ?? null,
      nextReview: s.next_review ?? null,
      confidence: s.confidence,
      retention: s.retention,
      independence: s.independence,
      speedScore: s.speed_score,
      consistency: s.consistency,
      difficultyRating: s.difficulty_rating,
      evidenceCount: s.evidence_count,
    }));
    const recentMistakes = skillViews.flatMap((s) => s.recentMistakes).slice(-20);
    const intelligence = analyzeLearner(skillViews, recentMistakes);
    let activeDecision = selectAdaptiveTraining({
      skills: skillViews,
      intelligence,
      currentDifficulty: Math.max(1, Math.min(5, progression?.level ?? 1)),
    });

    try {
      const reasoning = await aiAdaptiveReasoningService({
        skills: skillViews,
        recentMistakes: recentMistakes.filter((m): m is any => typeof m === "string"),
        currentDifficulty: activeDecision.difficulty,
        recentTopics: learner.recentEvents.map((e) => e.summary),
      });
      if (reasoning.response && !reasoning.fallbackUsed) {
        activeDecision = {
          ...activeDecision,
          reason: reasoning.response.pedagogicalRationale || activeDecision.reason,
          supportingSkills: [
            ...new Set([
              ...activeDecision.supportingSkills,
              ...reasoning.response.supportingSkills,
            ]),
          ].slice(0, 2),
        };
      }
    } catch {
      // Deterministic activeDecision used as safe fallback
    }

    const blueprint = buildMissionBlueprint({
      skills: skillViews,
      intelligence,
      recentMistakes,
      recentTopics: learner.recentEvents.map((e) => e.summary),
      currentDifficulty: activeDecision.difficulty,
      trainingDecision: activeDecision,
    });
    let exercise = await generateAdaptiveExercise({
      level: progression?.level ?? 1,
      weakSkills: intelligence.focusSkills,
      strongSkills: intelligence.masteredSkills,
      recentMistakes,
      recentTopics: learner.recentEvents.map((e) => e.summary),
      blueprint,
      ...(data.kind ? { kind: data.kind } : {}),
      ...(data.topic ? { requestedTopic: data.topic } : {}),
    });

    // M9 novelty gate: independently consumed questions are never allowed
    // back into the learner's queue, even when an AI provider regenerates
    // an equivalent wording. Try several fresh candidates before failing.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = asGeneratedDefinition(exercise);
      if (!candidate) break;
      const consumed = await isQuestionConsumed({
        db: context.supabase,
        userId: context.userId,
        contract: generatedDefinitionToExerciseContract(candidate),
      });
      if (!consumed) break;
      exercise = await generateAdaptiveExercise({
        level: progression?.level ?? 1,
        weakSkills: intelligence.focusSkills,
        strongSkills: intelligence.masteredSkills,
        recentMistakes,
        recentTopics: [
          ...learner.recentEvents.map((e) => e.summary),
          `EXCLUDE_CONSUMED_VARIANT_${crypto.randomUUID()}`,
        ],
        blueprint,
        ...(data.kind ? { kind: data.kind } : {}),
        ...(data.topic ? { requestedTopic: data.topic } : {}),
      });
    }

    const definition = asGeneratedDefinition(exercise);

    // Every generated exercise is learner-owned persistent content.
    // Executable task/mission definitions additionally pass through the
    // server-only contract gate above; conceptual questions/mock exams are
    // persisted as content but remain non-launchable.
    const storedDefinition = definition ?? {
      ...exercise,
      id: exercise.id,
    };

    const existing = await context.supabase
      .from("generated_exercises")
      .select("id")
      .eq("user_id", context.userId)
      .eq("id", exercise.id)
      .maybeSingle();
    if (existing.error) throw new Error(existing.error.message);

    if (existing.data?.id)
      return {
        ...exercise,
        id: existing.data.id,
        ...(definition ? { launchableId: existing.data.id } : {}),
      };

    const id = `${exercise.id}-${crypto.randomUUID().slice(0, 8)}`;
    const persisted = await context.supabase.from("generated_exercises").insert({
      id,
      user_id: context.userId,
      kind: exercise.kind,
      title: exercise.title,
      definition: { ...storedDefinition, id },
    });
    if (persisted.error) throw new Error(persisted.error.message);

    return definition ? { ...exercise, id, launchableId: id } : { ...exercise, id };
  });
