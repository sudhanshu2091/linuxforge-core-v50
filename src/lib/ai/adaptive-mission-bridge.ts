/**
 * Adaptive Mission Bridge (Server-Side).
 *
 * Deterministic bridge from:
 * REAL KALI RESULT
 *   ↓
 * deterministic verification
 *   ↓
 * MissionAssessment
 *   ↓
 * TrainingDecision
 *   ↓
 * MissionBlueprint (buildMissionBlueprint)
 *   ↓
 * Mission Generation V2 validation (validateAndPublishMissionV2)
 *   ↓
 * executable Contract
 *
 * Invariant: AI proposals are NEVER authoritative.
 * No mission candidate is published or executed without 100% deterministic validation.
 */

import type { AdaptiveExercise, SkillId, SkillMemoryView } from "@/lib/forge/types";
import type { Contract } from "@/lib/forge/contracts.server";
import type {
  CanonicalEnvironmentModel,
  MissionArtifact,
} from "@/lib/forge/environment/types";
import {
  buildMissionBlueprint,
  SKILL_GRAPH,
  type MissionBlueprint,
} from "./mission-generator";
import {
  validateAndPublishMissionV2,
  type MissionV2Context,
  type MissionV2ValidationResult,
  type RequiredPriorArtifactSpec,
} from "./mission-generation-v2.server";
import { analyzeLearner, type LearnerIntelligence } from "./learner-intelligence";
import { selectAdaptiveTraining, type TrainingDecision } from "./adaptive-training";
import type { MissionAssessment } from "@/lib/forge/assessment.server";

import { evaluateConceptReadiness, type ConceptReadinessResult } from "./concept-readiness";

export type AdaptiveMissionBridgeInput = {
  skills: readonly SkillMemoryView[];
  intelligence?: LearnerIntelligence | undefined;
  trainingDecision?:
    | TrainingDecision
    | NonNullable<import("@/lib/forge/types").MissionState["trainingDecision"]>
    | undefined;
  assessment?:
    | Pick<
        MissionAssessment,
        "learningSignal" | "grade" | "hintsUsed" | "mistakeBreakdown"
      >
    | undefined;
  recentMistakes?: readonly string[] | undefined;
  recentTopics?: readonly string[] | undefined;
  storyObjects?: readonly string[] | undefined;
  currentDifficulty?: number | undefined;
  candidateExercise?: AdaptiveExercise | undefined;
  environment?: CanonicalEnvironmentModel | undefined;
  supportedCommandKinds?: string[] | undefined;
  knownScenarioArtifacts?: string[] | undefined;
  trackedMissionArtifacts?: MissionArtifact[] | undefined;
  requiredPriorArtifacts?: Array<string | RequiredPriorArtifactSpec> | undefined;
  readiness?: ConceptReadinessResult | undefined;
};

export type AdaptiveMissionCandidateResult = {
  blueprint: MissionBlueprint;
  trainingDecision: TrainingDecision;
  intelligence: LearnerIntelligence;
  validation: MissionV2ValidationResult;
  contract?: Contract | undefined;
  exercise?: AdaptiveExercise | undefined;
  readiness?: ConceptReadinessResult | undefined;
};

function titleCase(str: string): string {
  return str
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Deterministically constructs a compliant candidate AdaptiveExercise for a blueprint.
 */
export function createDeterministicCandidate(blueprint: MissionBlueprint): AdaptiveExercise {
  const primary = blueprint.primarySkill;
  const supporting = blueprint.supportingSkills;
  const skills: SkillId[] = [primary, ...supporting];

  let path = "workspace/target.txt";
  let objectType: "file" | "directory" | "process" | "network" = "file";
  let permissions: string | undefined = undefined;
  let contentEquals: string | undefined = "verified";
  let requiredCommandKinds: string[] = ["mkdir", "touch", "echo"];
  let requiredCapabilities: Array<
    | "interactiveShell"
    | "streaming"
    | "resize"
    | "processes"
    | "services"
    | "environmentVariables"
    | "network"
    | "snapshots"
    | "pauseResume"
    | "packages"
  > | undefined = undefined;
  let minimumMutations = 1;

  if (primary === "permissions") {
    path = "workspace";
    objectType = "directory";
    permissions = "750";
    contentEquals = undefined;
    requiredCommandKinds = ["mkdir", "chmod"];
  } else if (primary === "filesystem") {
    path = "workspace/target.txt";
    objectType = "file";
    contentEquals = "ready";
    requiredCommandKinds = ["mkdir", "touch", "echo"];
  } else if (primary === "iteration") {
    path = "workspace/items.txt";
    objectType = "file";
    contentEquals = "item1\nitem2";
    requiredCommandKinds = ["for", "echo"];
  } else if (primary === "processes") {
    path = "processes";
    objectType = "process";
    contentEquals = undefined;
    requiredCommandKinds = ["ps"];
    requiredCapabilities = ["processes"];
    minimumMutations = 0;
  } else if (primary === "networking") {
    path = "network";
    objectType = "network";
    contentEquals = undefined;
    requiredCommandKinds = ["ip"];
    requiredCapabilities = ["network"];
    minimumMutations = 0;
  } else if (primary === "shell-scripting") {
    path = "workspace/run.sh";
    objectType = "file";
    permissions = "755";
    contentEquals = "#!/bin/bash\necho ok";
    requiredCommandKinds = ["touch", "chmod"];
  } else if (primary === "hardening") {
    path = "workspace/audit.conf";
    objectType = "file";
    permissions = "600";
    contentEquals = "SECURE=1";
    requiredCommandKinds = ["touch", "chmod"];
  }

  const repairText =
    blueprint.archetype === "REMEDIATION"
      ? "Repair and correct prior misconfigurations by following secure practices."
      : "Complete the planned operations accurately in the workspace.";

  const shapePrefix =
    blueprint.objectiveShape && blueprint.objectiveShape.length >= 20
      ? `${blueprint.objectiveShape} `
      : "";

  const objective =
    primary === "processes"
      ? `${shapePrefix}Inspect the running processes with ps in the isolated training lab. ${repairText}`.trim()
      : primary === "networking"
        ? `${shapePrefix}Inspect the local network interfaces with ip in the isolated training lab. ${repairText}`.trim()
        : blueprint.objectiveShape && blueprint.objectiveShape.length >= 20
          ? `${blueprint.objectiveShape} ${repairText}`.trim()
          : `Audit and configure the ${primary} workspace in the isolated training lab. ${repairText}`;

  const allowedApproaches =
    primary === "processes"
      ? ["ps", "ps aux", "ps -ef"]
      : primary === "networking"
        ? ["ip addr", "ip a", "ip address"]
        : [`Use supported Linux utilities for ${primary} configuration.`];

  return {
    id: `adaptive-${primary}-${blueprint.archetype.toLowerCase()}-${blueprint.difficulty}`,
    kind: "mission",
    title: `${titleCase(primary)} ${titleCase(blueprint.archetype)} Mission`,
    scenario: `The security team requires an isolated environment verification for ${primary}. You must inspect or configure the required assets in the training lab safely.`,
    objective,
    skills,
    difficulty: blueprint.difficulty,
    estimatedMinutes: Math.max(5, Math.min(60, blueprint.difficulty * 10)),
    sourceRefs: [
      {
        id: "kali-training",
        name: "Kali Training",
        url: "https://kali.training/",
      },
    ],
    evaluationFocus:
      blueprint.evidenceFocus.length > 0
        ? [...blueprint.evidenceFocus]
        : ["objective completion", "skill demonstration"],
    learnerReason: blueprint.rationale.slice(0, 1200),
    allowedApproaches,
    bannedShortcuts: ["Do not attempt to access host resources or bypass security filters."],
    hints: [`Inspect the current directory and use appropriate commands for ${primary}.`],
    successStory: `Successfully demonstrated and verified ${primary} competence in the lab.`,
    failureStory: `The ${primary} objectives were not completely verified.`,
    remediation: [`Review basic ${primary} command syntax and try the mission again.`],
    evaluationPlan: {
      objectives: [
        {
          label: `Verify ${path} configuration`,
          path,
          objectType,
          ...(permissions ? { permissions } : {}),
          ...(contentEquals ? { contentEquals } : {}),
        },
      ],
      requiredCommandKinds,
      minimumMutations,
      ...(requiredCapabilities ? { requiredCapabilities } : {}),
    },
  };
}

/**
 * Reusable server-side bridge that connects verified evidence and training decisions
 * into a validated, executable mission candidate.
 */
export function buildAdaptiveMissionCandidate(
  input: AdaptiveMissionBridgeInput,
): AdaptiveMissionCandidateResult {
  const mistakeList = [
    ...(input.recentMistakes ?? []),
    ...(input.assessment?.mistakeBreakdown?.map((m) => m.category) ?? []),
  ];

  const intelligence =
    input.intelligence ?? analyzeLearner(input.skills, mistakeList);

  const rawDecision = input.trainingDecision;
  const trainingDecision: TrainingDecision =
    rawDecision && "sourceStrategy" in rawDecision && rawDecision.sourceStrategy
      ? (rawDecision as TrainingDecision)
      : rawDecision
        ? {
            ...rawDecision,
            version: "v37" as const,
            sourceStrategy: (rawDecision.sourceStrategy as TrainingDecision["sourceStrategy"]) ?? "targeted-patterns",
            masteryGate: (rawDecision.masteryGate as TrainingDecision["masteryGate"]) ?? "PRACTICE",
            journeyPhase: rawDecision.journeyPhase ?? "ACTIVE_TRAINING",
            journeyNextSkills: rawDecision.journeyNextSkills ? [...rawDecision.journeyNextSkills] : [],
            focusMistakes: rawDecision.focusMistakes ? [...rawDecision.focusMistakes] : [],
          }
        : selectAdaptiveTraining({
            skills: input.skills,
            intelligence,
            ...(input.assessment !== undefined ? { assessment: input.assessment } : {}),
            currentDifficulty: input.currentDifficulty ?? 1,
          });

  const readiness =
    input.readiness ??
    evaluateConceptReadiness({
      targetSkill: trainingDecision.primarySkill,
      environment: input.environment,
      skills: input.skills,
      knownScenarioArtifacts: input.knownScenarioArtifacts,
      supportedCommandKinds: input.supportedCommandKinds,
    });

  const rawBlueprint = buildMissionBlueprint({
    skills: input.skills,
    intelligence,
    ...(input.recentMistakes !== undefined ? { recentMistakes: input.recentMistakes } : {}),
    ...(input.recentTopics !== undefined ? { recentTopics: input.recentTopics } : {}),
    ...(input.storyObjects !== undefined ? { storyObjects: input.storyObjects } : {}),
    currentDifficulty: input.currentDifficulty ?? trainingDecision.difficulty,
    trainingDecision,
    environment: input.environment,
    readiness,
    knownScenarioArtifacts: input.knownScenarioArtifacts,
  });

  const validSupporting = rawBlueprint.supportingSkills.filter(
    (s) => !(SKILL_GRAPH[s] ?? []).includes(rawBlueprint.primarySkill),
  );
  const validPrereqs = [
    ...new Set([
      ...(SKILL_GRAPH[rawBlueprint.primarySkill] ?? []),
      ...validSupporting.flatMap((s) => SKILL_GRAPH[s] ?? []),
    ]),
  ].filter((p) => p !== rawBlueprint.primarySkill);

  const blueprint: MissionBlueprint = {
    ...rawBlueprint,
    supportingSkills: validSupporting,
    prerequisites: validPrereqs,
  };

  const candidate = input.candidateExercise ?? createDeterministicCandidate(blueprint);

  const context: MissionV2Context = {
    blueprint,
    environment: input.environment,
    supportedCommandKinds: input.supportedCommandKinds,
    knownScenarioArtifacts: input.knownScenarioArtifacts,
    trackedMissionArtifacts: input.trackedMissionArtifacts,
    requiredPriorArtifacts: input.requiredPriorArtifacts,
  };

  const validation = validateAndPublishMissionV2(candidate, context);

  return {
    blueprint,
    trainingDecision,
    intelligence,
    validation,
    contract: validation.ok ? validation.contract : undefined,
    exercise: validation.ok ? validation.exercise : undefined,
    readiness,
  };
}
