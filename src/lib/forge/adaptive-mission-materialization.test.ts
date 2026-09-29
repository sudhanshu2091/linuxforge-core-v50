import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  assessMission,
  loadMissionState,
  pickNext,
  startOrRestoreMission,
} from "./engine.server";
import { persistValidatedAdaptiveMission } from "./persistence.server";
import {
  buildAdaptiveMissionCandidate,
  createDeterministicCandidate,
} from "@/lib/ai/adaptive-mission-bridge";
import type { SkillMemoryView } from "./types";
import { CONTRACTS } from "./contracts.server";
import type { MissionBlueprint } from "@/lib/ai/mission-generator";

type Db = SupabaseClient<Database>;

function createMockDb(initialData?: {
  generatedExercises?: Array<{
    id: string;
    user_id: string;
    kind: string;
    title: string;
    definition: Record<string, unknown>;
    created_at: string;
    updated_at: string;
  }>;
  attempts?: Array<{
    id: string;
    user_id: string;
    challenge_id: string;
    status: string;
    attempts: number;
    best_score: number;
    xp_awarded: number;
    started_at: string;
    completed_at: string | null;
    updated_at: string;
  }>;
  skills?: Array<{
    id: string;
    user_id: string;
    skill_id: string;
    mastery: number;
    attempts: number;
    successful_attempts: number;
    recent_score: number | null;
    recent_mistakes: string[];
    hint_dependency: number;
    last_practiced: string | null;
    next_review: string | null;
    confidence: number;
    retention: number;
    independence: number;
    speed_score: number;
    consistency: number;
    difficulty_rating: number;
    evidence_count: number;
  }>;
  worldObjects?: Array<{
    id: string;
    user_id: string;
    lab_id: string;
    name: string;
    path: string;
    object_type: string;
    permissions: string;
    content: string;
    active: boolean;
    created_at: string;
    updated_at: string;
  }>;
  challengeEvents?: Array<{
    id: string;
    user_id: string;
    challenge_id: string;
    kind: string;
    payload: Record<string, unknown>;
    created_at: string;
  }>;
}) {
  const generatedExercises = [...(initialData?.generatedExercises ?? [])];
  const attempts = [...(initialData?.attempts ?? [])];
  const skills = [
    ...(initialData?.skills ?? [
      {
        id: "s1",
        user_id: "user-test",
        skill_id: "filesystem",
        mastery: 80,
        attempts: 3,
        successful_attempts: 3,
        recent_score: 90,
        recent_mistakes: [],
        hint_dependency: 0,
        last_practiced: null,
        next_review: null,
        confidence: 80,
        retention: 75,
        independence: 80,
        speed_score: 70,
        consistency: 75,
        difficulty_rating: 1,
        evidence_count: 3,
      },
      {
        id: "s2",
        user_id: "user-test",
        skill_id: "permissions",
        mastery: 35,
        attempts: 2,
        successful_attempts: 0,
        recent_score: 40,
        recent_mistakes: ["WRONG_ARGUMENT"],
        hint_dependency: 60,
        last_practiced: null,
        next_review: null,
        confidence: 30,
        retention: 35,
        independence: 40,
        speed_score: 40,
        consistency: 35,
        difficulty_rating: 2,
        evidence_count: 2,
      },
    ]),
  ];
  const hints: Array<{ id: string; user_id: string; challenge_id: string; hint_level: number }> =
    [];
  const challengeEvents = [...(initialData?.challengeEvents ?? [])];
  const worldObjects = [
    ...(initialData?.worldObjects ?? [
      {
        id: "wo-1",
        user_id: "user-test",
        lab_id: "lab-1",
        name: "audit.log",
        path: "workspace/audit.log",
        object_type: "file",
        permissions: "644",
        content: "sample",
        active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]),
  ];
  const labs = [
    {
      id: "lab-1",
      user_id: "user-test",
      lab_key: "forge-core",
      title: "Forge training lab",
    },
  ];
  const progression = [
    {
      id: "p-1",
      user_id: "user-test",
      total_xp: 150,
      level: 1,
      challenges_completed: 1,
      labs_completed: 1,
    },
  ];

  const mockDb = {
    from: (table: string) => {
      let filteredGen = [...generatedExercises];
      let filteredAttempts = [...attempts];
      let filteredSkills = [...skills];
      let filteredHints = [...hints];
      let filteredEvents = [...challengeEvents];
      let filteredWorld = [...worldObjects];
      let filteredLabs = [...labs];
      let filteredProg = [...progression];

      const queryObj: any = {
        select: (_cols?: string) => queryObj,
        eq: (col: string, val: any) => {
          if (table === "generated_exercises") {
            filteredGen = filteredGen.filter((r) => (r as any)[col] === val);
          } else if (table === "learner_challenge_attempts") {
            filteredAttempts = filteredAttempts.filter((r) => (r as any)[col] === val);
          } else if (table === "learner_skill_memory") {
            filteredSkills = filteredSkills.filter((r) => (r as any)[col] === val);
          } else if (table === "learner_hint_usage") {
            filteredHints = filteredHints.filter((r) => (r as any)[col] === val);
          } else if (table === "learner_challenge_events") {
            filteredEvents = filteredEvents.filter((r) => (r as any)[col] === val);
          } else if (table === "lab_world_objects") {
            filteredWorld = filteredWorld.filter((r) => (r as any)[col] === val);
          } else if (table === "learner_labs") {
            filteredLabs = filteredLabs.filter((r) => (r as any)[col] === val);
          } else if (table === "learner_progression") {
            filteredProg = filteredProg.filter((r) => (r as any)[col] === val);
          }
          return queryObj;
        },
        in: (col: string, vals: any[]) => {
          if (table === "generated_exercises") {
            filteredGen = filteredGen.filter((r) => vals.includes((r as any)[col]));
          }
          return queryObj;
        },
        order: (_col: string, _opts?: any) => queryObj,
        limit: (_n: number) => queryObj,
        maybeSingle: async () => {
          if (table === "generated_exercises") return { data: filteredGen[0] ?? null, error: null };
          if (table === "learner_challenge_attempts")
            return { data: filteredAttempts[0] ?? null, error: null };
          if (table === "learner_skill_memory")
            return { data: filteredSkills[0] ?? null, error: null };
          if (table === "learner_labs") return { data: filteredLabs[0] ?? null, error: null };
          if (table === "learner_progression")
            return { data: filteredProg[0] ?? null, error: null };
          return { data: null, error: null };
        },
        single: async () => {
          if (table === "learner_labs") return { data: filteredLabs[0] ?? null, error: null };
          if (table === "learner_progression")
            return { data: filteredProg[0] ?? null, error: null };
          return { data: null, error: null };
        },
        insert: async (rows: any) => {
          const rowArray = Array.isArray(rows) ? rows : [rows];
          if (table === "generated_exercises") {
            for (const r of rowArray) {
              generatedExercises.push({
                id: r.id,
                user_id: r.user_id,
                kind: r.kind,
                title: r.title,
                definition: r.definition,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              });
            }
          } else if (table === "learner_challenge_attempts") {
            for (const r of rowArray) {
              attempts.push({
                id: `att-${attempts.length + 1}`,
                user_id: r.user_id,
                challenge_id: r.challenge_id,
                status: r.status,
                attempts: 1,
                best_score: 0,
                xp_awarded: 0,
                started_at: new Date().toISOString(),
                completed_at: null,
                updated_at: new Date().toISOString(),
              });
            }
          } else if (table === "learner_challenge_events") {
            for (const r of rowArray) {
              challengeEvents.push({
                id: `ev-${challengeEvents.length + 1}`,
                user_id: r.user_id,
                challenge_id: r.challenge_id,
                kind: r.kind,
                payload: r.payload,
                created_at: new Date().toISOString(),
              });
            }
          }
          return { data: null, error: null };
        },
        update: (_updates: any) => queryObj,
        then: (resolve: any) => {
          if (table === "generated_exercises")
            return resolve({ data: filteredGen, error: null });
          if (table === "learner_challenge_attempts")
            return resolve({ data: filteredAttempts, error: null });
          if (table === "learner_skill_memory")
            return resolve({ data: filteredSkills, error: null });
          if (table === "learner_hint_usage")
            return resolve({ data: filteredHints, error: null });
          if (table === "learner_challenge_events")
            return resolve({ data: filteredEvents, error: null });
          if (table === "lab_world_objects")
            return resolve({ data: filteredWorld, error: null });
          if (table === "learning_narrative_events")
            return resolve({ data: [], error: null });
          if (table === "lab_command_events")
            return resolve({ data: [], error: null });
          return resolve({ data: [], error: null });
        },
      };
      return queryObj;
    },
    generatedExercises,
    attempts,
    skills,
    challengeEvents,
    worldObjects,
  };

  return mockDb as unknown as Db & {
    generatedExercises: typeof generatedExercises;
    attempts: typeof attempts;
    skills: typeof skills;
    challengeEvents: typeof challengeEvents;
    worldObjects: typeof worldObjects;
  };
}

describe("LinuxForge Step 4: Adaptive Mission Materialization & Launch", () => {
  const mockSkills: SkillMemoryView[] = [
    {
      skillId: "filesystem",
      mastery: 85,
      attempts: 4,
      successfulAttempts: 4,
      recentScore: 90,
      recentMistakes: [],
      hintDependency: 10,
      lastPracticed: null,
      nextReview: null,
      confidence: 80,
      evidenceCount: 4,
    },
    {
      skillId: "permissions",
      mastery: 40,
      attempts: 3,
      successfulAttempts: 1,
      recentScore: 45,
      recentMistakes: ["WRONG_ARGUMENT"],
      hintDependency: 50,
      lastPracticed: null,
      nextReview: null,
      confidence: 35,
      evidenceCount: 3,
    },
  ];

  it("1. valid adaptive candidate is materialized into generated_exercises", async () => {
    const db = createMockDb();
    const candidate = buildAdaptiveMissionCandidate({
      skills: mockSkills,
      recentMistakes: ["WRONG_ARGUMENT"],
      currentDifficulty: 2,
    });

    expect(candidate.validation.ok).toBe(true);
    expect(candidate.contract).toBeDefined();
    expect(candidate.exercise).toBeDefined();

    const result = await persistValidatedAdaptiveMission(db, "user-test", candidate);

    expect(result.materialized).toBe(true);
    expect(result.challengeId).toBe(candidate.exercise?.id);
    expect(result.resumed).toBe(false);
    expect(db.generatedExercises).toHaveLength(1);
    expect(db.generatedExercises[0]?.id).toBe(candidate.exercise?.id);
  });

  it("2. invalid V2 candidate is NOT persisted", async () => {
    const db = createMockDb();
    const candidate = buildAdaptiveMissionCandidate({
      skills: mockSkills,
      currentDifficulty: 1,
    });

    // Mark as invalid validation result
    const invalidCandidate = {
      ...candidate,
      validation: {
        ok: false as const,
        reason: "SCHEMA_INVALID" as const,
        reasons: ["Invalid schema"],
        repairAttempts: 0,
      },
      contract: undefined,
    };

    const result = await persistValidatedAdaptiveMission(db, "user-test", invalidCandidate);

    expect(result.materialized).toBe(false);
    expect(result.reason).toBe("candidate_not_validated");
    expect(db.generatedExercises).toHaveLength(0);
  });

  it("3. materialization is idempotent and does not create duplicate entries", async () => {
    const db = createMockDb();
    const candidate = buildAdaptiveMissionCandidate({
      skills: mockSkills,
      currentDifficulty: 1,
    });

    const first = await persistValidatedAdaptiveMission(db, "user-test", candidate);
    expect(first.materialized).toBe(true);
    expect(first.resumed).toBe(false);
    expect(db.generatedExercises).toHaveLength(1);

    const second = await persistValidatedAdaptiveMission(db, "user-test", candidate);
    expect(second.materialized).toBe(true);
    expect(second.resumed).toBe(true);
    expect(db.generatedExercises).toHaveLength(1);
  });

  it("4. assessMission produces training decision and automatically materializes adaptive mission", async () => {
    const db = createMockDb({
      challengeEvents: [
        {
          id: "ev-1",
          user_id: "user-test",
          challenge_id: "C01",
          kind: "verification",
          payload: {
            verification: {
              status: "COMPLETE",
              objectives: [{ label: "verify", met: true, evidence: "ok" }],
              score: 100,
              message: "Verified",
              remediation: [],
              wentWell: ["Clean run"],
            },
          },
          created_at: new Date().toISOString(),
        },
      ],
    });

    const assessment = await assessMission(db, "user-test", "C01");

    expect(assessment.trainingDecision).toBeDefined();
    expect(db.generatedExercises.length).toBeGreaterThan(0);
    expect(db.generatedExercises[0]?.id).toContain("adaptive-");
  });

  it("5. adaptive mission is selected before static curriculum fallback", async () => {
    const candidate = buildAdaptiveMissionCandidate({
      skills: mockSkills,
      currentDifficulty: 2,
    });

    const db = createMockDb({
      attempts: [
        {
          id: "att-1",
          user_id: "user-test",
          challenge_id: "filesystem-journey-1",
          status: "COMPLETE",
          attempts: 1,
          best_score: 100,
          xp_awarded: 100,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
    });

    // Materialize candidate whose prerequisites (filesystem) are satisfied
    await persistValidatedAdaptiveMission(db, "user-test", candidate);

    const launch = await startOrRestoreMission(db, "user-test");

    expect(launch.challengeId).toBe(candidate.exercise?.id);
    expect(launch.resumed).toBe(false);
  });

  it("6. adaptive mission with unmet prerequisites is NOT launched", async () => {
    const candidate = buildAdaptiveMissionCandidate({
      skills: mockSkills,
      currentDifficulty: 2,
    });

    // Notice: NO completed attempts in db and unmastered skills, so prerequisites (filesystem) are UNMET
    const db = createMockDb({
      attempts: [],
      skills: [
        {
          id: "s1",
          user_id: "user-test",
          skill_id: "filesystem",
          mastery: 10,
          attempts: 1,
          successful_attempts: 0,
          recent_score: 10,
          recent_mistakes: ["WRONG_COMMAND"],
          hint_dependency: 100,
          last_practiced: null,
          next_review: null,
          confidence: 10,
          retention: 0,
          independence: 0,
          speed_score: 0,
          consistency: 0,
          difficulty_rating: 1,
          evidence_count: 1,
        },
      ],
    });

    await persistValidatedAdaptiveMission(db, "user-test", candidate);

    // Default start should NOT launch the adaptive mission because its prerequisites are unmet
    const launch = await startOrRestoreMission(db, "user-test");
    expect(launch.challengeId).not.toBe(candidate.exercise?.id);
    expect(launch.challengeId).toBe(CONTRACTS[0]?.id);

    // Direct requested start with unmet prerequisites must throw
    await expect(
      startOrRestoreMission(db, "user-test", candidate.exercise?.id),
    ).rejects.toThrow(/Mission is locked/i);
  });

  it("7. existing incomplete adaptive mission is resumed", async () => {
    const candidate = buildAdaptiveMissionCandidate({
      skills: mockSkills,
      currentDifficulty: 2,
    });

    const candidateId = candidate.exercise!.id;

    const db = createMockDb({
      attempts: [
        {
          id: "att-1",
          user_id: "user-test",
          challenge_id: "filesystem-journey-1",
          status: "COMPLETE",
          attempts: 1,
          best_score: 100,
          xp_awarded: 100,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        {
          id: "att-adaptive",
          user_id: "user-test",
          challenge_id: candidateId,
          status: "INCOMPLETE",
          attempts: 1,
          best_score: 40,
          xp_awarded: 0,
          started_at: new Date().toISOString(),
          completed_at: null,
          updated_at: new Date().toISOString(),
        },
      ],
    });

    await persistValidatedAdaptiveMission(db, "user-test", candidate);

    const launch = await startOrRestoreMission(db, "user-test");

    expect(launch.challengeId).toBe(candidateId);
    expect(launch.resumed).toBe(true);
  });

  it("8. completed adaptive mission is not repeatedly regenerated or launched", async () => {
    const candidate = buildAdaptiveMissionCandidate({
      skills: mockSkills,
      currentDifficulty: 2,
    });
    const candidateId = candidate.exercise!.id;

    const db = createMockDb({
      attempts: [
        {
          id: "att-1",
          user_id: "user-test",
          challenge_id: "filesystem-journey-1",
          status: "COMPLETE",
          attempts: 1,
          best_score: 100,
          xp_awarded: 100,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        {
          id: "att-adaptive",
          user_id: "user-test",
          challenge_id: candidateId,
          status: "COMPLETE",
          attempts: 2,
          best_score: 100,
          xp_awarded: 150,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
    });

    await persistValidatedAdaptiveMission(db, "user-test", candidate);

    const launch = await startOrRestoreMission(db, "user-test");

    // Must NOT launch the completed adaptive mission again
    expect(launch.challengeId).not.toBe(candidateId);
  });

  it("9. static curriculum still works when no adaptive candidate exists", async () => {
    const db = createMockDb({
      generatedExercises: [],
      attempts: [],
    });

    const launch = await startOrRestoreMission(db, "user-test");

    expect(launch.challengeId).toBe(CONTRACTS[0]?.id);
    expect(launch.resumed).toBe(false);
  });

  it("10. requested explicit challengeId continues to work for static and generated", async () => {
    const candidate = buildAdaptiveMissionCandidate({
      skills: mockSkills,
      currentDifficulty: 1,
    });

    const db = createMockDb({
      attempts: [
        {
          id: "att-filesystem",
          user_id: "user-test",
          challenge_id: "filesystem-journey-1",
          status: "COMPLETE",
          attempts: 1,
          best_score: 100,
          xp_awarded: 100,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
    });
    await persistValidatedAdaptiveMission(db, "user-test", candidate);

    // Static request
    const staticLaunch = await startOrRestoreMission(db, "user-test", CONTRACTS[0]?.id);
    expect(staticLaunch.challengeId).toBe(CONTRACTS[0]?.id);

    // Generated request
    const generatedLaunch = await startOrRestoreMission(db, "user-test", candidate.exercise?.id);
    expect(generatedLaunch.challengeId).toBe(candidate.exercise?.id);
  });

  it("11. mission-state reads do not create new adaptive missions", async () => {
    const db = createMockDb({
      generatedExercises: [],
    });

    const initialCount = db.generatedExercises.length;
    await loadMissionState(db, "user-test", "C01", "/home/learner", "English");

    expect(db.generatedExercises.length).toBe(initialCount);
  });

  it("12. assessment idempotency does not recursively regenerate missions", async () => {
    const db = createMockDb({
      challengeEvents: [
        {
          id: "ev-1",
          user_id: "user-test",
          challenge_id: "C01",
          kind: "verification",
          payload: {
            verification: {
              status: "COMPLETE",
              objectives: [{ label: "verify", met: true, evidence: "ok" }],
              score: 100,
              message: "Verified",
              remediation: [],
              wentWell: ["Clean run"],
            },
          },
          created_at: new Date().toISOString(),
        },
      ],
    });

    await assessMission(db, "user-test", "C01");
    const countAfterFirst = db.generatedExercises.length;

    // Second call with same state
    await assessMission(db, "user-test", "C01");
    const countAfterSecond = db.generatedExercises.length;

    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it("13. adaptive mission preserves required skills, difficulty, and prerequisites", async () => {
    const db = createMockDb();
    const candidate = buildAdaptiveMissionCandidate({
      skills: mockSkills,
      currentDifficulty: 2,
    });

    await persistValidatedAdaptiveMission(db, "user-test", candidate);

    const stored = db.generatedExercises[0];
    expect(stored).toBeDefined();

    const def = stored?.definition as any;
    expect(def.id).toBe(candidate.exercise?.id);
    expect(def.skills).toEqual(candidate.exercise?.skills);
    expect(def.difficulty).toBe(candidate.exercise?.difficulty);
    expect(def.prerequisites).toEqual(candidate.contract?.prerequisites);
  });

  it("14. pickNext scores open adaptive mission with bonus over static fallback", () => {
    const candidate = buildAdaptiveMissionCandidate({
      skills: mockSkills,
      currentDifficulty: 2,
    });

    const attempts = [
      {
        id: "att-1",
        user_id: "user-test",
        challenge_id: "filesystem-journey-1",
        status: "COMPLETE",
        attempts: 1,
        best_score: 100,
        xp_awarded: 100,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    const nextId = pickNext(
      attempts as any,
      mockSkills,
      "filesystem-journey-1",
      [candidate.contract!],
      candidate.trainingDecision,
    );

    expect(nextId).toBe(candidate.contract?.id);
  });

  it("15. real world scenario artifacts are passed to candidate when available", async () => {
    const db = createMockDb({
      worldObjects: [
        {
          id: "wo-custom",
          user_id: "user-test",
          lab_id: "lab-1",
          name: "security_evidence.txt",
          path: "workspace/security_evidence.txt",
          object_type: "file",
          permissions: "600",
          content: "logged",
          active: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
      challengeEvents: [
        {
          id: "ev-1",
          user_id: "user-test",
          challenge_id: "C01",
          kind: "verification",
          payload: {
            verification: {
              status: "COMPLETE",
              objectives: [{ label: "verify", met: true, evidence: "ok" }],
              score: 100,
              message: "Verified",
              remediation: [],
              wentWell: ["Clean run"],
            },
          },
          created_at: new Date().toISOString(),
        },
      ],
    });

    await assessMission(db, "user-test", "C01");

    expect(db.generatedExercises.length).toBeGreaterThan(0);
    const storedDef = db.generatedExercises[0]?.definition as any;
    expect(storedDef).toBeDefined();
    // Known scenario artifacts preserved in continuity references
    expect(storedDef.previousReferences).toBeDefined();
  });
});
