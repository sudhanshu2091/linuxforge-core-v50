import { describe, expect, it } from "vitest";
import {
  evaluateQuestionEligibility,
  getQuestionLifecycleRecord,
  isQuestionConsumed,
  generatedDefinitionToExerciseContract,
} from "@/lib/forge/verification/question-history.server";
import { buildSemanticFingerprint } from "@/lib/forge/verification/semantic-identity";
import { classifyCompletionQuality } from "@/lib/forge/verification/verdict";
import { assessSkillMastery, decideProgression } from "@/lib/learner/mastery-engine";
import {
  evaluateBatchTrigger,
  buildSpecialTrainingBatch,
} from "@/lib/learner/training-batches";
import { evaluateConceptReadiness } from "./concept-readiness";
import { buildMissionBlueprint } from "./mission-generator";
import {
  createDeterministicCandidate,
  buildAdaptiveMissionCandidate,
} from "./adaptive-mission-bridge";
import { validateAndPublishMissionV2 } from "./mission-generation-v2.server";
import {
  aiAdaptiveReasoningService,
  deterministicAdaptiveReasoningFallback,
} from "./ai-service.server";
import { analyzeLearner } from "./learner-intelligence";
import { selectAdaptiveTraining } from "./adaptive-training";
import type { SkillMemoryView } from "@/lib/forge/types";
import type { ExerciseContract } from "@/lib/forge/verification/types";
import type { CanonicalEnvironmentModel } from "@/lib/forge/environment/types";

describe("Question Lifecycle, Mastery, and Adaptive Architecture Suite", () => {
  const baseEnvironment: CanonicalEnvironmentModel = {
    identity: {
      environmentId: "env-test-01",
      labId: "lab-test-01",
      userId: "user-test-01",
      provider: "mock-modelled-v1",
      runtimeClass: "container-dev",
      guestName: "Kali Linux",
      distribution: "Kali Linux",
      guestVersion: "2026.2",
      expectedArtifactRelease: "2026.2",
      guestVersionMatchesArtifact: true,
      architecture: "x86_64",
      kernel: "Linux 6.12",
      hostname: "kali-forge",
      shell: "/bin/bash",
      currentUser: "linuxforge",
      privilegeState: "sudo_capable",
      evidence: "OBSERVED_FACT",
    },
    users: [],
    groups: [],
    filesystem: [
      {
        path: "workspace",
        objectType: "directory",
        permissions: "755",
        owner: "linuxforge",
        group: "linuxforge",
        sizeBytes: 4096,
        exists: true,
        content: null,
        contentTruncated: false,
        evidence: "OBSERVED_FACT",
      },
      {
        path: "tmp/cache.log",
        objectType: "file",
        permissions: "644",
        owner: "linuxforge",
        group: "linuxforge",
        sizeBytes: 128,
        exists: true,
        content: "sample",
        contentTruncated: false,
        evidence: "OBSERVED_FACT",
      },
    ],
    processes: [
      {
        pid: 101,
        command: "sshd",
        state: "running",
        evidence: "OBSERVED_FACT",
      },
    ],
    services: [
      {
        name: "ssh",
        activeState: "active",
        enabledState: "enabled",
        evidence: "OBSERVED_FACT",
      },
    ],
    packages: [
      {
        packageName: "net-tools",
        packageManager: "dpkg",
        installed: true,
        version: "2.10",
        evidence: "OBSERVED_FACT",
      },
    ],
    environment: { variables: {}, redactedKeys: [], evidence: "UNKNOWN" },
    network: {
      supported: true,
      networkIsolationEnforced: true,
      listeners: [{ port: 22, process: "sshd" }],
      evidence: "OBSERVED_FACT",
    },
    system: {
      os: "Linux",
      distribution: "Kali",
      version: "2026.2",
      kernel: "6.12",
      architecture: "x86_64",
      hostname: "kali-forge",
      evidence: "OBSERVED_FACT",
    },
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
        snapshots: false,
        pauseResume: false,
        packages: true,
      },
      security: {
        guestRootAllowed: true,
        hostFilesystemBlocked: true,
        privilegeEscalationBlocked: false,
        metadataAccessBlocked: true,
        networkIsolationEnforced: true,
      },
      lifecycleState: "RUNNING",
      evidence: "OBSERVED_FACT",
    },
    artifacts: [],
    capturedAt: new Date().toISOString(),
  };

  const sampleContract = (id: string, path: string, permissions: string): ExerciseContract => ({
    exerciseId: id,
    questionId: id,
    questionVariantId: `${id}-var1`,
    version: 1,
    title: `Permissions Mission ${id}`,
    objective: `Set permission ${permissions} on ${path}`,
    concepts: ["permissions"],
    difficulty: 2,
    requirements: [
      {
        id: "req-1",
        kind: "permissions",
        path,
        permissions,
      },
    ],
  });

  // Mock DB store for testing question eligibility & lifecycle
  const createMockDb = (attempts: Array<{
    attempt_id: string;
    user_id: string;
    question_id: string;
    question_variant_id: string | null;
    semantic_fingerprint: string;
    completion_mode: string | null;
    consumed: boolean;
    hints_used: number;
    solution_revealed: boolean;
    verdict: string;
    created_at: string;
  }>) => {
    return {
      from: (table: string) => {
        if (table !== "lab_exercise_attempts") {
          return {
            select: () => ({ eq: () => ({ limit: async () => ({ data: [], error: null }) }) }),
          };
        }
        return {
          select: (_cols?: string) => {
            let filtered = [...attempts];
            const builder: any = {
              eq: (col: string, val: any) => {
                filtered = filtered.filter((r: any) => r[col] === val);
                return builder;
              },
              or: (expr: string) => {
                // simple parser for question_id.eq.X,semantic_fingerprint.eq.Y
                builder.order = () => Promise.resolve({ data: filtered, error: null });
                return builder;
              },
              limit: (n: number) => Promise.resolve({ data: filtered.slice(0, n), error: null }),
              order: (_col: string, _opts: any) => Promise.resolve({ data: filtered, error: null }),
              then: (resolve: any) => resolve({ data: filtered, error: null }),
            };
            return builder;
          },
        };
      },
    } as any;
  };

  /* ------------------------------------------------------------------ */
  /* Part 3, 4, 5: Question Lifecycle & Retirement Invariants           */
  /* ------------------------------------------------------------------ */

  describe("Question Lifecycle & Retirement", () => {
    it("1. Independent success retires the exact question and prevents duplicate presentation", async () => {
      const contract = sampleContract("q-101", "workspace/app.conf", "600");
      const fp = buildSemanticFingerprint(contract);

      const db = createMockDb([
        {
          attempt_id: "att-1",
          user_id: "u-1",
          question_id: "q-101",
          question_variant_id: "q-101-var1",
          semantic_fingerprint: fp,
          completion_mode: "DIRECT",
          consumed: true, // Independent completion
          hints_used: 0,
          solution_revealed: false,
          verdict: "PASS",
          created_at: new Date().toISOString(),
        },
      ]);

      const eligibility = await evaluateQuestionEligibility({
        db,
        userId: "u-1",
        contract,
      });

      expect(eligibility.eligible).toBe(false);
      expect(eligibility.lifecycleStatus).toBe("RETIRED");
      expect(eligibility.isExactRetired).toBe(true);
    });

    it("2. Assisted success does NOT retire the question and remains eligible for review/spaced practice", async () => {
      const contract = sampleContract("q-102", "workspace/notes.txt", "644");
      const fp = buildSemanticFingerprint(contract);

      // classifyCompletionQuality check for assisted run
      const quality = classifyCompletionQuality({
        verdict: "PASS",
        hintsUsed: 2,
        solutionRevealed: false,
      });
      expect(quality.independent).toBe(false);
      expect(quality.consumed).toBe(false);
      expect(quality.mode).toBe("ASSISTED");

      const db = createMockDb([
        {
          attempt_id: "att-2",
          user_id: "u-1",
          question_id: "q-102",
          question_variant_id: "q-102-var1",
          semantic_fingerprint: fp,
          completion_mode: "ASSISTED",
          consumed: false, // NOT consumed because it was assisted
          hints_used: 2,
          solution_revealed: false,
          verdict: "PASS",
          created_at: new Date().toISOString(),
        },
      ]);

      const eligibility = await evaluateQuestionEligibility({
        db,
        userId: "u-1",
        contract,
      });

      expect(eligibility.eligible).toBe(true);
      expect(eligibility.lifecycleStatus).toBe("ELIGIBLE_REVIEW");
      expect(eligibility.isExactRetired).toBe(false);
    });

    it("3. Failed attempts preserve history and remain eligible for remediation", async () => {
      const contract = sampleContract("q-103", "workspace/secure.sh", "750");
      const fp = buildSemanticFingerprint(contract);

      const db = createMockDb([
        {
          attempt_id: "att-3",
          user_id: "u-1",
          question_id: "q-103",
          question_variant_id: "q-103-var1",
          semantic_fingerprint: fp,
          completion_mode: null,
          consumed: false,
          hints_used: 1,
          solution_revealed: false,
          verdict: "FAIL",
          created_at: new Date().toISOString(),
        },
      ]);

      const eligibility = await evaluateQuestionEligibility({
        db,
        userId: "u-1",
        contract,
      });

      expect(eligibility.eligible).toBe(true);
      expect(eligibility.lifecycleStatus).toBe("FAILED");
      expect(eligibility.attemptsCount).toBe(1);
    });

    it("4. Prevents semantic duplicates while allowing legitimate different variants of the same skill", async () => {
      // Contract A
      const contractA = sampleContract("q-perm-a", "workspace/a.conf", "600");
      const fpA = buildSemanticFingerprint(contractA);

      // Contract B: Renaming target file from a.conf to b.conf with identical requirements produces same fingerprint (semantic clone)
      const contractB = sampleContract("q-perm-b", "workspace/b.conf", "600");
      const fpB = buildSemanticFingerprint(contractB);
      expect(fpA).toBe(fpB); // Detected as semantic clone!

      // Contract C: Legitimate different variant with different permissions (755) and scenario
      const contractC: ExerciseContract = {
        exerciseId: "q-perm-c",
        questionId: "q-perm-c",
        version: 1,
        title: "Executable script permissions",
        objective: "Make script executable with mode 755",
        concepts: ["permissions"],
        difficulty: 3,
        scenarioType: "investigation",
        reasoningPattern: "executable-bit-audit",
        requirements: [{ id: "r1", kind: "permissions", path: "workspace/run.sh", permissions: "755" }],
      };
      const fpC = buildSemanticFingerprint(contractC);
      expect(fpC).not.toBe(fpA); // Legitimate variant has distinct fingerprint!

      const db = createMockDb([
        {
          attempt_id: "att-a",
          user_id: "u-1",
          question_id: "q-perm-a",
          question_variant_id: "q-perm-a-1",
          semantic_fingerprint: fpA,
          completion_mode: "DIRECT",
          consumed: true,
          hints_used: 0,
          solution_revealed: false,
          verdict: "PASS",
          created_at: new Date().toISOString(),
        },
      ]);

      // Semantic duplicate contract B is blocked
      const eligB = await evaluateQuestionEligibility({ db, userId: "u-1", contract: contractB });
      expect(eligB.eligible).toBe(false);
      expect(eligB.isSemanticDuplicate).toBe(true);

      // Legitimate different variant contract C is eligible! Same skill, different question!
      const eligC = await evaluateQuestionEligibility({ db, userId: "u-1", contract: contractC });
      expect(eligC.eligible).toBe(true);
      expect(eligC.isSemanticDuplicate).toBe(false);
    });
  });

  /* ------------------------------------------------------------------ */
  /* Part 6 & 7: Topic / Skill Mastery Invariants                      */
  /* ------------------------------------------------------------------ */

  describe("Topic / Skill Mastery Invariants", () => {
    it("1. Solving one single easy question correctly does NOT grant mastery", () => {
      const singleEasySuccess: SkillMemoryView = {
        skillId: "permissions",
        mastery: 85, // Even with high initial raw score
        attempts: 1,
        successfulAttempts: 1,
        recentScore: 90,
        recentMistakes: [],
        confidence: 85,
        hintDependency: 0,
        lastPracticed: new Date().toISOString(),
        nextReview: "2099-01-01T00:00:00.000Z",
        evidenceCount: 1, // Only 1 piece of evidence
        difficultyRating: 1, // Only basic level-1 drill
      };

      const result = assessSkillMastery(singleEasySuccess);
      expect(result.state).not.toBe("MASTERED");
      expect(result.missingGates).toContain("at least 3 evidence points");
    });

    it("2. Mastery requires multiple varied evidence points including difficulty exposure", () => {
      // Learner with 3 attempts on easy-only drills (difficultyRating: 1)
      const easyOnlyLearner: SkillMemoryView = {
        skillId: "permissions",
        mastery: 85,
        attempts: 3,
        successfulAttempts: 3,
        recentScore: 90,
        recentMistakes: [],
        confidence: 85,
        hintDependency: 0,
        lastPracticed: new Date().toISOString(),
        nextReview: "2099-01-01T00:00:00.000Z",
        evidenceCount: 3,
        difficultyRating: 1.0, // Only trivial patterns
      };

      const easyRes = assessSkillMastery(easyOnlyLearner);
      expect(easyRes.state).not.toBe("MASTERED");
      expect(easyRes.missingGates).toContain("varied difficulty exposure (difficulty rating ≥ 2.0)");

      // Learner with varied difficulty (difficultyRating: 2.5) and multiple evidence points
      const variedLearner: SkillMemoryView = {
        ...easyOnlyLearner,
        difficultyRating: 2.5,
      };

      const variedRes = assessSkillMastery(variedLearner);
      expect(variedRes.state).toBe("MASTERED");
    });

    it("3. Overdue review prevents unverified mastery claim", () => {
      const overdueLearner: SkillMemoryView = {
        skillId: "permissions",
        mastery: 85,
        attempts: 4,
        successfulAttempts: 4,
        recentScore: 90,
        recentMistakes: [],
        confidence: 85,
        hintDependency: 0,
        lastPracticed: "2026-08-01T00:00:00.000Z",
        nextReview: "2026-08-15T00:00:00.000Z", // In the past!
        evidenceCount: 4,
        difficultyRating: 2.5,
      };

      const res = assessSkillMastery(overdueLearner, new Date("2026-10-01T00:00:00.000Z"));
      expect(res.state).not.toBe("MASTERED");
      expect(res.missingGates).toContain("retention review due");
    });
  });

  /* ------------------------------------------------------------------ */
  /* Part 8: Special Training Batches                                   */
  /* ------------------------------------------------------------------ */

  describe("Special Training Batches", () => {
    it("1. Generates 5-stage WEAKNESS batch on detected conceptual confusion", () => {
      const skills: SkillMemoryView[] = [
        {
          skillId: "permissions",
          mastery: 45,
          attempts: 2,
          successfulAttempts: 1,
          recentScore: 40,
          recentMistakes: ["CONCEPT_CONFUSION"],
          confidence: 40,
          hintDependency: 15,
          lastPracticed: new Date().toISOString(),
          nextReview: null,
          evidenceCount: 2,
        },
      ];

      const intelligence = analyzeLearner(skills, ["CONCEPT_CONFUSION"]);
      const trigger = evaluateBatchTrigger({
        skills,
        intelligence,
        recentMistakes: ["CONCEPT_CONFUSION"],
      });

      expect(trigger.batchRecommended).toBe(true);
      expect(trigger.recommendedBatchType).toBe("WEAKNESS");
      expect(trigger.primarySkill).toBe("permissions");

      const batch = buildSpecialTrainingBatch({
        batchType: "WEAKNESS",
        primarySkill: "permissions",
        skills,
        intelligence,
        targetWeakness: trigger.targetWeakness,
        baseDifficulty: 2,
      });

      expect(batch.items.length).toBe(5);
      expect(batch.items[0]?.role).toBe("DIAGNOSTIC");
      expect(batch.items[1]?.role).toBe("FOCUSED_PRACTICE");
      expect(batch.items[2]?.role).toBe("TROUBLESHOOTING");
      expect(batch.items[3]?.role).toBe("ADVANCED_APPLICATION");
      expect(batch.items[4]?.role).toBe("TRANSFER_APPLICATION");
    });

    it("2. Generates SPACED_REVIEW batch when retention is due", () => {
      const skills: SkillMemoryView[] = [
        {
          skillId: "filesystem",
          mastery: 75,
          attempts: 5,
          successfulAttempts: 4,
          recentScore: 80,
          recentMistakes: [],
          confidence: 70,
          hintDependency: 0,
          lastPracticed: "2026-08-01T00:00:00.000Z",
          nextReview: "2026-08-15T00:00:00.000Z",
          retention: 50,
          evidenceCount: 5,
        },
      ];

      const intelligence = analyzeLearner(skills, []);
      const trigger = evaluateBatchTrigger({
        skills,
        intelligence,
        recentMistakes: [],
      });

      expect(trigger.batchRecommended).toBe(true);
      expect(trigger.recommendedBatchType).toBe("SPACED_REVIEW");

      const batch = buildSpecialTrainingBatch({
        batchType: "SPACED_REVIEW",
        primarySkill: "filesystem",
        skills,
        baseDifficulty: 2,
      });

      expect(batch.items.length).toBe(2);
      expect(batch.items[0]?.role).toBe("SPACED_RETRIEVAL");
    });

    it("3. Generates SECURITY_CONTEXT batch when foundational skill is verified", () => {
      const skills: SkillMemoryView[] = [
        {
          skillId: "permissions",
          mastery: 78,
          attempts: 6,
          successfulAttempts: 5,
          recentScore: 85,
          recentMistakes: [],
          confidence: 80,
          hintDependency: 0,
          lastPracticed: new Date().toISOString(),
          nextReview: "2099-01-01T00:00:00.000Z",
          evidenceCount: 6,
        },
      ];

      const intelligence = analyzeLearner(skills, []);
      const trigger = evaluateBatchTrigger({
        skills,
        intelligence,
        recentMistakes: [],
      });

      expect(trigger.batchRecommended).toBe(true);
      expect(trigger.recommendedBatchType).toBe("SECURITY_CONTEXT");

      const batch = buildSpecialTrainingBatch({
        batchType: "SECURITY_CONTEXT",
        primarySkill: "permissions",
        skills,
        baseDifficulty: 3,
      });

      expect(batch.items.length).toBe(3);
      expect(batch.items.every((it) => it.cybersecurityContext)).toBe(true);
      expect(batch.items[0]?.objectiveSummary).toContain("misconfigurations");
    });
  });

  /* ------------------------------------------------------------------ */
  /* Part 9 & 10: Environment Grounding & Real Process/Network Missions */
  /* ------------------------------------------------------------------ */

  describe("Real Environment Grounding & Process/Network Semantics", () => {
    it("1. Uses existing filesystem state (/tmp, home) and does not eliminate concepts", () => {
      const skills: SkillMemoryView[] = [
        {
          skillId: "filesystem",
          mastery: 70,
          attempts: 3,
          successfulAttempts: 3,
          recentScore: 80,
          recentMistakes: [],
          confidence: 70,
          hintDependency: 0,
          lastPracticed: new Date().toISOString(),
          nextReview: null,
          evidenceCount: 3,
        },
      ];

      const readiness = evaluateConceptReadiness({
        targetSkill: "permissions",
        environment: baseEnvironment,
        skills,
      });

      // Existing workspace and tmp paths are recognized; concept is ready
      expect(readiness.ready).toBe(true);
      expect(readiness.status).toBe("READY");

      const blueprint = buildMissionBlueprint({
        skills,
        environment: baseEnvironment,
      });

      expect(blueprint.environmentContext).toBeDefined();
      expect(blueprint.scenarioOpportunities?.length).toBeGreaterThan(0);
      expect(
        blueprint.scenarioOpportunities?.some(
          (o) => o.includes("workspace") || o.includes("tmp") || o.includes("process"),
        ),
      ).toBe(true);
    });

    it("2. Real process missions require actual process state (no fake proc.txt)", () => {
      const blueprint = buildMissionBlueprint({
        skills: [{
          skillId: "processes",
          mastery: 50,
          attempts: 2,
          successfulAttempts: 1,
          recentScore: 60,
          recentMistakes: [],
          confidence: 50,
          hintDependency: 0,
          lastPracticed: new Date().toISOString(),
          nextReview: null,
        }],
        trainingDecision: {
          version: "v37",
          mode: "GUIDED_PRACTICE",
          primarySkill: "processes",
          supportingSkills: [],
          difficulty: 2,
          reason: "Practice process inspection",
          evidence: [],
          focusMistakes: [],
          constraints: [],
          sourceStrategy: "targeted-patterns",
          masteryGate: "PRACTICE",
          journeyPhase: "ACTIVE_TRAINING",
          journeyNextSkills: [],
        },
        environment: baseEnvironment,
      });

      const candidate = createDeterministicCandidate(blueprint);
      expect(candidate.evaluationPlan?.objectives[0]?.objectType).toBe("process");
      expect(candidate.evaluationPlan?.requiredCommandKinds).toContain("ps");

      // Verify contract mapping produces kind: "process", not kind: "filesystem"
      const contract = generatedDefinitionToExerciseContract(candidate as any);
      const procReq = contract.requirements.find((r) => r.kind === "process");
      expect(procReq).toBeDefined();
      expect((procReq as any)?.command).toBe("ps");

      // Mission V2 validates real process mission
      const v2Result = validateAndPublishMissionV2(candidate, {
        blueprint,
        environment: baseEnvironment,
        supportedCommandKinds: ["ps", "pgrep", "top"],
      });
      expect(v2Result.ok).toBe(true);
    });

    it("3. Real networking missions require actual network state (no fake net.txt)", () => {
      const blueprint = buildMissionBlueprint({
        skills: [{
          skillId: "networking",
          mastery: 50,
          attempts: 2,
          successfulAttempts: 1,
          recentScore: 60,
          recentMistakes: [],
          confidence: 50,
          hintDependency: 0,
          lastPracticed: new Date().toISOString(),
          nextReview: null,
        }],
        trainingDecision: {
          version: "v37",
          mode: "GUIDED_PRACTICE",
          primarySkill: "networking",
          supportingSkills: [],
          difficulty: 2,
          reason: "Practice network inspection",
          evidence: [],
          focusMistakes: [],
          constraints: [],
          sourceStrategy: "targeted-patterns",
          masteryGate: "PRACTICE",
          journeyPhase: "ACTIVE_TRAINING",
          journeyNextSkills: [],
        },
        environment: baseEnvironment,
      });

      const candidate = createDeterministicCandidate(blueprint);
      expect(candidate.evaluationPlan?.objectives[0]?.objectType).toBe("network");
      expect(candidate.evaluationPlan?.requiredCommandKinds).toContain("ip");

      const contract = generatedDefinitionToExerciseContract(candidate as any);
      const netReq = contract.requirements.find((r) => r.kind === "network");
      expect(netReq).toBeDefined();

      const v2Result = validateAndPublishMissionV2(candidate, {
        blueprint,
        environment: baseEnvironment,
        supportedCommandKinds: ["ip", "ss", "netstat"],
      });
      expect(v2Result.ok).toBe(true);
    });
  });

  /* ------------------------------------------------------------------ */
  /* Part 13: Adaptive Reasoning Call Path Integration                  */
  /* ------------------------------------------------------------------ */

  describe("Adaptive Reasoning Call Path Integration", () => {
    it("1. Deterministic adaptive reasoning fallback provides valid pedagogical structure", () => {
      const skills: SkillMemoryView[] = [
        {
          skillId: "permissions",
          mastery: 40,
          attempts: 2,
          successfulAttempts: 1,
          recentScore: 40,
          recentMistakes: ["CONCEPT_CONFUSION"],
          confidence: 40,
          hintDependency: 10,
          lastPracticed: new Date().toISOString(),
          nextReview: null,
        },
      ];

      const fallback = deterministicAdaptiveReasoningFallback({
        skills,
        recentMistakes: ["CONCEPT_CONFUSION"],
        currentDifficulty: 2,
      });

      expect(fallback.primarySkill).toBe("permissions");
      expect(fallback.recommendedMode).toBe("REMEDIATION");
      expect(fallback.pedagogicalRationale).toBeTruthy();
    });

    it("2. Complete call path from assessment -> learner model -> training decision -> adaptive reasoning -> blueprint -> candidate -> Mission V2", async () => {
      const skills: SkillMemoryView[] = [
        {
          skillId: "filesystem",
          mastery: 75,
          attempts: 4,
          successfulAttempts: 3,
          recentScore: 80,
          recentMistakes: [],
          confidence: 70,
          hintDependency: 0,
          lastPracticed: new Date().toISOString(),
          nextReview: null,
          evidenceCount: 4,
        },
      ];

      // 1. Learner intelligence snapshot from assessment/skills
      const intelligence = analyzeLearner(skills, []);

      // 2. Training decision selection
      const trainingDecision = selectAdaptiveTraining({
        skills,
        intelligence,
        currentDifficulty: 2,
      });
      expect(trainingDecision).toBeDefined();

      // 3. Adaptive reasoning execution
      const reasoning = await aiAdaptiveReasoningService({
        skills,
        recentMistakes: [],
        currentDifficulty: trainingDecision.difficulty,
      });
      expect(reasoning.response).toBeDefined();
      expect(reasoning.response.primarySkill).toBeDefined();

      // 4. Mission blueprint creation incorporating adaptive reasoning
      const blueprint = buildMissionBlueprint({
        skills,
        intelligence,
        trainingDecision: {
          ...trainingDecision,
          reason: reasoning.response.pedagogicalRationale,
        },
        environment: baseEnvironment,
      });
      expect(blueprint).toBeDefined();

      // 5. Candidate generation and Mission V2 deterministic validation
      const candidateResult = buildAdaptiveMissionCandidate({
        skills,
        trainingDecision,
        environment: baseEnvironment,
      });
      expect(candidateResult.validation.ok).toBe(true);
      expect(candidateResult.contract).toBeDefined();
    });
  });
});
