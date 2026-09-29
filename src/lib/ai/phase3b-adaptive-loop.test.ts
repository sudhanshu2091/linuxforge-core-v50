import { describe, expect, it } from "vitest";
import { buildMissionAssessment } from "@/lib/forge/assessment.server";
import { pickNext } from "@/lib/forge/engine.server";
import { selectAdaptiveTraining } from "@/lib/ai/adaptive-training";
import { analyzeLearner } from "@/lib/ai/learner-intelligence";
import { buildMissionTutorContext } from "@/lib/ai/tutor-context";
import { decideDynamicTeaching } from "@/lib/ai/dynamic-teaching";
import type {
  AttemptView,
  ChallengeBrief,
  LearnerContext,
  MissionAssessment,
  MissionState,
  Observation,
  SkillMemoryView,
  TerminalLine,
  Verification,
} from "@/lib/forge/types";

const mockVerification: Verification = {
  status: "COMPLETE",
  objectives: [{ label: "workspace ready", met: true, evidence: "directory found" }],
  score: 100,
  message: "Verification passed",
  remediation: [],
  wentWell: ["Directory created cleanly"],
};

const mockSkill = (overrides: Partial<SkillMemoryView> = {}): SkillMemoryView => ({
  skillId: "filesystem",
  mastery: 50,
  attempts: 4,
  successfulAttempts: 2,
  recentScore: 60,
  recentMistakes: [],
  hintDependency: 20,
  lastPracticed: null,
  nextReview: null,
  confidence: 50,
  retention: 50,
  independence: 65,
  evidenceCount: 4,
  ...overrides,
});

const mockBrief: ChallengeBrief = {
  id: "ch-01-pwd-whoami",
  order: 1,
  title: "Identity and Orientation",
  storyIntro: "Find out where you are and who you are.",
  objective: "Run pwd and whoami to orient yourself in the system.",
  requiredSkills: ["filesystem"],
  allowedApproaches: ["pwd", "whoami"],
  bannedShortcuts: [],
  difficulty: 1,
  prerequisites: [],
  previousReferences: [],
  xpReward: 100,
  hintLevels: 3,
};

const mockAttempt: AttemptView = {
  challengeId: "ch-01-pwd-whoami",
  status: "COMPLETE",
  attempts: 1,
  bestScore: 100,
  xpAwarded: 100,
  startedAt: "2026-09-29T10:00:00.000Z",
  completedAt: "2026-09-29T10:01:00.000Z",
};

const mockContext: LearnerContext = {
  learner_level: 1,
  current_mastery: { filesystem: 50 },
  weak_skills: ["filesystem"],
  strong_skills: [],
  recent_mistakes: [],
  recent_challenges: [],
  relevant_previous_objects: [],
  relevant_story_events: [],
  current_lab_state: { labTitle: "Default Lab", cwd: "", objects: [] },
  prerequisites: [],
  desired_difficulty: 1,
};

describe("Phase 3B — Integrated Adaptive Loop", () => {
  it("1. buildMissionAssessment produces consistent enriched assessment with trainingDecision", () => {
    const assessment = buildMissionAssessment({
      contract: { difficulty: 1, requiredSkills: ["filesystem"] },
      verification: mockVerification,
      commands: [
        {
          commands: ["mkdir workspace"],
          exitCode: 0,
          mutationCount: 1,
          blocked: null,
          usedLoop: false,
        },
      ],
      observations: [
        {
          category: "INDEPENDENT_SOLUTION",
          conceptUnderstanding: "solid",
          skillDemonstrated: true,
        },
      ],
      hintsUsed: 0,
      startedAt: "2026-09-29T10:00:00.000Z",
      completedAt: "2026-09-29T10:01:00.000Z",
      now: new Date("2026-09-29T10:01:00.000Z"),
      skillMemory: [mockSkill({ mastery: 85, independence: 80, hintDependency: 10 })],
    });

    expect(assessment.grade).toBe(100);
    expect(assessment.learningSignal).toBe("mastered");
    expect(assessment.trainingDecision).toBeDefined();
    expect(assessment.trainingDecision?.primarySkill).toBeDefined();
    expect(assessment.trainingDecision?.mode).toBeDefined();
    expect(assessment.evidenceQuality.cleanExecution).toBe(true);
  });

  it("2. pickNext prioritizes trainingDecision primarySkill and desired difficulty", () => {
    const attempts = [
      {
        user_id: "user-1",
        challenge_id: "ch-01-pwd-whoami",
        status: "COMPLETE",
        best_score: 100,
        attempts: 1,
        xp_awarded: 100,
        created_at: "2026-09-29T10:00:00.000Z",
        updated_at: "2026-09-29T10:01:00.000Z",
        started_at: "2026-09-29T10:00:00.000Z",
        completed_at: "2026-09-29T10:01:00.000Z",
        evidence: null,
      },
    ];

    const decision = selectAdaptiveTraining({
      skills: [
        mockSkill({ skillId: "filesystem", mastery: 90, confidence: 90 }),
        mockSkill({ skillId: "permissions", mastery: 20, confidence: 20 }),
      ],
      intelligence: analyzeLearner([
        mockSkill({ skillId: "filesystem", mastery: 90, confidence: 90 }),
        mockSkill({ skillId: "permissions", mastery: 20, confidence: 20 }),
      ]),
      currentDifficulty: 1,
    });

    const nextId = pickNext(
      attempts as any,
      [mockSkill({ skillId: "permissions", mastery: 20 })],
      "ch-01-pwd-whoami",
      [],
      decision,
    );

    expect(nextId).toBeDefined();
    expect(typeof nextId).toBe("string");
    expect(nextId).not.toBe("ch-01-pwd-whoami");
  });

  it("3. pickNext falls back gracefully when intelligence fails or skills are empty", () => {
    const nextId = pickNext([], [], "unknown-id", [], null);
    expect(nextId).toBe("C01");
  });

  describe("4. ObservationCategory impacts selectAdaptiveTraining decisions deterministically", () => {
    it("handles SKILL_BYPASS -> GUIDED_PRACTICE with explicit method evidence constraint", () => {
      const skills = [mockSkill({ recentMistakes: ["SKILL_BYPASS"] })];
      const intelligence = analyzeLearner(skills, ["SKILL_BYPASS"]);
      const decision = selectAdaptiveTraining({
        skills,
        intelligence,
        currentDifficulty: 2,
      });

      expect(decision.mode).toBe("GUIDED_PRACTICE");
      expect(decision.constraints.some((c) => c.toLowerCase().includes("method evidence"))).toBe(
        true,
      );
      expect(decision.reason.toLowerCase()).toContain("bypassed");
    });

    it("handles UNSAFE_APPROACH -> REMEDIATION with lab safety constraint", () => {
      const skills = [mockSkill({ recentMistakes: ["UNSAFE_APPROACH"] })];
      const intelligence = analyzeLearner(skills, ["UNSAFE_APPROACH"]);
      const decision = selectAdaptiveTraining({
        skills,
        intelligence,
        currentDifficulty: 2,
      });

      expect(decision.mode).toBe("REMEDIATION");
      expect(decision.constraints.some((c) => c.toLowerCase().includes("isolated lab"))).toBe(true);
    });

    it("handles TYPO -> GUIDED_PRACTICE without sharp difficulty drop on good grade", () => {
      const skills = [mockSkill({ recentMistakes: ["TYPO"] })];
      const intelligence = analyzeLearner(skills, ["TYPO"]);
      const decision = selectAdaptiveTraining({
        skills,
        intelligence,
        assessment: {
          learningSignal: "progressing",
          grade: 75,
          mistakeBreakdown: [{ category: "TYPO", count: 1 }],
          hintsUsed: 1,
        },
        currentDifficulty: 3,
      });

      expect(decision.mode).toBe("GUIDED_PRACTICE");
      expect(decision.difficulty).toBe(3);
      expect(decision.constraints.some((c) => c.toLowerCase().includes("typing"))).toBe(true);
    });

    it("handles INDEPENDENT_SOLUTION -> PROGRESSION with increased difficulty", () => {
      const skills = [
        mockSkill({
          mastery: 92,
          confidence: 90,
          retention: 92,
          independence: 90,
          hintDependency: 10,
          recentScore: 95,
          successfulAttempts: 5,
        }),
      ];
      const intelligence = analyzeLearner(skills);
      const decision = selectAdaptiveTraining({
        skills,
        intelligence,
        assessment: {
          learningSignal: "mastered",
          grade: 95,
          mistakeBreakdown: [],
          hintsUsed: 0,
        },
        currentDifficulty: 2,
      });

      expect(decision.mode).toBe("PROGRESSION");
      expect(decision.difficulty).toBeGreaterThanOrEqual(3);
    });
  });

  it("5. Tutor context includes adaptive training decision and observation signals", () => {
    const mockObs: Observation = {
      intent: "Inspect files in home directory",
      approach: "Direct ls call",
      skillTarget: ["filesystem"],
      category: "INDEPENDENT_SOLUTION",
      conceptUnderstanding: "solid",
      skillDemonstrated: true,
      coaching: "Clean execution with no wasted steps.",
    };

    const state: MissionState = {
      challenge: mockBrief,
      context: mockContext,
      attempt: mockAttempt,
      catalogue: [{ ...mockBrief, attempt: mockAttempt, unlocked: true }],
      transcript: [
        { kind: "input", text: "pwd" },
        { kind: "output", text: "/home/learner" },
      ],
      cwd: "",
      hints: [{ level: 1, text: "Check your current working directory." }],
      hintsRemaining: 2,
      skills: [mockSkill()],
      progression: { totalXp: 100, level: 1, challengesCompleted: 1 },
      lastVerification: mockVerification,
      lastObservation: mockObs,
      nextChallengeId: "ch-02-ls-cd",
      trainingDecision: {
        version: "v37" as const,
        mode: "PROGRESSION",
        primarySkill: "filesystem",
        supportingSkills: [],
        difficulty: 2,
        reason: "Clean independent completion.",
        evidence: ["grade 100"],
        focusMistakes: [],
        constraints: ["Increase complexity"],
        masteryGate: "ADVANCE",
        journeyPhase: "Linux Foundations",
        journeyNextSkills: ["iteration"],
      },
    };

    const tutorContext = buildMissionTutorContext(state);

    expect(tutorContext.adaptive).toBeDefined();
    expect(tutorContext.adaptive?.mode).toBe("PROGRESSION");
    expect(tutorContext.adaptive?.primarySkill).toBe("filesystem");
    expect(tutorContext.run.observation?.category).toBe("INDEPENDENT_SOLUTION");
    expect(tutorContext.teaching.strategy).toBeDefined();
  });

  it("6. Dynamic teaching adapts hintPolicy and pacing to mode and dependency", () => {
    const intelligence = analyzeLearner([mockSkill({ hintDependency: 70 })]);

    const remediationDecision = decideDynamicTeaching({
      session: {
        phase: "PRACTICE",
        plan: {
          mode: "REMEDIATION",
          primarySkill: "filesystem",
          supportingSkills: [],
          difficulty: 1,
        } as any,
      },
      intelligence: {
        ...intelligence,
        signals: ["CONCEPT_GAP"],
      },
    });

    expect(remediationDecision.pacing).toBe("DEEP");
    expect(remediationDecision.strategy).toBe("GUIDED_DISCOVERY");

    const progressionDecision = decideDynamicTeaching({
      session: {
        phase: "VERIFY",
        plan: {
          mode: "PROGRESSION",
          primarySkill: "filesystem",
          supportingSkills: [],
          difficulty: 3,
        } as any,
      },
      intelligence: {
        ...intelligence,
        signals: ["INDEPENDENT"],
        readiness: 85,
        independence: 85,
        hintDependency: 15,
      },
    });

    expect(progressionDecision.hintPolicy).toBe("MINIMAL");
    expect(progressionDecision.pacing).toBe("CONCISE");
  });

  it("7. All decision outputs are 100% deterministic over multiple iterations", () => {
    const skills = [
      mockSkill({
        skillId: "filesystem",
        mastery: 75,
        confidence: 70,
        recentMistakes: ["TYPO"],
      }),
      mockSkill({
        skillId: "permissions",
        mastery: 40,
        confidence: 45,
        recentMistakes: ["CONCEPT_CONFUSION"],
      }),
    ];

    const results = Array.from({ length: 5 }, () => {
      const intel = analyzeLearner(skills, ["TYPO", "CONCEPT_CONFUSION"]);
      const decision = selectAdaptiveTraining({
        skills,
        intelligence: intel,
        currentDifficulty: 2,
      });
      return { intel, decision };
    });

    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.intel.readiness).toBe(results[0]!.intel.readiness);
      expect(results[i]!.intel.signals).toEqual(results[0]!.intel.signals);
      expect(results[i]!.decision.mode).toBe(results[0]!.decision.mode);
      expect(results[i]!.decision.difficulty).toBe(results[0]!.decision.difficulty);
      expect(results[i]!.decision.primarySkill).toBe(results[0]!.decision.primarySkill);
    }
  });
});
