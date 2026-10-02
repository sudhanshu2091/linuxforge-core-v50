import type { ObservationCategory, SkillId, SkillMemoryView } from "@/lib/forge/types";
import { retrieveKnowledgeChunks } from "./knowledge-retrieval";
import { analyzeLearner, type LearnerIntelligence } from "./learner-intelligence";
import type { TrainingDecision } from "./adaptive-training";
import type { CanonicalEnvironmentModel } from "@/lib/forge/environment/types";
import type { ConceptReadinessResult } from "./concept-readiness";

export type MissionArchetype =
  "REMEDIATION" | "SPACED_REVIEW" | "TRANSFER" | "PROGRESSION" | "MIXED_REINFORCEMENT";

export type EnvironmentContextSummary = {
  currentUser: string | null;
  currentDirectory: string;
  observedFiles: Array<{ path: string; objectType: "file" | "directory"; permissions?: string | undefined }>;
  tmpArtifacts: Array<{ path: string; objectType: "file" | "directory" }>;
  availableArtifacts: Array<{ id: string; kind: string; identifier: string }>;
  capabilities: Record<string, boolean>;
  readiness: {
    ready: boolean;
    missingPrerequisites: string[];
    missingCapabilities: string[];
    setupRequired: boolean;
    setupPlan?: string | undefined;
  };
};

export type MissionBlueprint = {
  version: "v32";
  archetype: MissionArchetype;
  primarySkill: SkillId;
  supportingSkills: SkillId[];
  difficulty: number;
  prerequisites: SkillId[];
  objectiveShape: string;
  storyContinuity: string;
  evidenceFocus: string[];
  knowledgeIds: string[];
  mistakeFocus: ObservationCategory | null;
  rationale: string;
  trainingDecision?: TrainingDecision;

  // Grounded environment & scenario opportunity extensions
  environmentContext?: EnvironmentContextSummary | undefined;
  readiness?: ConceptReadinessResult | undefined;
  availableArtifacts?: string[] | undefined;
  scenarioOpportunities?: string[] | undefined;
  expectedObservableOutcome?: string | undefined;
  continuityRequirements?: string[] | undefined;
  pedagogicalGoal?: string | undefined;
  trustedKnowledgeReferences?: Array<{ id: string; name: string; url: string }> | undefined;
};

export const SKILL_GRAPH: Record<SkillId, SkillId[]> = {
  filesystem: [],
  permissions: ["filesystem"],
  iteration: ["filesystem"],
  "shell-scripting": ["filesystem", "iteration"],
  processes: ["filesystem", "shell-scripting"],
  networking: ["filesystem"],
  hardening: ["filesystem", "permissions", "networking"],
};

const clamp = (n: number) => Math.max(1, Math.min(5, Math.round(n)));

function priority(skill: SkillMemoryView): number {
  const weakness = 100 - skill.mastery;
  const fragility = 100 - (skill.retention ?? skill.mastery);
  const confidenceGap = 100 - skill.confidence;
  const due = skill.nextReview && Date.parse(skill.nextReview) <= Date.now() ? 20 : 0;
  return weakness * 0.5 + fragility * 0.2 + confidenceGap * 0.2 + due * 0.1;
}

export function buildMissionBlueprint(input: {
  skills: readonly SkillMemoryView[];
  intelligence?: LearnerIntelligence | undefined;
  recentMistakes?: readonly string[];
  recentTopics?: readonly string[];
  currentDifficulty?: number;
  storyObjects?: readonly string[];
  trainingDecision?: TrainingDecision;
  environment?: CanonicalEnvironmentModel | undefined;
  readiness?: ConceptReadinessResult | undefined;
  knownScenarioArtifacts?: readonly string[] | undefined;
}): MissionBlueprint {
  const intelligence =
    input.intelligence ?? analyzeLearner(input.skills, input.recentMistakes);

  const ranked = [...input.skills].sort((a, b) => priority(b) - priority(a));
  const weak = ranked.filter((s) => s.mastery < 60);
  const due = ranked.filter((s) => s.nextReview && Date.parse(s.nextReview) <= Date.now());
  const primary =
    input.trainingDecision?.primarySkill ??
    (weak[0] ?? due[0] ?? ranked[0])?.skillId ??
    intelligence.focusSkills[0] ??
    "filesystem";
  const supporting = [
    ...new Set([
      ...(input.trainingDecision?.supportingSkills ?? []),
      ...ranked
        .filter((s) => s.skillId !== primary && s.mastery < 75)
        .slice(0, 2)
        .map((s) => s.skillId),
      ...(SKILL_GRAPH[primary] ?? []),
    ]),
  ]
    .filter((s) => s !== primary)
    .slice(0, 2);

  const recentMistakes = [...(input.recentMistakes ?? []), ...intelligence.dominantMistakes];
  const mistakeFocus =
    recentMistakes.find((m): m is ObservationCategory =>
      [
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
      ].includes(m),
    ) ?? null;

  let archetype: MissionArchetype = "MIXED_REINFORCEMENT";
  if (input.trainingDecision?.mode === "REMEDIATION") archetype = "REMEDIATION";
  else if (input.trainingDecision?.mode === "SPACED_REVIEW") archetype = "SPACED_REVIEW";
  else if (input.trainingDecision?.mode === "TRANSFER") archetype = "TRANSFER";
  else if (input.trainingDecision?.mode === "PROGRESSION") archetype = "PROGRESSION";
  else if (mistakeFocus === "UNSAFE_APPROACH") archetype = "REMEDIATION";
  else if (weak.length) archetype = mistakeFocus ? "REMEDIATION" : "MIXED_REINFORCEMENT";
  else if (due.length) archetype = "SPACED_REVIEW";
  else if (intelligence.readiness >= 78 && intelligence.independence >= 70)
    archetype = "PROGRESSION";
  else if (intelligence.readiness >= 60) archetype = "TRANSFER";

  const adjustment = intelligence.difficultyAdjustment;
  const difficulty =
    input.trainingDecision?.difficulty ??
    clamp((input.currentDifficulty ?? 1) + adjustment + (archetype === "PROGRESSION" ? 1 : 0));
  const grounding = retrieveKnowledgeChunks({
    query: [primary, ...supporting, ...(mistakeFocus ? [mistakeFocus] : [])].join(" "),
    skills: [primary, ...supporting],
    mistake: mistakeFocus,
    difficulty,
    limit: 4,
  });

  // Construct bounded environment context and scenario opportunities if environment is available
  let environmentContext: EnvironmentContextSummary | undefined = undefined;
  const scenarioOpportunities: string[] = [];
  const availableArtifacts: string[] = [];

  if (input.environment) {
    const env = input.environment;
    const safeFiles: Array<{ path: string; objectType: "file" | "directory"; permissions?: string | undefined }> = (env.filesystem ?? [])
      .filter((f) => !f.path.startsWith("etc/") && !f.path.startsWith("proc/") && !f.path.startsWith("sys/") && !f.path.includes(".env"))
      .slice(0, 10)
      .map((f) => ({
        path: f.path,
        objectType: f.objectType === "directory" ? ("directory" as const) : ("file" as const),
        ...(f.permissions ? { permissions: f.permissions } : {}),
      }));

    const tmpFiles: Array<{ path: string; objectType: "file" | "directory" }> = (env.filesystem ?? [])
      .filter((f) => f.path.startsWith("tmp/") || f.path.startsWith("/tmp/"))
      .slice(0, 5)
      .map((f) => ({
        path: f.path,
        objectType: f.objectType === "directory" ? ("directory" as const) : ("file" as const),
      }));

    const artifacts = (env.artifacts ?? []).map((a) => {
      availableArtifacts.push(a.identifier);
      return { id: a.id, kind: a.kind, identifier: a.identifier };
    });

    for (const path of input.knownScenarioArtifacts ?? []) {
      if (!availableArtifacts.includes(path)) {
        availableArtifacts.push(path);
      }
    }

    const capabilities: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(env.runtime?.capabilities ?? {})) {
      if (typeof v === "boolean") capabilities[k] = v;
    }

    environmentContext = {
      currentUser: env.identity.currentUser ?? "learner",
      currentDirectory: env.identity.shell ? "workspace" : "~",
      observedFiles: safeFiles,
      tmpArtifacts: tmpFiles,
      availableArtifacts: artifacts,
      capabilities,
      readiness: {
        ready: input.readiness?.ready ?? true,
        missingPrerequisites: (input.readiness?.missingPrerequisites ?? []).map(String),
        missingCapabilities: (input.readiness?.missingCapabilities ?? []).map(String),
        setupRequired: input.readiness?.status === "SETUP_REQUIRED",
        ...(input.readiness?.setupPlan ? { setupPlan: input.readiness.setupPlan } : {}),
      },
    };

    // Synthesize realistic scenario opportunities from existing artifacts
    for (const file of safeFiles) {
      if (file.objectType === "file") {
        scenarioOpportunities.push(`Audit and inspect configuration in existing file: ${file.path}`);
        if (file.permissions) {
          scenarioOpportunities.push(`Locate file ${file.path} and verify or adjust permissions (currently ${file.permissions})`);
        }
      } else if (file.objectType === "directory") {
        scenarioOpportunities.push(`Use existing directory ${file.path} for mission operations`);
      }
    }

    for (const tmp of tmpFiles) {
      scenarioOpportunities.push(`Investigate temporary artifact ${tmp.path} and safely review its state`);
    }
  }

  if (scenarioOpportunities.length === 0) {
    scenarioOpportunities.push("Create a new artifact in the workspace only when the current environment does not provide one");
  }

  const storyContinuity = input.storyObjects?.length
    ? `Continue the learner's existing lab story using one or more existing artifacts when appropriate: ${input.storyObjects.slice(-4).join(", ")}. Available opportunities: ${scenarioOpportunities.slice(0, 2).join("; ")}.`
    : `Create a small, self-contained lab story. ${scenarioOpportunities[0] ?? ""}`;

  const objectiveShape =
    input.readiness?.status === "SETUP_REQUIRED" && input.readiness.setupPlan
      ? `Prepare the lab environment: ${input.readiness.setupPlan}`
      : archetype === "REMEDIATION"
        ? `Repair and re-demonstrate ${primary} while directly addressing ${mistakeFocus ?? "the learner's weakest evidence"}.`
        : archetype === "SPACED_REVIEW"
          ? `Retrieve and apply ${primary} in a slightly changed context, without copying a previous task.`
          : archetype === "TRANSFER"
            ? `Apply ${primary} together with ${supporting.join(" and ") || "a nearby skill"} in a new context.`
            : archetype === "PROGRESSION"
              ? `Extend ${primary} into a higher-complexity task while retaining an observable success criterion.`
              : `Reinforce ${primary} and introduce one controlled supporting concept.`;

  const prerequisites = [
    ...new Set([
      ...(SKILL_GRAPH[primary] ?? []),
      ...supporting.flatMap((skill) => SKILL_GRAPH[skill] ?? []),
    ]),
  ];

  return {
    version: "v32",
    archetype,
    primarySkill: primary,
    supportingSkills: supporting,
    difficulty,
    prerequisites,
    objectiveShape,
    storyContinuity,
    evidenceFocus: [
      "objective completion",
      "skill demonstration",
      "method evidence",
      ...(mistakeFocus ? [`repair ${mistakeFocus}`] : []),
    ],
    knowledgeIds: grounding.map((chunk) => chunk.id),
    mistakeFocus,
    rationale: `${input.trainingDecision?.reason ?? `${archetype} selected for ${primary}`}; readiness ${intelligence.readiness}, independence ${intelligence.independence}, difficulty adjustment ${adjustment}. Grounding: ${grounding.map((g) => g.id).join(", ") || "none"}. Recent topics considered: ${(input.recentTopics ?? []).slice(-3).join(" | ") || "none"}.`,
    ...(input.trainingDecision ? { trainingDecision: input.trainingDecision } : {}),
    ...(environmentContext ? { environmentContext } : {}),
    ...(input.readiness ? { readiness: input.readiness } : {}),
    ...(availableArtifacts.length > 0 ? { availableArtifacts } : {}),
    scenarioOpportunities,
    expectedObservableOutcome: `Demonstrated ${primary} with verifiable lab evidence.`,
    continuityRequirements: input.storyObjects ? [...input.storyObjects] : [],
    pedagogicalGoal: `Mastery reinforcement for ${primary} at difficulty level ${difficulty}.`,
    trustedKnowledgeReferences: grounding.flatMap((g) =>
      g.sourceRefs?.length
        ? g.sourceRefs
        : [{ id: g.id, name: g.title, url: `https://kali.training/#${g.id}` }],
    ),
  };
}

export {
  buildAdaptiveMissionCandidate,
  type AdaptiveMissionBridgeInput,
  type AdaptiveMissionCandidateResult,
} from "./adaptive-mission-bridge";

