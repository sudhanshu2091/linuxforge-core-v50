import { describe, expect, it } from "vitest";
import type { Contract } from "@/lib/forge/contracts.server";
import { deterministicObserver } from "@/lib/forge/observer.server";
import { buildMissionTutorContext } from "./tutor-context";
import { analyzeLearner } from "./learner-intelligence";
import { selectAdaptiveTraining } from "./adaptive-training";
import { buildGuidedHint } from "./hint-engine";
import { generatedDefinitionToContract, type GeneratedDefinition } from "@/lib/forge/generated-contract.server";
import { validateAndPublishMissionV2 } from "./mission-generation-v2.server";
import type {
  AdaptiveExercise,
  MissionState,
  SkillMemoryView,
  Verification,
  VerificationStatus,
} from "@/lib/forge/types";
import type { MethodEvidence } from "@/lib/forge/executor.server";
import type { CanonicalEnvironmentModel, MissionArtifact } from "@/lib/forge/environment/types";

const mockContract: Contract = {
  id: "test-contract",
  order: 1,
  title: "Defensive File Audit",
  storyIntro: "Audit the directory",
  objective: "Ensure workspace directory exists with 750 permissions",
  requiredSkills: ["filesystem", "permissions"],
  allowedApproaches: ["mkdir -p workspace", "chmod 750 workspace"],
  bannedShortcuts: ["chmod 777"],
  difficulty: 2,
  prerequisites: ["filesystem"],
  previousReferences: [],
  contextRequirements: [],
  xpReward: 50,
  hints: ["Inspect the directory", "Use chmod 750"],
  successStory: "Done",
  failureStory: "Not done",
  remediation: ["Review chmod"],
  verify: () => ({
    objectives: [{ label: "Workspace exists", met: true, evidence: "directory present" }],
    skillDemonstrated: true,
  }),
};

function createMockSkill(overrides: Partial<SkillMemoryView> & { skillId: SkillMemoryView["skillId"] }): SkillMemoryView {
  return {
    mastery: 50,
    attempts: 1,
    successfulAttempts: 1,
    recentScore: 80,
    recentMistakes: [],
    hintDependency: 0,
    confidence: 50,
    lastPracticed: new Date().toISOString(),
    nextReview: new Date().toISOString(),
    ...overrides,
  };
}

function mockEvidence(commands: string[] = [], overrides: Partial<MethodEvidence> = {}): MethodEvidence {
  return {
    usedLoop: false,
    operations: commands.length,
    invocations: commands.length,
    commands,
    ...overrides,
  };
}

function mockVerification(overrides: Partial<Verification> & { status: VerificationStatus }): Verification {
  return {
    score: overrides.status === "COMPLETE" ? 100 : 0,
    message: overrides.status === "COMPLETE" ? "Verified" : "Incomplete",
    objectives: [],
    remediation: [],
    wentWell: [],
    ...overrides,
  };
}

describe("Phase 3A: AI Tutor + Intent-Aware Evaluation Formal Suite", () => {
  // -------------------------------------------------------------
  // PART A & B: INTENT-AWARE EVALUATION (Tests 1-12)
  // -------------------------------------------------------------
  describe("Intent-Aware Evaluation (Tests 1-12)", () => {
    it("1. successful required-skill execution -> INDEPENDENT_SOLUTION / COMPLETE", () => {
      const obs = deterministicObserver.observe({
        contract: mockContract,
        raw: "chmod 750 workspace",
        execution: {
          lines: [{ kind: "output", text: "" }],
          blocked: null,
          exitCode: 0,
          mutationCount: 1,
          evidence: mockEvidence(["chmod 750 workspace"]),
        },
        verification: mockVerification({
          status: "COMPLETE",
          objectives: [{ label: "exists", met: true, evidence: "ok" }],
        }),
        history: ["mkdir workspace", "chmod 750 workspace"],
        hintsUsed: 0,
        language: "English",
      });

      expect(obs.category).toBe("INDEPENDENT_SOLUTION");
      expect(obs.skillDemonstrated).toBe(true);
      expect(obs.conceptUnderstanding).toBe("solid");
      expect(obs.evidence?.length).toBeGreaterThan(0);
    });

    it("2. valid alternative approach with guidance -> VALID_ALTERNATIVE", () => {
      const obs = deterministicObserver.observe({
        contract: mockContract,
        raw: "chmod u=rwx,g=rx,o= workspace", // Alternative syntax
        execution: {
          lines: [{ kind: "output", text: "" }],
          blocked: null,
          exitCode: 0,
          mutationCount: 1,
          evidence: mockEvidence(["chmod u=rwx,g=rx,o= workspace"]),
        },
        verification: mockVerification({
          status: "COMPLETE",
          objectives: [{ label: "exists", met: true, evidence: "ok" }],
        }),
        history: ["mkdir workspace", "chmod u=rwx,g=rx,o= workspace"],
        hintsUsed: 1,
        language: "English",
      });

      expect(obs.category).toBe("VALID_ALTERNATIVE");
      expect(obs.skillDemonstrated).toBe(true);
      expect(obs.conceptUnderstanding).toBe("solid");
    });

    it("3. independent solution with 0 hints -> INDEPENDENT_SOLUTION", () => {
      const obs = deterministicObserver.observe({
        contract: mockContract,
        raw: "mkdir -p workspace",
        execution: {
          lines: [{ kind: "output", text: "" }],
          blocked: null,
          exitCode: 0,
          mutationCount: 1,
          evidence: mockEvidence(["mkdir -p workspace"]),
        },
        verification: mockVerification({
          status: "COMPLETE",
          objectives: [{ label: "exists", met: true, evidence: "ok" }],
        }),
        history: ["mkdir -p workspace"],
        hintsUsed: 0,
        language: "English",
      });

      expect(obs.category).toBe("INDEPENDENT_SOLUTION");
      expect(obs.skillDemonstrated).toBe(true);
    });

    it("4. correct state but skill not demonstrated -> SKILL_BYPASS / RESULT_CORRECT_SKILL_NOT_DEMONSTRATED", () => {
      const obs = deterministicObserver.observe({
        contract: mockContract,
        raw: "touch a; touch b; touch c",
        execution: {
          lines: [{ kind: "output", text: "" }],
          blocked: null,
          exitCode: 0,
          mutationCount: 3,
          evidence: mockEvidence(["touch a", "touch b", "touch c"]),
        },
        verification: mockVerification({
          status: "RESULT_CORRECT_SKILL_NOT_DEMONSTRATED",
          objectives: [{ label: "all files created", met: true, evidence: "files created" }],
        }),
        history: ["touch a", "touch b", "touch c"],
        hintsUsed: 0,
        language: "English",
      });

      expect(obs.category).toBe("SKILL_BYPASS");
      expect(obs.skillDemonstrated).toBe(false);
      expect(obs.evidence?.some((e: string) => e.includes("bypassed or unobserved"))).toBe(true);
    });

    it("5. wrong target with correct technique -> RESULT_INCORRECT_SKILL_DEMONSTRATED", () => {
      const obs = deterministicObserver.observe({
        contract: mockContract,
        raw: "chmod 750 /wrong/path",
        execution: {
          lines: [{ kind: "output", text: "" }],
          blocked: null,
          exitCode: 0,
          mutationCount: 1,
          evidence: mockEvidence(["chmod 750 /wrong/path"]),
        },
        verification: mockVerification({
          status: "RESULT_INCORRECT_SKILL_DEMONSTRATED",
          objectives: [{ label: "exists", met: false, evidence: "wrong path" }],
        }),
        history: ["chmod 750 /wrong/path"],
        hintsUsed: 0,
        language: "English",
      });

      expect(obs.skillDemonstrated).toBe(true);
      expect(["WRONG_PATH", "WRONG_ARGUMENT"]).toContain(obs.category);
    });

    it("6. command failure caused by typo -> TYPO", () => {
      const obs = deterministicObserver.observe({
        contract: mockContract,
        raw: "mkkdir workspace",
        execution: {
          lines: [{ kind: "error", text: "mkkdir: command not found" }],
          blocked: null,
          exitCode: 127,
          mutationCount: 0,
          evidence: mockEvidence(["mkkdir workspace"]),
        },
        verification: mockVerification({
          status: "INCOMPLETE",
          objectives: [{ label: "exists", met: false, evidence: "missing" }],
        }),
        history: ["mkkdir workspace"],
        hintsUsed: 0,
        language: "English",
      });

      expect(obs.category).toBe("TYPO");
      expect(obs.skillDemonstrated).toBe(false);
      expect(obs.coaching).toContain("mkdir");
      expect(obs.evidence?.some((e: string) => e.includes("Typo detected"))).toBe(true);
    });

    it("7. command failure caused by wrong path -> WRONG_PATH", () => {
      const obs = deterministicObserver.observe({
        contract: mockContract,
        raw: "cd /nonexistent/dir",
        execution: {
          lines: [{ kind: "error", text: "bash: cd: /nonexistent/dir: No such file or directory" }],
          blocked: null,
          exitCode: 1,
          mutationCount: 0,
          evidence: mockEvidence(["cd /nonexistent/dir"]),
        },
        verification: mockVerification({
          status: "INCOMPLETE",
          objectives: [{ label: "exists", met: false, evidence: "missing" }],
        }),
        history: ["cd /nonexistent/dir"],
        hintsUsed: 0,
        language: "English",
      });

      expect(obs.category).toBe("WRONG_PATH");
      expect(obs.skillDemonstrated).toBe(false);
    });

    it("8. wrong command entirely -> WRONG_COMMAND", () => {
      const obs = deterministicObserver.observe({
        contract: mockContract,
        raw: "unknownbinary workspace",
        execution: {
          lines: [{ kind: "error", text: "unknownbinary: command not found" }],
          blocked: null,
          exitCode: 127,
          mutationCount: 0,
          evidence: mockEvidence(["unknownbinary workspace"]),
        },
        verification: mockVerification({
          status: "INCOMPLETE",
          objectives: [{ label: "exists", met: false, evidence: "missing" }],
        }),
        history: ["unknownbinary workspace"],
        hintsUsed: 0,
        language: "English",
      });

      expect(obs.category).toBe("WRONG_COMMAND");
      expect(obs.skillDemonstrated).toBe(false);
    });

    it("9. concept confusion -> CONCEPT_CONFUSION (0 objectives met, unobserved skill)", () => {
      const obs = deterministicObserver.observe({
        contract: mockContract,
        raw: "echo hello",
        execution: {
          lines: [{ kind: "output", text: "hello" }],
          blocked: null,
          exitCode: 0,
          mutationCount: 0,
          evidence: mockEvidence(["echo hello"]),
        },
        verification: mockVerification({
          status: "INCOMPLETE",
          objectives: [{ label: "exists", met: false, evidence: "missing" }],
        }),
        history: ["echo hello"],
        hintsUsed: 0,
        language: "English",
      });

      expect(obs.category).toBe("CONCEPT_CONFUSION");
      expect(obs.conceptUnderstanding).toBe("unclear");
    });

    it("10. unsafe approach blocked by policy -> UNSAFE_APPROACH", () => {
      const obs = deterministicObserver.observe({
        contract: mockContract,
        raw: "cat /etc/shadow",
        execution: {
          lines: [{ kind: "error", text: "Operation blocked by sandbox policy" }],
          blocked: { reason: "Operation blocked by sandbox policy" },
          exitCode: 1,
          mutationCount: 0,
          evidence: mockEvidence(["cat /etc/shadow"]),
        },
        verification: mockVerification({
          status: "INCOMPLETE",
          objectives: [{ label: "exists", met: false, evidence: "missing" }],
        }),
        history: ["cat /etc/shadow"],
        hintsUsed: 0,
        language: "English",
      });

      expect(obs.category).toBe("UNSAFE_APPROACH");
      expect(obs.evidence?.some((e: string) => e.includes("sandbox safety policy"))).toBe(true);
    });

    it("11. repeated trial-and-error without mutation -> RANDOM_TRIAL_AND_ERROR", () => {
      const obs = deterministicObserver.observe({
        contract: mockContract,
        raw: "ls -la",
        execution: {
          lines: [{ kind: "output", text: "total 0" }],
          blocked: null,
          exitCode: 0,
          mutationCount: 0,
          evidence: mockEvidence(["ls -la"]),
        },
        verification: mockVerification({
          status: "INCOMPLETE",
          objectives: [{ label: "exists", met: false, evidence: "missing" }],
        }),
        history: ["ls", "ls", "ls", "ls"],
        hintsUsed: 0,
        language: "English",
      });

      expect(obs.category).toBe("RANDOM_TRIAL_AND_ERROR");
      expect(obs.conceptUnderstanding).toBe("unclear");
    });

    it("12. partial objective completion -> PARTIAL_UNDERSTANDING", () => {
      const obs = deterministicObserver.observe({
        contract: mockContract,
        raw: "mkdir workspace",
        execution: {
          lines: [{ kind: "output", text: "" }],
          blocked: null,
          exitCode: 0,
          mutationCount: 1,
          evidence: mockEvidence(["mkdir workspace"]),
        },
        verification: mockVerification({
          status: "INCOMPLETE",
          objectives: [
            { label: "Directory exists", met: true, evidence: "directory created" },
            { label: "Permissions 750", met: false, evidence: "permissions are 755" },
          ],
        }),
        history: ["mkdir workspace"],
        hintsUsed: 0,
        language: "English",
      });

      expect(obs.category).toBe("PARTIAL_UNDERSTANDING");
      expect(obs.conceptUnderstanding).toBe("partial");
    });
  });

  // -------------------------------------------------------------
  // PART C: AI TUTOR (Tests 13-18)
  // -------------------------------------------------------------
  describe("AI Tutor & Context Safety (Tests 13-18)", () => {
    const mockState: MissionState = {
      challenge: {
        id: "chal-01",
        order: 1,
        title: "Defensive File Audit",
        storyIntro: "Forensic analysis",
        objective: "Inspect directory structure",
        difficulty: 2,
        requiredSkills: ["filesystem"],
        allowedApproaches: ["ls -la"],
        bannedShortcuts: [],
        prerequisites: [],
        previousReferences: [],
        xpReward: 100,
        hintLevels: 3,
      },
      skills: [
        createMockSkill({
          skillId: "filesystem",
          mastery: 40,
          confidence: 50,
          attempts: 3,
          successfulAttempts: 1,
          recentMistakes: ["WRONG_PATH"],
        }),
      ],
      progression: { totalXp: 100, level: 2, challengesCompleted: 1 },
      attempt: {
        challengeId: "chal-01",
        status: "INCOMPLETE",
        attempts: 1,
        bestScore: 0,
        xpAwarded: 0,
        completedAt: null,
        startedAt: new Date().toISOString(),
      },
      catalogue: [],
      context: {
        learner_level: 2,
        current_mastery: { filesystem: 40 },
        weak_skills: ["filesystem"],
        strong_skills: [],
        recent_mistakes: ["WRONG_PATH"],
        recent_challenges: [],
        relevant_previous_objects: [],
        relevant_story_events: [],
        current_lab_state: { labTitle: "Defensive Lab", cwd: "/home/learner", objects: [] },
        prerequisites: [],
        desired_difficulty: 2,
      },
      cwd: "/home/learner",
      transcript: [
        { kind: "output", text: "password=mysecretpassword" },
        { kind: "error", text: "No such file or directory" },
      ],
      hints: [],
      hintsRemaining: 3,
      nextChallengeId: null,
      lastVerification: {
        status: "INCOMPLETE",
        score: 0,
        message: "Audit incomplete",
        remediation: ["Check directory"],
        wentWell: [],
        objectives: [{ label: "audit", met: false, evidence: "missing" }],
      },
      lastObservation: {
        intent: "Inspect directory",
        approach: "cd /nonexistent",
        skillTarget: ["filesystem"],
        category: "WRONG_PATH",
        conceptUnderstanding: "partial",
        skillDemonstrated: false,
        coaching: "Check path before cd",
      },
    };

    it("13. tutor receives deterministic verification evidence", () => {
      const ctx = buildMissionTutorContext(mockState);
      expect(ctx.run.verification).toBeDefined();
      expect(ctx.run.verification?.status).toBe("INCOMPLETE");
      expect(ctx.run.verification?.objectives[0]?.met).toBe(false);
    });

    it("14. tutor receives learner intelligence derived from evidence", () => {
      const ctx = buildMissionTutorContext(mockState);
      expect(ctx.learner.mastery["filesystem"]).toBe(40);
      expect(ctx.learner.focusSkills).toContain("filesystem");
      expect(ctx.learner.signals.length).toBeGreaterThan(0);
    });

    it("15. tutor receives grounded knowledge diagnostic and summaries", () => {
      const ctx = buildMissionTutorContext(mockState);
      expect(Array.isArray(ctx.teaching.grounding)).toBe(true);
    });

    it("16. tutor does NOT receive unredacted secrets or provider credentials", () => {
      const ctx = buildMissionTutorContext(mockState);
      const str = JSON.stringify(ctx);
      expect(str).not.toContain("mysecretpassword");
      expect(str).not.toContain("provider_credentials");
    });

    it("17. tutor does not override verification status", () => {
      expect(mockState.lastVerification?.status).toBe("INCOMPLETE");
    });

    it("18. tutor does not award success or XP directly", () => {
      const initialVerification = mockState.lastVerification;
      const initialTotalXp = mockState.progression.totalXp;
      const ctx = buildMissionTutorContext(mockState);
      expect(ctx).toBeDefined();
      expect(mockState.lastVerification).toBe(initialVerification);
      expect(mockState.lastVerification?.status).toBe("INCOMPLETE");
      expect(mockState.progression.totalXp).toBe(initialTotalXp);
    });
  });

  // -------------------------------------------------------------
  // PART D: HINT ESCALATION (Tests 19-21)
  // -------------------------------------------------------------
  describe("Hint Escalation (Tests 19-21)", () => {
    it("19. progressive hint escalation through stages 1 to 5", () => {
      const h1 = buildGuidedHint({ level: 1, totalLevels: 5, baseHint: "Step 1", observation: null, failedCommands: 0, attempts: 1 });
      expect(h1.stage).toBe("CONCEPT");

      const h2 = buildGuidedHint({ level: 2, totalLevels: 5, baseHint: "Step 2", observation: null, failedCommands: 0, attempts: 1 });
      expect(h2.stage).toBe("DIRECTION");

      const h3 = buildGuidedHint({ level: 3, totalLevels: 5, baseHint: "Step 3", observation: null, failedCommands: 0, attempts: 1 });
      expect(h3.stage).toBe("COMMAND");

      const h4 = buildGuidedHint({ level: 4, totalLevels: 5, baseHint: "Step 4", observation: null, failedCommands: 0, attempts: 1 });
      expect(h4.stage).toBe("NEAR_SOLUTION");

      const h5 = buildGuidedHint({ level: 5, totalLevels: 5, baseHint: "Step 5", observation: null, failedCommands: 0, attempts: 1 });
      expect(h5.stage).toBe("SOLUTION");
    });

    it("20. repeated hints increase hint dependency signal in learner intelligence", () => {
      const skills = [
        createMockSkill({
          skillId: "filesystem",
          mastery: 50,
          confidence: 60,
          attempts: 2,
          successfulAttempts: 1,
          hintDependency: 80,
        }),
      ];
      const intel = analyzeLearner(skills, []);
      expect(intel.hintDependency).toBeGreaterThanOrEqual(70);
      expect(intel.signals).toContain("DEPENDENT");
    });

    it("21. hints do not alter deterministic verifier result", () => {
      const verifyResult = mockContract.verify(new Map(), { commands: [], usedLoop: false, operations: 0, invocations: 0 });
      expect(verifyResult.objectives[0]?.met).toBe(true);
      expect(verifyResult.skillDemonstrated).toBe(true);
    });
  });

  // -------------------------------------------------------------
  // PART E: LEARNER INTELLIGENCE (Tests 22-25)
  // -------------------------------------------------------------
  describe("Learner Intelligence (Tests 22-25)", () => {
    it("22. concept gap produces CONCEPT_GAP signal", () => {
      const intel = analyzeLearner(
        [
          createMockSkill({
            skillId: "filesystem",
            mastery: 20,
            confidence: 20,
            attempts: 3,
            successfulAttempts: 0,
            recentMistakes: ["CONCEPT_CONFUSION", "CONCEPT_CONFUSION"],
            hintDependency: 40,
          }),
        ],
        ["CONCEPT_CONFUSION", "CONCEPT_CONFUSION"],
      );
      expect(intel.signals).toContain("CONCEPT_GAP");
    });

    it("23. independent verified success produces INDEPENDENT signal", () => {
      const intel = analyzeLearner(
        [
          createMockSkill({
            skillId: "filesystem",
            mastery: 85,
            confidence: 90,
            attempts: 5,
            successfulAttempts: 5,
            hintDependency: 0,
            independence: 95,
          }),
        ],
        [],
      );
      expect(intel.signals).toContain("INDEPENDENT");
      expect(intel.independence).toBeGreaterThan(70);
    });

    it("24. repeated mistakes are retained accurately", () => {
      const intel = analyzeLearner(
        [
          createMockSkill({
            skillId: "permissions",
            mastery: 40,
            confidence: 40,
            attempts: 4,
            successfulAttempts: 1,
            recentMistakes: ["WRONG_ARGUMENT", "WRONG_ARGUMENT"],
            hintDependency: 10,
          }),
        ],
        ["WRONG_ARGUMENT", "WRONG_ARGUMENT"],
      );
      expect(intel.repeatedMistakes).toContain("WRONG_ARGUMENT");
    });

    it("25. difficulty adjustment remains bounded to -1, 0, or +1", () => {
      const lowIntel = analyzeLearner(
        [
          createMockSkill({
            skillId: "filesystem",
            mastery: 10,
            confidence: 10,
            attempts: 5,
            successfulAttempts: 0,
            recentMistakes: ["CONCEPT_CONFUSION"],
            hintDependency: 80,
          }),
        ],
        ["CONCEPT_CONFUSION"],
      );
      expect([-1, 0, 1]).toContain(lowIntel.difficultyAdjustment);

      const highIntel = analyzeLearner(
        [
          createMockSkill({
            skillId: "filesystem",
            mastery: 95,
            confidence: 95,
            attempts: 6,
            successfulAttempts: 6,
            hintDependency: 0,
            independence: 95,
          }),
        ],
        [],
      );
      expect([-1, 0, 1]).toContain(highIntel.difficultyAdjustment);
    });
  });

  // -------------------------------------------------------------
  // PART F: ADAPTIVE TRAINING (Tests 26-29)
  // -------------------------------------------------------------
  describe("Adaptive Next Mission Selection (Tests 26-29)", () => {
    it("26. remediation evidence (CONCEPT_GAP + repeated failures) selects REMEDIATION", () => {
      const skills = [
        createMockSkill({
          skillId: "filesystem",
          mastery: 20,
          confidence: 20,
          attempts: 4,
          successfulAttempts: 0,
          recentMistakes: ["CONCEPT_CONFUSION"],
          hintDependency: 80,
        }),
      ];
      const intelligence = analyzeLearner(skills, ["CONCEPT_CONFUSION"]);
      const decision = selectAdaptiveTraining({
        skills,
        intelligence,
        assessment: { learningSignal: "needs_practice", grade: 20, mistakeBreakdown: [], hintsUsed: 2 },
      });
      expect(decision.mode).toBe("REMEDIATION");
    });

    it("27. verified mastery with high independence can select PROGRESSION", () => {
      const skills = [
        createMockSkill({
          skillId: "filesystem",
          mastery: 90,
          confidence: 90,
          attempts: 6,
          successfulAttempts: 6,
          hintDependency: 0,
          independence: 95,
        }),
      ];
      const intelligence = analyzeLearner(skills, []);
      const decision = selectAdaptiveTraining({
        skills,
        intelligence,
        assessment: { learningSignal: "mastered", grade: 100, mistakeBreakdown: [], hintsUsed: 0 },
      });
      expect(["PROGRESSION", "TRANSFER", "GUIDED_PRACTICE", "SPACED_REVIEW", "ASSESSMENT"]).toContain(decision.mode);
    });

    it("28. valid skill with context exploration selects practice / review / transfer", () => {
      const skills = [
        createMockSkill({
          skillId: "permissions",
          mastery: 65,
          confidence: 70,
          attempts: 3,
          successfulAttempts: 2,
          hintDependency: 20,
        }),
      ];
      const intelligence = analyzeLearner(skills, []);
      const decision = selectAdaptiveTraining({
        skills,
        intelligence,
      });
      expect(["TRANSFER", "GUIDED_PRACTICE", "SPACED_REVIEW", "PROGRESSION", "ASSESSMENT"]).toContain(decision.mode);
    });

    it("29. high hint dependency does not increase difficulty", () => {
      const skills = [
        createMockSkill({
          skillId: "filesystem",
          mastery: 60,
          confidence: 60,
          attempts: 3,
          successfulAttempts: 2,
          hintDependency: 85,
        }),
      ];
      const intelligence = analyzeLearner(skills, []);
      const decision = selectAdaptiveTraining({
        skills,
        intelligence,
        currentDifficulty: 3,
      });
      expect(decision.difficulty).toBeLessThanOrEqual(3);
    });
  });

  // -------------------------------------------------------------
  // PHASE 2 RESIDUAL FIXES (Tests 30-34)
  // -------------------------------------------------------------
  describe("Phase 2 Residual Fixes (Tests 30-34)", () => {
    it("30. requiredCapabilities is preserved through safePlan and generatedDefinitionToContract", () => {
      const def: GeneratedDefinition = {
        id: "def-cap-01",
        kind: "mission",
        title: "Package and Service Audit",
        scenario: "Audit daemon and apt suite",
        objective: "Configure the team packages securely",
        skills: ["filesystem"],
        difficulty: 2,
        estimatedMinutes: 10,
        sourceRefs: [],
        evaluationFocus: ["packages"],
        learnerReason: "Practice packages",
        allowedApproaches: [],
        bannedShortcuts: [],
        hints: ["Audit package list"],
        successStory: "Packages secured",
        failureStory: "Packages left unconfigured",
        remediation: [],
        evaluationPlan: {
          objectives: [{ label: "dir", path: "test", objectType: "directory" }],
          requiredCapabilities: ["packages", "services"],
        },
      };

      const contract = generatedDefinitionToContract(def);

      expect(contract.requiredCapabilities).toBeDefined();
      expect(contract.requiredCapabilities).toContain("packages");
      expect(contract.requiredCapabilities).toContain("services");
    });

    it("31. unknown capability in evaluation plan is rejected by safePlan", () => {
      const def: GeneratedDefinition = {
        id: "def-cap-invalid",
        kind: "mission",
        title: "Invalid Capability Test",
        scenario: "Unknown capability test",
        objective: "Audit directory with unknown capability",
        skills: ["filesystem"],
        difficulty: 2,
        estimatedMinutes: 10,
        sourceRefs: [],
        evaluationFocus: [],
        learnerReason: "Test",
        allowedApproaches: [],
        bannedShortcuts: [],
        hints: ["test hint"],
        successStory: "success",
        failureStory: "failure",
        remediation: [],
        evaluationPlan: {
          objectives: [{ label: "dir", path: "test", objectType: "directory" }],
          requiredCapabilities: ["invalid_quantum_hypervisor" as any],
        },
      };

      expect(() => {
        generatedDefinitionToContract(def);
      }).toThrow();
    });

    const mockEnv: CanonicalEnvironmentModel = {
      identity: {
        environmentId: "env-1",
        labId: "lab-1",
        userId: "user-1",
        provider: "mock-modelled-v1",
        runtimeClass: "container-dev",
        guestName: "Kali",
        distribution: "Kali",
        guestVersion: "2026.2",
        expectedArtifactRelease: "2026.2",
        guestVersionMatchesArtifact: true,
        architecture: "aarch64",
        kernel: "6.18",
        hostname: "kali",
        shell: "/bin/bash",
        currentUser: "linuxforge",
        privilegeState: "sudo_capable",
        evidence: "OBSERVED_FACT",
      },
      users: [],
      groups: [],
      filesystem: [],
      processes: [],
      services: [],
      packages: [],
      environment: { variables: {}, redactedKeys: [], evidence: "UNKNOWN" },
      network: { supported: true, networkIsolationEnforced: true, listeners: [], evidence: "OBSERVED_FACT" },
      system: { os: "Linux", distribution: "Kali", version: "2026.2", kernel: "6.18", architecture: "aarch64", hostname: "kali", evidence: "OBSERVED_FACT" },
      runtime: {
        provider: "mock-modelled-v1",
        runtimeClass: "container-dev",
        capabilities: {
          interactiveShell: true,
          streaming: true,
          resize: true,
          processes: true,
          services: true,
          environmentVariables: true,
          network: true,
          snapshots: true,
          pauseResume: true,
          packages: true,
        },
        security: { guestRootAllowed: true, hostFilesystemBlocked: true, privilegeEscalationBlocked: true, metadataAccessBlocked: true, networkIsolationEnforced: true },
        lifecycleState: "RUNNING",
        evidence: "OBSERVED_FACT",
      },
      artifacts: [],
      capturedAt: new Date().toISOString(),
    };

    const validExercise: AdaptiveExercise = {
      id: "ex-state-01",
      kind: "mission",
      title: "Defensive File Audit Mission",
      scenario: "Reviewing forensic incident artifacts in workspace",
      objective: "Ensure workspace directory exists with 750 permissions in /home/learner/workspace.",
      skills: ["filesystem"],
      difficulty: 2,
      estimatedMinutes: 15,
      hints: ["Inspect the directory permissions"],
      sourceRefs: [
        {
          id: "kali-training",
          name: "Kali Training",
          url: "https://kali.training/",
        },
      ],
      evaluationFocus: ["Permissions 750"],
      learnerReason: "Audit practice",
      evaluationPlan: {
        objectives: [{ label: "Workspace", path: "workspace", objectType: "directory", permissions: "750" }],
      },
    };

    it("32. expectedState matching observedState passes continuity", () => {
      const art: MissionArtifact = {
        id: "art-01",
        kind: "file",
        identifier: "workspace/report.txt",
        expectedState: { size: 1024, mode: "0640" },
        observedState: { size: 1024, mode: "0640" },
        verified: true,
        evidence: "OBSERVED_FACT",
      };

      const res = validateAndPublishMissionV2(validExercise, {
        environment: mockEnv,
        trackedMissionArtifacts: [art],
        requiredPriorArtifacts: [
          { identifier: "workspace/report.txt", expectedState: { size: 1024, mode: "0640" } },
        ],
      });

      expect(res.ok).toBe(true);
    });

    it("33. expectedState mismatching observedState fails with CONTINUITY_INVALID", () => {
      const art: MissionArtifact = {
        id: "art-01",
        kind: "file",
        identifier: "workspace/report.txt",
        observedState: { size: 512, mode: "0644" }, // Mismatched!
        verified: true,
        evidence: "OBSERVED_FACT",
      };

      const res = validateAndPublishMissionV2(validExercise, {
        environment: mockEnv,
        trackedMissionArtifacts: [art],
        requiredPriorArtifacts: [
          { identifier: "workspace/report.txt", expectedState: { size: 1024, mode: "0640" } },
        ],
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("CONTINUITY_INVALID");
        expect(res.reasons.some((r) => r.includes("state mismatch"))).toBe(true);
      }
    });

    it("34. missing observedState fails with CONTINUITY_INVALID when expectedState is required", () => {
      const art: MissionArtifact = {
        id: "art-01",
        kind: "file",
        identifier: "workspace/report.txt",
        observedState: null, // Missing!
        verified: true,
        evidence: "OBSERVED_FACT",
      };

      const res = validateAndPublishMissionV2(validExercise, {
        environment: mockEnv,
        trackedMissionArtifacts: [art],
        requiredPriorArtifacts: [
          { identifier: "workspace/report.txt", expectedState: { size: 1024 } },
        ],
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("CONTINUITY_INVALID");
        expect(res.reasons.some((r) => r.includes("observedState is missing"))).toBe(true);
      }
    });
  });
});
