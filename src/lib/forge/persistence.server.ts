/**
 * Server-only learner state mutations.
 *
 * Keeping writes behind this module gives the learning engine one controlled
 * persistence boundary. RLS still applies to every query; this module never
 * uses service-role credentials to bypass ownership.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import type { SkillId, VerificationStatus } from "./types";
import { calculateSkillUpdate } from "@/lib/learner/learner-model";

type Db = SupabaseClient<Database>;
type AttemptRow = Database["public"]["Tables"]["learner_challenge_attempts"]["Row"];

const toJson = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;

export async function appendChallengeEvents(
  db: Db,
  userId: string,
  challengeId: string,
  events: Array<{ kind: string; payload: Record<string, unknown> }>,
) {
  if (!events.length) return;
  const result = await db.from("learner_challenge_events").insert(
    events.map((event) => ({
      user_id: userId,
      challenge_id: challengeId,
      kind: event.kind,
      payload: toJson(event.payload),
    })),
  );
  if (result.error) throw new Error(result.error.message);
}

export async function recordHintUsage(db: Db, userId: string, challengeId: string, level: number) {
  const result = await db
    .from("learner_hint_usage")
    .insert({ user_id: userId, challenge_id: challengeId, hint_level: level });
  if (result.error && !`${result.error.message}`.toLowerCase().includes("duplicate"))
    throw new Error(result.error.message);
  await appendChallengeEvents(db, userId, challengeId, [{ kind: "hint", payload: { level } }]);
}

export async function saveAttempt(
  db: Db,
  userId: string,
  challengeId: string,
  existing: AttemptRow | undefined,
  input: {
    status: VerificationStatus;
    score: number;
    completed: boolean;
    evidence: Record<string, unknown>;
    xpAwarded: number;
  },
) {
  const alreadyComplete = existing?.status === "COMPLETE";
  const payload = {
    user_id: userId,
    challenge_id: challengeId,
    status: alreadyComplete ? "COMPLETE" : input.status,
    attempts: (existing?.attempts ?? 0) + 1,
    best_score: Math.max(existing?.best_score ?? 0, input.score),
    evidence: toJson(input.evidence),
    completed_at: alreadyComplete
      ? existing?.completed_at
      : input.completed
        ? new Date().toISOString()
        : null,
  };
  const result = existing
    ? await db
        .from("learner_challenge_attempts")
        .update({ ...payload, xp_awarded: (existing.xp_awarded ?? 0) + input.xpAwarded })
        .eq("id", existing.id)
        .eq("user_id", userId)
    : await db
        .from("learner_challenge_attempts")
        .insert({ ...payload, xp_awarded: input.xpAwarded });
  if (result.error) throw new Error(result.error.message);
}

export async function awardProgressionXp(db: Db, userId: string, xp: number) {
  if (xp <= 0) return;
  const current = await db
    .from("learner_progression")
    .select("id,total_xp,level,challenges_completed,labs_completed")
    .eq("user_id", userId)
    .maybeSingle();
  if (current.error) throw new Error(current.error.message);

  const base = current.data;
  const totalXp = (base?.total_xp ?? 0) + xp;
  const level = 1 + Math.floor(totalXp / 500);
  const result = base
    ? await db
        .from("learner_progression")
        .update({
          total_xp: totalXp,
          level,
          challenges_completed: (base.challenges_completed ?? 0) + 1,
        })
        .eq("id", base.id)
        .eq("user_id", userId)
    : await db.from("learner_progression").insert({
        user_id: userId,
        total_xp: totalXp,
        level,
        challenges_completed: 1,
      });
  if (result.error) throw new Error(result.error.message);
}

export async function updateSkillMemory(
  db: Db,
  userId: string,
  skillIds: SkillId[],
  opts: {
    complete: boolean;
    score: number;
    hintsUsed: number;
    mistake: string | null;
    durationMs?: number;
    expectedMinutes?: number;
    difficulty?: number;
  },
) {
  for (const skillId of skillIds) {
    const current = await db
      .from("learner_skill_memory")
      .select("*")
      .eq("user_id", userId)
      .eq("skill_id", skillId)
      .maybeSingle();
    if (current.error) throw new Error(current.error.message);

    const row = current.data;
    const next = calculateSkillUpdate(
      {
        mastery: row?.mastery ?? 0,
        attempts: row?.attempts ?? 0,
        successfulAttempts: row?.successful_attempts ?? 0,
        hintDependency: row?.hint_dependency ?? 0,
        score: opts.score,
        complete: opts.complete,
        hintsUsed: opts.hintsUsed,
        mistake: opts.mistake,
        now: new Date(),
        ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
        ...(opts.expectedMinutes !== undefined ? { expectedMinutes: opts.expectedMinutes } : {}),
        ...(opts.difficulty !== undefined ? { difficulty: opts.difficulty } : {}),
        retention: row?.retention ?? 0,
        independence: row?.independence ?? 0,
        consistency: row?.consistency ?? 0,
      },
      row?.recent_mistakes ?? [],
    );

    const payload = {
      user_id: userId,
      skill_id: skillId,
      mastery: next.mastery,
      attempts: next.attempts,
      successful_attempts: next.successfulAttempts,
      recent_score: next.recentScore,
      recent_mistakes: next.recentMistakes,
      hint_dependency: next.hintDependency,
      last_practiced: next.lastPracticed,
      next_review: next.nextReview,
      confidence: next.confidence,
      retention: next.retention,
      independence: next.independence,
      speed_score: next.speedScore,
      consistency: next.consistency,
      difficulty_rating: next.difficultyRating,
      evidence_count: next.evidenceCount,
    };
    const result = row
      ? await db.from("learner_skill_memory").update(payload).eq("id", row.id).eq("user_id", userId)
      : await db.from("learner_skill_memory").insert(payload);
    if (result.error) throw new Error(result.error.message);
  }
}

export async function appendNarrativeEvent(
  db: Db,
  input: {
    userId: string;
    challengeId: string | null;
    eventType: string;
    summary: string;
    relatedSkillIds: string[];
    importance: number;
  },
) {
  const result = await db.from("learning_narrative_events").insert({
    user_id: input.userId,
    challenge_id: input.challengeId,
    event_type: input.eventType,
    summary: input.summary.slice(0, 500),
    related_skill_ids: input.relatedSkillIds,
    importance: input.importance,
  });
  if (result.error) throw new Error(result.error.message);
}
