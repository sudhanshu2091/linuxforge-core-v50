/**
 * Challenge engine orchestrator (server-only).
 *
 * Owns persistence, XP grading (idempotent, server side only) and the
 * executor → verifier → observer pipeline. Called exclusively from the
 * authenticated server functions in `engine.functions.ts`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { buildContext } from "./context.server";
import { CONTRACTS, contractById, toBrief } from "./contracts.server";
import type { Contract } from "./contracts.server";
import {
  generatedDefinitionToContract,
  generatedToBrief,
  type GeneratedDefinition,
} from "./generated-contract.server";
import type { ModelObject, World } from "./executor.server";
import { ensureLabSession, executeInLab, sendTerminalSignal } from "./sandbox/lab.server";
import {
  appendChallengeEvents,
  appendNarrativeEvent,
  awardProgressionXp,
  recordHintUsage,
  saveAttempt,
  updateSkillMemory,
} from "./persistence.server";
import { aiObserver } from "./observer.server";
import {
  buildMissionAssessment,
  type AssessmentCommand,
  type AssessmentObservation,
} from "./assessment.server";
import { verify } from "./verifier.server";
import { SKILL_LABELS } from "./types";
import { buildAdaptivePlan } from "@/lib/learner/adaptive-plan";
import { decideProgression } from "@/lib/learner/mastery-engine";
import { analyzeLearner } from "@/lib/ai/learner-intelligence";
import { selectAdaptiveTraining, type TrainingDecision } from "@/lib/ai/adaptive-training";
import { buildGuidedHint } from "@/lib/ai/hint-engine";
import type { ObservationCategory as HintObservationCategory } from "@/lib/forge/types";
import { redactLines, redactText } from "@/lib/security-redaction";
import type {
  ObservationCategory,
  AttemptView,
  MissionState,
  NarrativeEventView,
  Observation,
  RunResult,
  SkillId,
  SkillMemoryView,
  TerminalLine,
  Verification,
  VerificationStatus,
  MissionAssessment,
  WorldObjectView,
} from "./types";

type Tables = Database["public"]["Tables"];
type AttemptRow = Tables["learner_challenge_attempts"]["Row"];
type ChallengeEventRow = Tables["learner_challenge_events"]["Row"];
type HintRow = Tables["learner_hint_usage"]["Row"];

export type Db = SupabaseClient<Database>;
type Lang = "English" | "Hinglish" | "Mix both";

/** Narrow an unknown JSON value to a plain object without widening to `any`. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const isSkillId = (value: string): value is SkillId => value in SKILL_LABELS;

const OBSERVATION_CATEGORIES: readonly ObservationCategory[] = [
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
];

const LAB_KEY = "forge-core";

async function contractFor(db: Db, userId: string, challengeId: string) {
  const staticContract = contractById(challengeId);
  if (staticContract) return staticContract;
  const row = await db
    .from("generated_exercises")
    .select("definition, kind")
    .eq("user_id", userId)
    .eq("id", challengeId)
    .maybeSingle();
  if (row.error) throw new Error(row.error.message);
  if (!row.data || (row.data.kind !== "task" && row.data.kind !== "mission")) return null;
  return generatedDefinitionToContract(row.data.definition as unknown as GeneratedDefinition);
}

async function loadGeneratedExercises(db: Db, userId: string) {
  const res = await db
    .from("generated_exercises")
    .select("id, kind, title, definition, created_at")
    .eq("user_id", userId)
    .in("kind", ["task", "mission"])
    .order("created_at", { ascending: false })
    .limit(12);
  if (res.error) throw new Error(res.error.message);
  return (res.data ?? []).flatMap((row) => {
    try {
      return [
        generatedDefinitionToContract({
          ...(row.definition as unknown as GeneratedDefinition),
          id: row.id,
        }),
      ];
    } catch {
      return [];
    }
  });
}

async function ensureLab(db: Db, userId: string) {
  const existing = await db
    .from("learner_labs")
    .select("*")
    .eq("user_id", userId)
    .eq("lab_key", LAB_KEY)
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  if (existing.data) return existing.data;
  const created = await db
    .from("learner_labs")
    .insert({ user_id: userId, lab_key: LAB_KEY, title: "Forge training lab" })
    .select("*")
    .single();
  if (created.error) throw new Error(created.error.message);
  return created.data;
}

async function loadWorld(db: Db, userId: string, labId: string) {
  const res = await db
    .from("lab_world_objects")
    .select("*")
    .eq("user_id", userId)
    .eq("lab_id", labId)
    .eq("active", true);
  if (res.error) throw new Error(res.error.message);
  const world: World = new Map();
  const views: WorldObjectView[] = [];
  for (const r of res.data ?? []) {
    const state = asRecord(r.current_state);
    const objectType = r.object_type === "directory" ? ("directory" as const) : ("file" as const);
    const obj: ModelObject = {
      objectId: r.object_id,
      objectType,
      path: r.path,
      name: r.name,
      permissions: asString(state["permissions"], objectType === "directory" ? "755" : "644"),
      content: asString(state["content"], ""),
      active: true,
      createdByChallenge: r.created_by_challenge ?? null,
      lastModifiedByChallenge: r.last_modified_by_challenge ?? null,
      createdAt: r.created_at,
    };

    world.set(obj.path, obj);
    views.push({
      objectId: obj.objectId,
      objectType: obj.objectType,
      path: obj.path,
      name: obj.name,
      permissions: obj.permissions,
      createdByChallenge: obj.createdByChallenge,
      lastModifiedByChallenge: obj.lastModifiedByChallenge,
      createdAt: obj.createdAt,
    });
  }
  views.sort((a, b) => a.path.localeCompare(b.path));
  return { world, views };
}

async function loadAttempts(db: Db, userId: string) {
  const res = await db.from("learner_challenge_attempts").select("*").eq("user_id", userId);
  if (res.error) throw new Error(res.error.message);
  return res.data ?? [];
}

async function loadSkills(db: Db, userId: string): Promise<SkillMemoryView[]> {
  const res = await db.from("learner_skill_memory").select("*").eq("user_id", userId);
  if (res.error) throw new Error(res.error.message);
  return (res.data ?? []).map((r) => ({
    skillId: r.skill_id as SkillId,
    mastery: r.mastery,
    attempts: r.attempts,
    successfulAttempts: r.successful_attempts,
    recentScore: r.recent_score ?? null,
    recentMistakes: r.recent_mistakes ?? [],
    hintDependency: r.hint_dependency,
    lastPracticed: r.last_practiced ?? null,
    nextReview: r.next_review ?? null,
    confidence: r.confidence,
  }));
}

async function loadEvents(db: Db, userId: string): Promise<NarrativeEventView[]> {
  const res = await db
    .from("learning_narrative_events")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(30);
  if (res.error) throw new Error(res.error.message);
  return (res.data ?? []).map((r) => ({
    eventId: r.event_id,
    challengeId: r.challenge_id ?? null,
    eventType: r.event_type,
    summary: r.summary,
    importance: r.importance,
    createdAt: r.created_at,
    relatedSkillIds: r.related_skill_ids ?? [],
  }));
}

async function loadProgression(db: Db, userId: string) {
  const res = await db.from("learner_progression").select("*").eq("user_id", userId).maybeSingle();
  if (res.error) throw new Error(res.error.message);
  if (res.data) return res.data;
  const created = await db
    .from("learner_progression")
    .insert({ user_id: userId })
    .select("*")
    .single();
  if (created.error) throw new Error(created.error.message);
  return created.data;
}

async function loadChallengeEvents(db: Db, userId: string, challengeId: string) {
  const res = await db
    .from("learner_challenge_events")
    .select("*")
    .eq("user_id", userId)
    .eq("challenge_id", challengeId)
    .order("created_at", { ascending: true })
    .limit(200);
  if (res.error) throw new Error(res.error.message);
  return res.data ?? [];
}

async function loadHints(db: Db, userId: string, challengeId: string) {
  const res = await db
    .from("learner_hint_usage")
    .select("*")
    .eq("user_id", userId)
    .eq("challenge_id", challengeId)
    .order("hint_level", { ascending: true });
  if (res.error) throw new Error(res.error.message);
  return res.data ?? [];
}

const STATUSES: readonly VerificationStatus[] = [
  "COMPLETE",
  "RESULT_CORRECT_SKILL_NOT_DEMONSTRATED",
  "RESULT_INCORRECT_SKILL_DEMONSTRATED",
  "INCOMPLETE",
  "BLOCKED_BY_SAFETY_POLICY",
];
const isStatus = (v: unknown): v is VerificationStatus =>
  typeof v === "string" && (STATUSES as readonly string[]).includes(v);

const stringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((i): i is string => typeof i === "string") : [];

const attemptView = (row: AttemptRow | undefined, challengeId: string): AttemptView => ({
  challengeId,
  status: isStatus(row?.status) ? row.status : "INCOMPLETE",
  attempts: row?.attempts ?? 0,
  bestScore: row?.best_score ?? 0,
  xpAwarded: row?.xp_awarded ?? 0,
  completedAt: row?.completed_at ?? null,
  startedAt: row?.started_at ?? null,
});

/** Rebuild the stored verification payload field-by-field (no unsafe casts). */
function verificationFrom(events: ChallengeEventRow[]): Verification | null {
  const ev = [...events].reverse().find((e) => e.kind === "verification");
  if (!ev) return null;
  const v = asRecord(asRecord(ev.payload)["verification"]);
  if (!isStatus(v["status"])) return null;
  const rawObjectives = v["objectives"];
  return {
    status: v["status"],
    objectives: (Array.isArray(rawObjectives) ? rawObjectives : []).map((o) => {
      const r = asRecord(o);
      return {
        label: asString(r["label"]),
        met: r["met"] === true,
        evidence: asString(r["evidence"]),
      };
    }),
    score: typeof v["score"] === "number" ? v["score"] : 0,
    message: asString(v["message"]),
    remediation: stringList(v["remediation"]),
    wentWell: stringList(v["wentWell"]),
  };
}

/** Rebuild the stored observation payload field-by-field (advisory only). */
function observationFrom(events: ChallengeEventRow[]): Observation | null {
  const ev = [...events].reverse().find((e) => e.kind === "observation");
  if (!ev) return null;
  const o = asRecord(asRecord(ev.payload)["observation"]);
  if (!o["intent"] && !o["coaching"]) return null;
  const understanding = asString(o["conceptUnderstanding"], "partial");
  const category = asString(o["category"]);
  return {
    intent: asString(o["intent"]),
    approach: asString(o["approach"]),
    skillTarget: stringList(o["skillTarget"]).filter(isSkillId),
    category: OBSERVATION_CATEGORIES.find((c) => c === category) ?? null,
    conceptUnderstanding:
      understanding === "unclear" || understanding === "solid" ? understanding : "partial",
    skillDemonstrated: o["skillDemonstrated"] === true,
    coaching: asString(o["coaching"]),
  };
}

async function loadMissionTranscript(
  db: Db,
  userId: string,
  challengeId: string,
): Promise<TerminalLine[]> {
  const result = await db
    .from("lab_command_events")
    .select("input,cwd_before,stdout,stderr,blocked_reason,created_at")
    .eq("user_id", userId)
    .eq("challenge_id", challengeId)
    .order("created_at", { ascending: true })
    .limit(200);
  if (result.error) throw new Error(result.error.message);

  const lines: TerminalLine[] = [];
  for (const event of result.data ?? []) {
    lines.push({
      kind: "input",
      text: `${event.cwd_before ? `~/${event.cwd_before}` : "~"}$ ${event.input}`,
    });
    if (event.stdout) {
      for (const text of event.stdout.split(/\r?\n/)) {
        if (text) lines.push({ kind: "output", text });
      }
    }
    if (event.stderr) {
      for (const text of event.stderr.split(/\r?\n/)) {
        if (text) lines.push({ kind: "error", text });
      }
    }
    if (event.blocked_reason) {
      lines.push({ kind: "error", text: `Blocked: ${event.blocked_reason}` });
    }
  }
  return lines.slice(-120);
}

export function pickNext(
  attempts: AttemptRow[],
  skills: SkillMemoryView[],
  currentId: string,
  generatedContracts: Contract[] = [],
  trainingDecision?: MissionState["trainingDecision"] | TrainingDecision | null,
): string | null {
  /*
   * Next-mission selection is advisory.
   *
   * A malformed/partial learner-model payload must never make the
   * currently active mission unavailable.
   */

  const safeAttempts = Array.isArray(attempts) ? attempts : [];
  const safeSkills = Array.isArray(skills) ? skills : [];
  const safeGeneratedContracts = Array.isArray(generatedContracts)
    ? generatedContracts
    : [];

  const byId = new Map(
    safeAttempts.map((attempt) => [
      attempt.challenge_id,
      attempt,
    ]),
  );

  const done = (id: string): boolean =>
    byId.get(id)?.status === "COMPLETE";

  let desiredDifficulty = 1;
  let focusSkills: SkillId[] = [];
  let preferredPrimary: SkillId | null = null;

  if (trainingDecision) {
    desiredDifficulty = trainingDecision.difficulty;
    preferredPrimary = trainingDecision.primarySkill;
    focusSkills = [
      trainingDecision.primarySkill,
      ...trainingDecision.supportingSkills,
      ...(trainingDecision.journeyNextSkills ?? []),
    ];
  } else {
    try {
      const currentContract = contractById(currentId);
      const mistakeCategories = safeSkills
        .flatMap((s) => s.recentMistakes)
        .filter((m): m is ObservationCategory => typeof m === "string");
      const intelligence = analyzeLearner(safeSkills, mistakeCategories);
      const computedDecision = selectAdaptiveTraining({
        skills: safeSkills,
        intelligence,
        currentDifficulty: currentContract?.difficulty ?? 1,
      });

      desiredDifficulty = computedDecision.difficulty;
      preferredPrimary = computedDecision.primarySkill;
      focusSkills = [
        computedDecision.primarySkill,
        ...computedDecision.supportingSkills,
        ...(computedDecision.journeyNextSkills ?? []),
      ];
    } catch {
      try {
        const currentContract = contractById(currentId);
        const plan = buildAdaptivePlan({
          skills: safeSkills,
          currentDifficulty: currentContract?.difficulty ?? 1,
        });

        if (
          plan &&
          typeof plan === "object" &&
          Array.isArray(plan.focusSkills)
        ) {
          focusSkills = plan.focusSkills.filter(isSkillId);
        }

        if (
          plan &&
          typeof plan === "object" &&
          typeof plan.desiredDifficulty === "number" &&
          Number.isFinite(plan.desiredDifficulty)
        ) {
          desiredDifficulty = plan.desiredDifficulty;
        }
      } catch (fallbackError) {
        console.error(
          "[LinuxForge mission-state] adaptive fallback failed in pickNext",
          fallbackError,
        );
        desiredDifficulty = 1;
        focusSkills = [];
      }
    }
  }

  const allContracts: Contract[] = [
    ...CONTRACTS,
    ...safeGeneratedContracts,
  ];

  const open = allContracts.filter((contract) => {
    if (contract.id === currentId) return false;
    if (done(contract.id)) return false;

    const prerequisites = Array.isArray(contract.prerequisites)
      ? contract.prerequisites
      : [];

    return prerequisites.every((prerequisite) => done(prerequisite));
  });

  if (open.length === 0) return null;

  const focus = new Set(focusSkills);

  const scored = open.map((contract) => {
    const requiredSkills = Array.isArray(contract.requiredSkills)
      ? contract.requiredSkills
      : [];

    const difficulty =
      typeof contract.difficulty === "number" &&
      Number.isFinite(contract.difficulty)
        ? contract.difficulty
        : 1;

    const order =
      typeof contract.order === "number" &&
      Number.isFinite(contract.order)
        ? contract.order
        : Number.MAX_SAFE_INTEGER;

    const skillMatch = requiredSkills.filter((skill) =>
      focus.has(skill),
    ).length;

    const primaryBonus = preferredPrimary && requiredSkills.includes(preferredPrimary) ? 20 : 0;

    const difficultyDistance = Math.abs(
      difficulty - desiredDifficulty,
    );

    const difficultyScore = Math.max(
      0,
      4 - difficultyDistance,
    );

    const orderScore = Math.max(
      0,
      2 - order / 100,
    );

    return {
      contract,
      score:
        primaryBonus +
        skillMatch * 10 +
        difficultyScore +
        orderScore,
    };
  });

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.contract.order - b.contract.order,
  );

  return scored[0]?.contract.id ?? null;
}

/**
 * Initialise-or-restore a mission.
 *
 * Never duplicates learner state: if the requested mission (or, with no
 * request, the learner's story position) already has an attempt row, that row
 * is resumed. A new row is created only when none exists.
 */
export async function startOrRestoreMission(
  db: Db,
  userId: string,
  requestedId?: string,
): Promise<{ challengeId: string; resumed: boolean }> {
  await ensureLab(db, userId);
  const attempts = await loadAttempts(db, userId);
  const done = (id: string) => attempts.find((a) => a.challenge_id === id)?.status === "COMPLETE";

  const generated = await loadGeneratedExercises(db, userId);
  let challengeId =
    requestedId && (contractById(requestedId) || generated.some((c) => c.id === requestedId))
      ? requestedId
      : null;
  if (!challengeId) {
    // Story position: the earliest unlocked, unfinished mission.
    const inProgress = CONTRACTS.find(
      (c) => !done(c.id) && attempts.some((a) => a.challenge_id === c.id),
    );
    const nextOpen = CONTRACTS.filter((c) => !done(c.id) && c.prerequisites.every(done)).sort(
      (a, b) => a.order - b.order,
    )[0];
    challengeId = inProgress?.id ?? nextOpen?.id ?? generated[0]?.id ?? CONTRACTS[0]!.id;
  }

  const selectedContract =
    contractById(challengeId) ?? generated.find((contract) => contract.id === challengeId) ?? null;
  if (!selectedContract) throw new Error("Unknown mission");
  if (selectedContract.prerequisites.some((prerequisite) => !done(prerequisite))) {
    const unmet = selectedContract.prerequisites.filter((prerequisite) => !done(prerequisite));
    throw new Error(`Mission is locked. Complete ${unmet.join(", ")} first.`);
  }

  const existing = attempts.find((a) => a.challenge_id === challengeId);
  if (existing) return { challengeId, resumed: true };

  const created = await db
    .from("learner_challenge_attempts")
    .insert({ user_id: userId, challenge_id: challengeId, status: "INCOMPLETE" });
  if (created.error && !`${created.error.message}`.includes("duplicate"))
    throw new Error(created.error.message);
  return { challengeId, resumed: false };
}

function stageForHint(level: number, total: number) {
  if (level >= total) return "SOLUTION";
  if (level >= 4) return "NEAR_SOLUTION";
  if (level === 3) return "COMMAND";
  if (level === 2) return "DIRECTION";
  return "CONCEPT";
}

function hintContextFromEvents(events: ChallengeEventRow[]) {
  const observations = events
    .filter((event) => event.kind === "observation")
    .map((event) => observationFrom([event]))
    .filter((value): value is Observation => Boolean(value));
  const categories = observations
    .map((observation) => observation.category)
    .filter((value): value is HintObservationCategory => value !== null);
  const commands = events
    .filter((event) => event.kind === "command")
    .map((event) => asRecord(event.payload));
  const failedCommands = commands.filter((payload) => payload["exitCode"] !== 0).length;
  const commandText = commands
    .flatMap((payload) => stringList(payload["commands"]))
    .slice(-8)
    .join("; ");
  return {
    observations,
    categories,
    failedCommands,
    attempts: commands.length,
    commandText,
  };
}

export async function loadMissionState(
  db: Db,
  userId: string,
  challengeId: string,
  cwd: string,
  language: Lang,
): Promise<MissionState> {
  void language;

  const contract =
    (await contractFor(db, userId, challengeId)) ??
    CONTRACTS[0]!;

  const lab = await ensureLab(db, userId);

  const [
    { views },
    attempts,
    skills,
    events,
    progression,
    chEvents,
    hintRows,
    generatedContracts,
    transcript,
  ] = await Promise.all([
    loadWorld(db, userId, lab.id),
    loadAttempts(db, userId),
    loadSkills(db, userId),
    loadEvents(db, userId),
    loadProgression(db, userId),
    loadChallengeEvents(db, userId, contract.id),
    loadHints(db, userId, contract.id),
    loadGeneratedExercises(db, userId),
    loadMissionTranscript(db, userId, contract.id),
  ]);

  /*
   * Normalize every collection at the mission-state boundary.
   *
   * Supabase normally gives us arrays, but mission-state is a critical
   * read path. A partial/null value must not turn into:
   *
   *   Cannot read properties of undefined (reading 'filter')
   */
  const safeViews = Array.isArray(views) ? views : [];
  const safeAttempts = Array.isArray(attempts) ? attempts : [];
  const safeSkills = Array.isArray(skills) ? skills : [];
  const safeEvents = Array.isArray(events) ? events : [];
  const safeChallengeEvents = Array.isArray(chEvents)
    ? chEvents
    : [];
  const safeHintRows = Array.isArray(hintRows)
    ? hintRows
    : [];
  const safeGeneratedContracts = Array.isArray(
    generatedContracts,
  )
    ? generatedContracts
    : [];
  const safeTranscript = Array.isArray(transcript)
    ? transcript
    : [];

  const attemptRow = safeAttempts.find(
    (a) => a.challenge_id === contract.id,
  );

  const lastVerification =
    verificationFrom(safeChallengeEvents);

  const lastObservation =
    observationFrom(safeChallengeEvents);

  console.error(
    "[LinuxForge mission-state] collection diagnostics",
    {
      views: Array.isArray(views),
      attempts: Array.isArray(attempts),
      skills: Array.isArray(skills),
      events: Array.isArray(events),
      chEvents: Array.isArray(chEvents),
      hintRows: Array.isArray(hintRows),
      generatedContracts: Array.isArray(generatedContracts),
      transcript: Array.isArray(transcript),
    },
  );

  const completed = new Set(
    safeAttempts
      .filter((a) => a.status === "COMPLETE")
      .map((a) => a.challenge_id),
  );

  console.error(
    "[LinuxForge mission-state] CHECKPOINT B: before-buildContext",
  );

  let missionContext;

  try {
    missionContext = buildContext({
      contract,
      labTitle: lab.title,
      cwd,
      objects: safeViews,
      events: safeEvents,
      skills: safeSkills,
      attempts: safeAttempts.map((a) => ({
        challengeId: a.challenge_id,
        status: a.status as VerificationStatus,
        score: a.best_score,
        updatedAt: a.updated_at,
      })),
      level: progression.level,
    });
  } catch (error) {
    console.error(
      "[LinuxForge mission-state] buildContext FAILED",
      error,
    );

    console.error(
      "[LinuxForge mission-state] buildContext input shapes",
      {
        contractRequiredSkills: Array.isArray(
          contract.requiredSkills,
        ),
        contractPrerequisites: Array.isArray(
          contract.prerequisites,
        ),
        objects: Array.isArray(safeViews),
        events: Array.isArray(safeEvents),
        skills: Array.isArray(safeSkills),
        attempts: Array.isArray(safeAttempts),
        skillRecentMistakes: safeSkills.map((s) => ({
          skillId: s.skillId,
          isArray: Array.isArray(s.recentMistakes),
          type: typeof s.recentMistakes,
        })),
      },
    );

    throw error;
  }

  console.error(
    "[LinuxForge mission-state] CHECKPOINT C: buildContext-ok",
  );

  /*
   * Catalogue
   */
  console.error(
    "[LinuxForge mission-state] CHECKPOINT D: catalogue-start",
  );

  const staticCatalogue = CONTRACTS.map((c) => {
    const row = safeAttempts.find(
      (a) => a.challenge_id === c.id,
    );

    const prerequisites = Array.isArray(c.prerequisites)
      ? c.prerequisites
      : [];

    return {
      ...toBrief(c),
      attempt: row ? attemptView(row, c.id) : null,
      unlocked: prerequisites.every((p) =>
        completed.has(p),
      ),
    };
  });

  console.error(
    "[LinuxForge mission-state] CHECKPOINT E: static-catalogue-ok",
    {
      count: staticCatalogue.length,
    },
  );

  const generatedCatalogue =
    safeGeneratedContracts.map((c) => {
      const row = safeAttempts.find(
        (a) => a.challenge_id === c.id,
      );

      return {
        ...generatedToBrief({
          id: c.id,
          kind: "task",
          title: c.title,
          scenario: c.storyIntro,
          objective: c.objective,
          skills: Array.isArray(c.requiredSkills)
            ? c.requiredSkills
            : [],
          difficulty: c.difficulty,
          estimatedMinutes: 10,
          sourceRefs: [],
          evaluationFocus: [],
          learnerReason: "",
          allowedApproaches: Array.isArray(
            c.allowedApproaches,
          )
            ? c.allowedApproaches
            : [],
          bannedShortcuts: Array.isArray(
            c.bannedShortcuts,
          )
            ? c.bannedShortcuts
            : [],
          hints: Array.isArray(c.hints)
            ? c.hints
            : [],
          successStory: c.successStory,
          failureStory: c.failureStory,
          remediation: Array.isArray(c.remediation)
            ? c.remediation
            : [],
          evaluationPlan: {
            objectives: [],
          },
        }),
        attempt: row ? attemptView(row, c.id) : null,
        unlocked: true,
      };
    });

  console.error(
    "[LinuxForge mission-state] CHECKPOINT F: generated-catalogue-ok",
    {
      count: generatedCatalogue.length,
    },
  );

  /*
   * Hints
   *
   * Empty hintRows is valid. In that case this map simply produces [].
   */
  const missionHints = safeHintRows.map((h) => {
    const hintContext =
      hintContextFromEvents(
        safeChallengeEvents,
      );

    console.error(
      "[LinuxForge mission-state] HINT INPUT",
      {
        hintLevel: h.hint_level,
        hintRowsIsArray: Array.isArray(
          safeHintRows,
        ),
        chEventsIsArray: Array.isArray(
          safeChallengeEvents,
        ),
        hintContextCategoriesIsArray:
          Array.isArray(
            hintContext.categories,
          ),
        hintContextCategoriesType:
          typeof hintContext.categories,
        failedCommands:
          hintContext.failedCommands,
        attempts:
          hintContext.attempts,
        skillsIsArray:
          Array.isArray(safeSkills),
      },
    );

    /*
     * Reuse the already-computed mission context instead of calling
     * buildContext() again for every hint.
     */
    const guided = buildGuidedHint({
      level: h.hint_level,

      totalLevels: Math.max(
        1,
        Array.isArray(contract.hints)
          ? contract.hints.length
          : 0,
      ),

      baseHint:
        contract.hints?.[h.hint_level - 1] ?? "",

      observation: lastObservation
        ? {
            category:
              lastObservation.category,
            conceptUnderstanding:
              lastObservation.conceptUnderstanding,
            skillDemonstrated:
              lastObservation.skillDemonstrated,
          }
        : null,

      failedCommands:
        hintContext.failedCommands,

      attempts:
        hintContext.attempts,

      learnerLevel:
        progression.level,

      desiredDifficulty:
        missionContext.desired_difficulty,

      skills:
        safeSkills,

      mistakeHistory:
        hintContext.categories,

      previousHintStages:
        safeHintRows
          .filter(
            (row) =>
              row.hint_level <
              h.hint_level,
          )
          .map((row) =>
            stageForHint(
              row.hint_level,
              Math.max(
                1,
                contract.hints?.length ??
                  0,
              ),
            ),
          ),

      objective:
        contract.objective,

      currentTerminalState:
        hintContext.commandText,
    });

    return {
      level: guided.level,
      text: guided.text,
      stage: guided.stage,
      teachingNote:
        guided.teachingNote,
    };
  });

  /*
   * Next mission is advisory.
   *
   * Even if adaptive planning or learner data is malformed, the current
   * mission must still load.
   */
  console.error(
    "[LinuxForge mission-state] CHECKPOINT G: before-pickNext",
  );

  let trainingDecision: MissionState["trainingDecision"] = null;
  try {
    const mistakeCategories = safeSkills
      .flatMap((s) => s.recentMistakes)
      .concat(lastObservation?.category ? [lastObservation.category] : [])
      .filter((m): m is ObservationCategory => typeof m === "string");
    const intelligence = analyzeLearner(safeSkills, mistakeCategories);
    trainingDecision = selectAdaptiveTraining({
      skills: safeSkills,
      intelligence,
      assessment: lastVerification
        ? {
            learningSignal:
              lastVerification.status === "COMPLETE"
                ? "mastered"
                : lastVerification.status === "BLOCKED_BY_SAFETY_POLICY"
                  ? "blocked"
                  : "needs_practice",
            grade: lastVerification.score,
            mistakeBreakdown:
              lastObservation?.category &&
              lastObservation.category !== "VALID_ALTERNATIVE" &&
              lastObservation.category !== "INDEPENDENT_SOLUTION"
                ? [{ category: lastObservation.category, count: 1 }]
                : [],
            hintsUsed: safeHintRows.length,
          }
        : null,
      currentDifficulty: contract.difficulty,
    });
  } catch (error) {
    console.error(
      "[LinuxForge mission-state] trainingDecision computation failed",
      error,
    );
    trainingDecision = null;
  }

  let nextChallengeId: string | null = null;

  try {
    nextChallengeId = pickNext(
      safeAttempts,
      safeSkills,
      contract.id,
      safeGeneratedContracts,
      trainingDecision,
    );

    console.error(
      "[LinuxForge mission-state] CHECKPOINT H: pickNext-ok",
      {
        nextChallengeId,
      },
    );
  } catch (error) {
    console.error(
      "[LinuxForge mission-state] pickNext boundary failure",
      error,
    );

    nextChallengeId = null;
  }

  return {
    challenge: toBrief(contract),

    context: missionContext,

    attempt: attemptView(
      attemptRow,
      contract.id,
    ),

    catalogue: [
      ...staticCatalogue,
      ...generatedCatalogue,
    ],

    transcript: safeTranscript,

    cwd,

    hints: missionHints,

    hintsRemaining: Math.max(
      0,
      (Array.isArray(contract.hints)
        ? contract.hints.length
        : 0) -
        safeHintRows.length,
    ),

    skills: safeSkills,

    progression: {
      totalXp: progression.total_xp,
      level: progression.level,
      challengesCompleted:
        progression.challenges_completed,
    },

    lastVerification,

    lastObservation,

    nextChallengeId,

    trainingDecision,
  };
}

export async function revealNextHint(db: Db, userId: string, challengeId: string) {
  const contract = await contractFor(db, userId, challengeId);
  if (!contract) throw new Error("Unknown mission");
  const [used, events, skills, progression, lab] = await Promise.all([
    loadHints(db, userId, challengeId),
    loadChallengeEvents(db, userId, challengeId),
    loadSkills(db, userId),
    loadProgression(db, userId),
    ensureLab(db, userId),
  ]);
  const { views } = await loadWorld(db, userId, lab.id);
  const level = Math.min(used.length + 1, Math.max(1, contract.hints.length));
  const ctx = hintContextFromEvents(events);
  const priorStages = used.map((row) => stageForHint(row.hint_level, contract.hints.length));
  const learnerContext = buildContext({
    contract,
    labTitle: lab.title,
    cwd: "",
    objects: views,
    events: await loadEvents(db, userId),
    skills,
    attempts: (await loadAttempts(db, userId)).map((a) => ({
      challengeId: a.challenge_id,
      status: a.status as VerificationStatus,
      score: a.best_score,
      updatedAt: a.updated_at,
    })),
    level: progression.level,
  });
  const guided = buildGuidedHint({
    level,
    totalLevels: contract.hints.length,
    baseHint: contract.hints[level - 1] ?? "",
    observation: observationFrom(events),
    failedCommands: ctx.failedCommands,
    attempts: ctx.attempts,
    learnerLevel: progression.level,
    desiredDifficulty: learnerContext.desired_difficulty,
    skills,
    mistakeHistory: ctx.categories,
    previousHintStages: priorStages,
    objective: contract.objective,
    currentTerminalState: ctx.commandText,
  });
  if (used.length >= contract.hints.length) return guided;
  await recordHintUsage(db, userId, challengeId, level);
  return guided;
}

export async function loadTutorContext(db: Db, userId: string) {
  const [profile, preferences, progression, skills, events, attempts, commands] = await Promise.all(
    [
      db
        .from("learner_profiles")
        .select("display_name, linux_comfort_level")
        .eq("user_id", userId)
        .maybeSingle(),
      db
        .from("learner_preferences")
        .select("preferred_tutor_language")
        .eq("user_id", userId)
        .maybeSingle(),
      db
        .from("learner_progression")
        .select("level, total_xp, challenges_completed")
        .eq("user_id", userId)
        .maybeSingle(),
      db.from("learner_skill_memory").select("*").eq("user_id", userId),
      db
        .from("learning_narrative_events")
        .select("challenge_id, event_type, summary, related_skill_ids, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(12),
      db
        .from("learner_challenge_attempts")
        .select("challenge_id, status, best_score, attempts, updated_at")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false })
        .limit(12),
      db
        .from("lab_command_events")
        .select("challenge_id, input, stdout, stderr, exit_code, cwd_before, cwd_after, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(12),
    ],
  );
  for (const r of [profile, preferences, progression, skills, events, attempts, commands])
    if (r.error) throw new Error(r.error.message);
  return {
    profile: profile.data ?? null,
    preferences: preferences.data ?? null,
    progression: progression.data ?? null,
    skills: skills.data ?? [],
    recentEvents: events.data ?? [],
    recentAttempts: attempts.data ?? [],
    recentCommands: commands.data ?? [],
  };
}

export async function runTerminalCommand(
  db: Db,
  userId: string,
  raw: string,
  cwd: string,
  shell: "bash" | "zsh" | "sh" = "bash",
  sessionId?: string,
): Promise<{ transcript: TerminalLine[]; cwd: string; running: boolean }> {
  if (!raw.trim()) return { transcript: [], cwd, running: false };
  const sessionRes = await ensureLabSession(db, userId);
  if (!sessionRes.ok) throw new Error(`Lab environment unavailable: ${sessionRes.error.message}`);
  const result = await executeInLab(
    db,
    userId,
    sessionRes.value,
    { kind: "raw-shell", data: raw },
    cwd,
    null,
    shell,
    sessionId,
  );
  if (!result.ok) throw new Error(result.error.message);
  const record = result.value;
  return {
    cwd: record.cwdAfter,
    transcript: [
      { kind: "input", text: `${cwd || "~"}$ ${raw}` },
      ...record.chunks.map((chunk) => ({
        kind:
          chunk.stream === "stderr"
            ? ("error" as const)
            : chunk.stream === "system"
              ? ("system" as const)
              : ("output" as const),
        text: chunk.text,
      })),
    ],
    running: record.exitCode === -1,
  };
}

export async function sendTerminalSignalToLab(
  db: Db,
  userId: string,
  signal: string,
  cwd: string,
  shell: "bash" | "zsh" | "sh" = "bash",
  sessionId?: string,
) {
  const sessionRes = await ensureLabSession(db, userId);
  if (!sessionRes.ok) throw new Error(`Lab environment unavailable: ${sessionRes.error.message}`);
  const result = await sendTerminalSignal(
    db,
    userId,
    sessionRes.value,
    signal,
    cwd,
    shell,
    sessionId,
  );
  if (!result.ok) throw new Error(result.error.message);
  return {
    accepted: true as const,
    signal,
    cwd: result.value.cwdAfter,
    running: result.value.exitCode === -1,
    transcript: result.value.chunks.map((chunk) => ({
      kind:
        chunk.stream === "stderr"
          ? ("error" as const)
          : chunk.stream === "system"
            ? ("system" as const)
            : ("output" as const),
      text: chunk.text,
    })),
  };
}

export async function sendTerminalInputToLab(
  db: Db,
  userId: string,
  data: string,
  cwd: string,
  shell: "bash" | "zsh" | "sh" = "bash",
  sessionId?: string,
) {
  const sessionRes = await ensureLabSession(db, userId);
  if (!sessionRes.ok) throw new Error(`Lab environment unavailable: ${sessionRes.error.message}`);
  const result = await executeInLab(
    db,
    userId,
    sessionRes.value,
    { kind: "stdin", data },
    cwd,
    null,
    shell,
    sessionId,
  );
  if (!result.ok) throw new Error(result.error.message);
  return {
    cwd: result.value.cwdAfter,
    running: result.value.exitCode === -1,
    transcript: result.value.chunks.map((chunk) => ({
      kind:
        chunk.stream === "stderr"
          ? ("error" as const)
          : chunk.stream === "system"
            ? ("system" as const)
            : ("output" as const),
      text: chunk.text,
    })),
  };
}

export async function assessMission(
  db: Db,
  userId: string,
  challengeId: string,
): Promise<MissionAssessment> {
  const contract = await contractFor(db, userId, challengeId);
  if (!contract) throw new Error("Unknown mission");

  const [events, attempts, skills] = await Promise.all([
    loadChallengeEvents(db, userId, challengeId),
    loadAttempts(db, userId),
    loadSkills(db, userId),
  ]);
  const attempt = attempts.find((row) => row.challenge_id === challengeId);

  const commands: AssessmentCommand[] = [];
  const observations: AssessmentObservation[] = [];
  let latestVerification: Verification | null = null;
  for (const event of events) {
    const payload = asRecord(event.payload);
    if (event.kind === "command") {
      commands.push({
        commands: stringList(payload["commands"]),
        exitCode: typeof payload["exitCode"] === "number" ? payload["exitCode"] : 0,
        mutationCount: typeof payload["mutationCount"] === "number" ? payload["mutationCount"] : 0,
        blocked: typeof payload["blocked"] === "string" ? payload["blocked"] : null,
        usedLoop: payload["usedLoop"] === true,
      });
    } else if (event.kind === "observation") {
      const observation = observationFrom([event]);
      if (observation) {
        observations.push({
          category: observation.category,
          conceptUnderstanding: observation.conceptUnderstanding,
          skillDemonstrated: observation.skillDemonstrated,
        });
      }
    } else if (event.kind === "verification") {
      const verification = verificationFrom([event]);
      if (verification) latestVerification = verification;
    }
  }

  const hints = await loadHints(db, userId, challengeId);
  const assessment = buildMissionAssessment({
    contract,
    verification: latestVerification,
    commands,
    observations,
    hintsUsed: hints.length,
    startedAt: attempt?.started_at ?? null,
    completedAt: attempt?.completed_at ?? null,
    skillMemory: skills,
  });
  const progression = decideProgression({
    skills,
    targetSkills: contract.requiredSkills,
    assessment,
  });
  const enrichedAssessment: MissionAssessment = {
    ...assessment,
    mastery: progression.mastery,
    progression,
  };

  await appendChallengeEvents(db, userId, challengeId, [
    {
      kind: "assessment",
      payload: {
        grade: assessment.grade,
        status: assessment.status,
        objectivesMet: assessment.objectivesMet,
        objectivesTotal: assessment.objectivesTotal,
        commandCount: assessment.commandCount,
        failedCommands: assessment.failedCommands,
        mistakeBreakdown: assessment.mistakeBreakdown,
        learningSignal: enrichedAssessment.learningSignal,
        progressionAction: progression.action,
        masteredSkills: progression.masteredSkills,
        fragileSkills: progression.fragileSkills,
        eligibleNextSkills: progression.eligibleNextSkills,
        trainingDecision: enrichedAssessment.trainingDecision,
      },
    },
  ]);

  return enrichedAssessment;
}

export async function runLabCommand(
  db: Db,
  userId: string,
  challengeId: string,
  raw: string,
  cwd: string,
  language: Lang,
): Promise<RunResult> {
  const contract = await contractFor(db, userId, challengeId);
  if (!contract) throw new Error("Unknown mission");

  // Execution is dispatched through the sandbox provider boundary only. The
  // engine never contains command-execution logic and never touches a host.
  const sessionRes = await ensureLabSession(db, userId);
  if (!sessionRes.ok) throw new Error(`Lab environment unavailable: ${sessionRes.error.message}`);
  const session = sessionRes.value;

  const priorEvents = await loadChallengeEvents(db, userId, challengeId);
  const hintRows = await loadHints(db, userId, challengeId);
  const hintsUsed = hintRows.length;

  const priorCommands: string[] = priorEvents
    .filter((e) => e.kind === "command")
    .flatMap((e) => stringList(asRecord(e.payload)["commands"]));
  const priorLoop = priorEvents.some(
    (e) => e.kind === "command" && asRecord(e.payload)["usedLoop"] === true,
  );

  const dispatched = await executeInLab(
    db,
    userId,
    session,
    { kind: "raw-shell", data: raw },
    cwd,
    challengeId,
  );
  if (!dispatched.ok) throw new Error(dispatched.error.message);
  const record = dispatched.value;

  // Post-execution observed state, as reported by the provider.
  const world: World = new Map(record.stateAfter.filesystem.objects.map((o) => [o.path, o]));

  const execution = {
    lines: record.chunks.map((c) => ({
      kind:
        c.stream === "stderr"
          ? ("error" as const)
          : c.stream === "system"
            ? ("system" as const)
            : ("output" as const),
      text: c.text,
    })),
    cwd: record.cwdAfter,
    blocked: record.blocked,
    exitCode: record.exitCode,
    evidence: {
      usedLoop: record.method.usedLoopConstruct,
      operations: record.method.effectiveOperations,
      invocations: record.method.invocations,
      commands: record.method.statements,
    },
    mutationCount: record.deltas.filesystem.length,
    durationMs: record.durationMs,
  };

  const evidence = {
    usedLoop: execution.evidence.usedLoop || priorLoop,
    operations: execution.evidence.operations,
    invocations: execution.evidence.invocations + priorCommands.length,
    commands: [...priorCommands, ...execution.evidence.commands],
  };

  const verification = verify(
    contract,
    world,
    {
      usedLoop: execution.evidence.usedLoop,
      operations: execution.evidence.operations,
      invocations: execution.evidence.invocations,
      commands: execution.evidence.commands,
    },
    {
      blockedReason: execution.blocked?.reason ?? null,
      hintsUsed,
    },
  );

  // Assessment uses the original command evidence; AI-facing context is
  // redacted so credentials printed by a learner's lab never become model input.
  const safeHistory = [...priorCommands, ...execution.evidence.commands].map(
    (command) => redactText(command).text,
  );
  const safeExecution = {
    ...execution,
    lines: redactLines(execution.lines).lines,
  };
  const observation = await aiObserver.observe({
    contract,
    raw: redactText(record.input).text,
    execution: safeExecution,
    verification,
    history: safeHistory,
    hintsUsed,
    language,
  });

  await appendChallengeEvents(db, userId, challengeId, [
    {
      kind: "command",
      payload: {
        raw: record.input.slice(0, 2000),
        cwdBefore: cwd.slice(0, 512),
        cwdAfter: execution.cwd.slice(0, 512),
        commands: execution.evidence.commands
          .slice(0, 20)
          .map((command) => redactText(command).text),
        usedLoop: execution.evidence.usedLoop,
        exitCode: execution.exitCode,
        mutationCount: execution.mutationCount,
        blocked: execution.blocked?.reason ?? null,
        outputAvailable: true,
      },
    },
    { kind: "observation", payload: { observation } },
    { kind: "verification", payload: { verification } },
  ]);

  // Attempt row + idempotent reward. All writes stay behind the persistence boundary.
  const attemptsRows = await loadAttempts(db, userId);
  const existing = attemptsRows.find((a) => a.challenge_id === challengeId);
  const alreadyComplete = existing?.status === "COMPLETE";
  const nowComplete = verification.status === "COMPLETE";
  const xpAwarded =
    nowComplete && !alreadyComplete && (existing?.xp_awarded ?? 0) === 0 ? contract.xpReward : 0;

  await saveAttempt(db, userId, challengeId, existing, {
    status: verification.status,
    score: verification.score,
    completed: nowComplete,
    evidence: { objectives: verification.objectives, usedLoop: evidence.usedLoop },
    xpAwarded,
  });

  if (xpAwarded > 0) await awardProgressionXp(db, userId, xpAwarded);

  if (!execution.blocked && (nowComplete || execution.mutationCount > 0)) {
    await appendNarrativeEvent(db, {
      userId,
      challengeId,
      eventType: nowComplete ? "mission_complete" : "world_change",
      summary: nowComplete
        ? `${contract.title} completed — ${contract.successStory}`
        : `Worked in the lab during ${contract.title}: ${execution.evidence.commands
            .slice(0, 3)
            .map((command) => redactText(command).text)
            .join("; ")}`,
      relatedSkillIds: contract.requiredSkills,
      importance: nowComplete ? 4 : 2,
    });
  }

  if (!execution.blocked) {
    await updateSkillMemory(db, userId, contract.requiredSkills, {
      complete: nowComplete && !alreadyComplete,
      score: verification.score,
      hintsUsed,
      mistake: observation.category && !nowComplete ? observation.category : null,
      durationMs: execution.durationMs,
      expectedMinutes: Math.max(1, contract.difficulty * 5),
      difficulty: contract.difficulty,
    });
  }

  const state = await loadMissionState(db, userId, challengeId, execution.cwd, language);

  const newLines: TerminalLine[] = [
    { kind: "input", text: `${cwd ? `~/${cwd}` : "~"}$ ${raw}` },
    ...execution.lines.map((l) => ({
      kind:
        l.kind === "error"
          ? ("error" as const)
          : l.kind === "system"
            ? ("system" as const)
            : ("output" as const),
      text: l.text,
    })),
  ];

  return {
    transcript: newLines,
    cwd: execution.cwd,
    observation,
    verification,
    xpAwarded,
    state,
  };
}
