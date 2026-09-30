import { describe, expect, it } from "vitest";
import { assessMission } from "./engine.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type Db = SupabaseClient<Database>;

function createMockDb() {
  const challengeEvents: Array<{
    id: string;
    user_id: string;
    challenge_id: string;
    kind: string;
    payload: Record<string, unknown>;
    created_at: string;
  }> = [];

  const attempts: Array<{
    id: string;
    user_id: string;
    challenge_id: string;
    status: string;
    attempts: number;
    best_score: number;
    xp_awarded: number;
    started_at: string;
    completed_at: string | null;
  }> = [];

  const skills: Array<{
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
  }> = [
    {
      id: "s1",
      user_id: "user-1",
      skill_id: "filesystem",
      mastery: 50,
      attempts: 2,
      successful_attempts: 1,
      recent_score: 80,
      recent_mistakes: [],
      hint_dependency: 10,
      last_practiced: null,
      next_review: null,
      confidence: 60,
      retention: 50,
      independence: 70,
      speed_score: 60,
      consistency: 60,
      difficulty_rating: 1,
      evidence_count: 2,
    },
  ];

  const hints: Array<{
    id: string;
    user_id: string;
    challenge_id: string;
    hint_level: number;
  }> = [];

  const mockDb = {
    from: (table: string) => {
      let filteredEvents = [...challengeEvents];
      let filteredAttempts = [...attempts];
      let filteredSkills = [...skills];
      let filteredHints = [...hints];

      const queryObj: any = {
        select: (_cols?: string) => queryObj,
        eq: (col: string, val: any) => {
          if (table === "learner_challenge_events") {
            filteredEvents = filteredEvents.filter((r) => (r as any)[col] === val);
          } else if (table === "learner_challenge_attempts") {
            filteredAttempts = filteredAttempts.filter((r) => (r as any)[col] === val);
          } else if (table === "learner_skill_memory") {
            filteredSkills = filteredSkills.filter((r) => (r as any)[col] === val);
          } else if (table === "learner_hint_usage") {
            filteredHints = filteredHints.filter((r) => (r as any)[col] === val);
          }
          return queryObj;
        },
        order: (_col: string, _opts?: any) => queryObj,
        limit: (_n: number) => queryObj,
        maybeSingle: async () => {
          const list =
            table === "learner_challenge_attempts"
              ? filteredAttempts
              : table === "learner_skill_memory"
                ? filteredSkills
                : [];
          return { data: list[0] ?? null, error: null };
        },
        insert: async (rows: any) => {
          const rowArray = Array.isArray(rows) ? rows : [rows];
          if (table === "learner_challenge_events") {
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
        then: (resolve: any) => {
          if (table === "learner_challenge_events") {
            return resolve({ data: filteredEvents, error: null });
          }
          if (table === "learner_challenge_attempts") {
            return resolve({ data: filteredAttempts, error: null });
          }
          if (table === "learner_skill_memory") {
            return resolve({ data: filteredSkills, error: null });
          }
          if (table === "learner_hint_usage") {
            return resolve({ data: filteredHints, error: null });
          }
          return resolve({ data: [], error: null });
        },
      };
      return queryObj;
    },
    // Expose raw array for test assertions
    challengeEvents,
    attempts,
    skills,
    hints,
  };

  return mockDb;
}

describe("Mission Assessment Idempotency (Step 3 Lock)", () => {
  it("1. first terminal completion creates exactly one assessment event", async () => {
    const mock = createMockDb();
    const userId = "user-1";
    const challengeId = "C01";

    // Set up prior events for successful completion of C01
    mock.challengeEvents.push(
      {
        id: "e1",
        user_id: userId,
        challenge_id: challengeId,
        kind: "command",
        payload: { commands: ["mkdir project"], exitCode: 0, mutationCount: 1 },
        created_at: "2026-09-29T10:00:00Z",
      },
      {
        id: "e2",
        user_id: userId,
        challenge_id: challengeId,
        kind: "observation",
        payload: {
          observation: {
            category: "INDEPENDENT_SOLUTION",
            conceptUnderstanding: "solid",
            skillDemonstrated: true,
            intent: "Create directory",
            approach: "mkdir",
            coaching: "Great job",
          },
        },
        created_at: "2026-09-29T10:00:01Z",
      },
      {
        id: "e3",
        user_id: userId,
        challenge_id: challengeId,
        kind: "verification",
        payload: {
          verification: {
            status: "COMPLETE",
            objectives: [{ label: "project directory exists", met: true, evidence: "present" }],
            score: 100,
            message: "Verified project directory.",
            remediation: [],
            wentWell: ["Created directory properly"],
          },
        },
        created_at: "2026-09-29T10:00:02Z",
      },
    );

    mock.attempts.push({
      id: "att-1",
      user_id: userId,
      challenge_id: challengeId,
      status: "COMPLETE",
      attempts: 1,
      best_score: 100,
      xp_awarded: 120,
      started_at: "2026-09-29T10:00:00Z",
      completed_at: "2026-09-29T10:00:02Z",
    });

    const res1 = await assessMission(mock as unknown as Db, userId, challengeId);
    expect(res1.status).toBe("COMPLETE");
    expect(res1.grade).toBe(100);

    const assessmentEvents = mock.challengeEvents.filter((e) => e.kind === "assessment");
    expect(assessmentEvents.length).toBe(1);
    expect(assessmentEvents[0]!.payload["status"]).toBe("COMPLETE");
  });

  it("2. repeating the same terminal run does not create another assessment event", async () => {
    const mock = createMockDb();
    const userId = "user-1";
    const challengeId = "C01";

    mock.challengeEvents.push(
      {
        id: "e1",
        user_id: userId,
        challenge_id: challengeId,
        kind: "command",
        payload: { commands: ["mkdir project"], exitCode: 0, mutationCount: 1 },
        created_at: "2026-09-29T10:00:00Z",
      },
      {
        id: "e2",
        user_id: userId,
        challenge_id: challengeId,
        kind: "verification",
        payload: {
          verification: {
            status: "COMPLETE",
            objectives: [{ label: "project directory exists", met: true, evidence: "present" }],
            score: 100,
            message: "Verified project directory.",
          },
        },
        created_at: "2026-09-29T10:00:02Z",
      },
    );

    mock.attempts.push({
      id: "att-1",
      user_id: userId,
      challenge_id: challengeId,
      status: "COMPLETE",
      attempts: 1,
      best_score: 100,
      xp_awarded: 120,
      started_at: "2026-09-29T10:00:00Z",
      completed_at: "2026-09-29T10:00:02Z",
    });

    // Run 1: initial assessment
    const res1 = await assessMission(mock as unknown as Db, userId, challengeId);
    expect(res1.status).toBe("COMPLETE");
    expect(mock.challengeEvents.filter((e) => e.kind === "assessment").length).toBe(1);

    // Simulate repeating the run (e.g. running another command while already complete)
    mock.challengeEvents.push({
      id: "e4",
      user_id: userId,
      challenge_id: challengeId,
      kind: "command",
      payload: { commands: ["ls"], exitCode: 0, mutationCount: 0 },
      created_at: "2026-09-29T10:01:00Z",
    });

    const res2 = await assessMission(mock as unknown as Db, userId, challengeId);
    expect(res2.status).toBe("COMPLETE");

    // Must still have exactly ONE assessment event
    const assessmentEvents = mock.challengeEvents.filter((e) => e.kind === "assessment");
    expect(assessmentEvents.length).toBe(1);
  });

  it("3. a genuinely new mission outcome can still produce a new assessment", async () => {
    const mock = createMockDb();
    const userId = "user-1";
    const challengeId = "C01";

    // Initial state: safety policy blocked
    mock.challengeEvents.push(
      {
        id: "e1",
        user_id: userId,
        challenge_id: challengeId,
        kind: "command",
        payload: { commands: ["sudo rm -rf /"], exitCode: 1, blocked: "policy" },
        created_at: "2026-09-29T10:00:00Z",
      },
      {
        id: "e2",
        user_id: userId,
        challenge_id: challengeId,
        kind: "verification",
        payload: {
          verification: {
            status: "BLOCKED_BY_SAFETY_POLICY",
            objectives: [{ label: "project directory exists", met: false, evidence: "missing" }],
            score: 0,
            message: "Blocked by safety policy",
          },
        },
        created_at: "2026-09-29T10:00:01Z",
      },
    );

    // Initial assessment for blocked state
    const res1 = await assessMission(mock as unknown as Db, userId, challengeId);
    expect(res1.status).toBe("BLOCKED_BY_SAFETY_POLICY");
    expect(mock.challengeEvents.filter((e) => e.kind === "assessment").length).toBe(1);

    // Now learner performs a new command that completes the mission!
    mock.challengeEvents.push(
      {
        id: "e4",
        user_id: userId,
        challenge_id: challengeId,
        kind: "command",
        payload: { commands: ["mkdir project"], exitCode: 0, mutationCount: 1 },
        created_at: "2026-09-29T10:01:00Z",
      },
      {
        id: "e5",
        user_id: userId,
        challenge_id: challengeId,
        kind: "verification",
        payload: {
          verification: {
            status: "COMPLETE",
            objectives: [{ label: "project directory exists", met: true, evidence: "present" }],
            score: 100,
            message: "Verified project directory.",
          },
        },
        created_at: "2026-09-29T10:01:02Z",
      },
    );

    const res2 = await assessMission(mock as unknown as Db, userId, challengeId);
    expect(res2.status).toBe("COMPLETE");

    // A genuinely new outcome MUST produce a new assessment event
    const assessmentEvents = mock.challengeEvents.filter((e) => e.kind === "assessment");
    expect(assessmentEvents.length).toBe(2);
    expect(assessmentEvents[0]!.payload["status"]).toBe("BLOCKED_BY_SAFETY_POLICY");
    expect(assessmentEvents[1]!.payload["status"]).toBe("COMPLETE");
  });

  it("4. trainingDecision is not duplicated or mutated incorrectly", async () => {
    const mock = createMockDb();
    const userId = "user-1";
    const challengeId = "C01";

    mock.challengeEvents.push(
      {
        id: "e1",
        user_id: userId,
        challenge_id: challengeId,
        kind: "command",
        payload: { commands: ["mkdir project"], exitCode: 0, mutationCount: 1 },
        created_at: "2026-09-29T10:00:00Z",
      },
      {
        id: "e2",
        user_id: userId,
        challenge_id: challengeId,
        kind: "verification",
        payload: {
          verification: {
            status: "COMPLETE",
            objectives: [{ label: "project directory exists", met: true, evidence: "present" }],
            score: 100,
            message: "Verified project directory.",
          },
        },
        created_at: "2026-09-29T10:00:02Z",
      },
    );

    const res1 = await assessMission(mock as unknown as Db, userId, challengeId);
    expect(res1.trainingDecision).toBeDefined();
    const decision1 = res1.trainingDecision!;

    // Second call with equivalent outcome returns the preserved trainingDecision
    const res2 = await assessMission(mock as unknown as Db, userId, challengeId);
    expect(res2.trainingDecision).toBeDefined();
    expect(res2.trainingDecision).toEqual(decision1);

    // Event count remains 1
    expect(mock.challengeEvents.filter((e) => e.kind === "assessment").length).toBe(1);
  });

  it("5. verifier result remains authoritative", async () => {
    const mock = createMockDb();
    const userId = "user-1";
    const challengeId = "C01";

    // Verification says RESULT_CORRECT_SKILL_NOT_DEMONSTRATED
    mock.challengeEvents.push(
      {
        id: "e1",
        user_id: userId,
        challenge_id: challengeId,
        kind: "command",
        payload: { commands: ["touch file"], exitCode: 0 },
        created_at: "2026-09-29T10:00:00Z",
      },
      {
        id: "e2",
        user_id: userId,
        challenge_id: challengeId,
        kind: "verification",
        payload: {
          verification: {
            status: "RESULT_CORRECT_SKILL_NOT_DEMONSTRATED",
            objectives: [{ label: "project directory exists", met: false, evidence: "missing" }],
            score: 25,
            message: "Target directory not created",
          },
        },
        created_at: "2026-09-29T10:00:02Z",
      },
    );

    const res = await assessMission(mock as unknown as Db, userId, challengeId);

    // The assessment status and grade strictly reflect the verifier output
    expect(res.status).toBe("RESULT_CORRECT_SKILL_NOT_DEMONSTRATED");
    expect(res.grade).toBe(25);
    expect(res.objectivesMet).toBe(0);
    expect(res.objectivesTotal).toBe(1);
  });
});
