import { describe, expect, it } from "vitest";
import { buildAdaptiveMissionCandidate } from "./adaptive-mission-bridge";
import type { SkillMemoryView, AdaptiveExercise } from "@/lib/forge/types";
import { SKILL_GRAPH } from "./mission-generator";

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
    mastery: 45,
    attempts: 3,
    successfulAttempts: 1,
    recentScore: 50,
    recentMistakes: ["WRONG_ARGUMENT"],
    hintDependency: 40,
    lastPracticed: null,
    nextReview: null,
    confidence: 40,
    evidenceCount: 3,
  },
];

describe("Adaptive Mission Bridge (Part B)", () => {
  it("bridges learner state to blueprint, validated exercise and executable contract", () => {
    const result = buildAdaptiveMissionCandidate({
      skills: mockSkills,
      recentMistakes: ["WRONG_ARGUMENT"],
      currentDifficulty: 2,
    });

    expect(result.blueprint).toBeDefined();
    expect(result.trainingDecision).toBeDefined();
    expect(result.intelligence).toBeDefined();
    expect(result.validation.ok).toBe(true);

    // Primary skill should target the weak skill "permissions"
    expect(result.blueprint.primarySkill).toBe("permissions");

    // Canonical prerequisites for permissions must match SKILL_GRAPH
    expect(result.blueprint.prerequisites).toEqual(SKILL_GRAPH.permissions);

    // Validation must succeed with an executable contract and exercise
    expect(result.exercise).toBeDefined();
    expect(result.contract).toBeDefined();
    expect(result.contract?.id).toContain("adaptive-permissions");
    expect(typeof result.contract?.verify).toBe("function");
  });

  it("produces a contract with working deterministic verification", () => {
    const result = buildAdaptiveMissionCandidate({
      skills: mockSkills,
      currentDifficulty: 2,
    });

    expect(result.contract).toBeDefined();
    const contract = result.contract!;

    // Verify empty world -> not met
    const worldEmpty = new Map();
    const outcomeEmpty = contract.verify(worldEmpty, {
      commands: ["mkdir workspace", "chmod 750 workspace"],
      operations: 2,
      invocations: 2,
      usedLoop: false,
    });
    expect(outcomeEmpty.objectives.length).toBeGreaterThan(0);
    expect(outcomeEmpty.objectives.every((o) => o.met)).toBe(false);

    // Verify world with target created -> met
    const worldConfigured = new Map([
      [
        "workspace",
        {
          objectId: "obj-workspace",
          name: "workspace",
          path: "workspace",
          objectType: "directory" as const,
          permissions: "750",
          content: "",
          active: true,
          createdByChallenge: null,
          lastModifiedByChallenge: null,
          createdAt: new Date().toISOString(),
        },
      ],
    ]);
    const outcomeSuccess = contract.verify(worldConfigured, {
      commands: ["mkdir workspace", "chmod 750 workspace"],
      operations: 2,
      invocations: 2,
      usedLoop: false,
    });
    expect(outcomeSuccess.objectives.every((o) => o.met)).toBe(true);
    expect(outcomeSuccess.skillDemonstrated).toBe(true);
  });

  it("deterministically rejects invalid AI candidate proposals through V2 gates", () => {
    const invalidProposal: AdaptiveExercise = {
      id: "ai-bad-001",
      kind: "mission",
      title: "Bad", // Under 8 characters -> SCHEMA_INVALID
      scenario: "Short",
      objective: "Short",
      skills: ["permissions"],
      difficulty: 2,
      estimatedMinutes: 10,
      sourceRefs: [{ id: "kali-training", name: "Kali Training", url: "https://kali.training/" }],
      evaluationFocus: ["Directory presence"],
      learnerReason: "Testing",
      allowedApproaches: ["mkdir workspace"],
      bannedShortcuts: [],
      hints: ["Use mkdir"],
      successStory: "Done",
      failureStory: "Not done",
      remediation: [],
      evaluationPlan: {
        objectives: [
          {
            label: "Bad path traversal",
            path: "../../../etc/shadow", // Unsafe path!
            objectType: "file",
          },
        ],
        requiredCommandKinds: ["mkdir"],
      },
    };

    const result = buildAdaptiveMissionCandidate({
      skills: mockSkills,
      candidateExercise: invalidProposal,
    });

    expect(result.validation.ok).toBe(false);
    expect(result.contract).toBeUndefined();
    expect(result.exercise).toBeUndefined();
  });

  it("honors explicit trainingDecision when provided", () => {
    const explicitDecision = {
      version: "v37" as const,
      mode: "PROGRESSION" as const,
      primarySkill: "filesystem" as const,
      supportingSkills: [],
      difficulty: 4,
      reason: "Mastery demonstrated, escalating difficulty",
      evidence: ["Clean execution demonstrated"],
      focusMistakes: [],
      constraints: ["NO_HINTS"],
      sourceStrategy: "progression-patterns" as const,
      masteryGate: "ADVANCE" as const,
      journeyPhase: "advancing",
      journeyNextSkills: ["permissions" as const],
    };

    const result = buildAdaptiveMissionCandidate({
      skills: mockSkills,
      trainingDecision: explicitDecision,
    });

    expect(result.blueprint.primarySkill).toBe("filesystem");
    expect(result.blueprint.difficulty).toBe(4);
    expect(result.blueprint.archetype).toBe("PROGRESSION");
    expect(result.validation.ok).toBe(true);
    expect(result.contract?.difficulty).toBe(4);
  });
});
