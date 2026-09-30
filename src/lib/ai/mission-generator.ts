import type { ObservationCategory, SkillId, SkillMemoryView } from "@/lib/forge/types";
import { retrieveKnowledgeChunks } from "./knowledge-retrieval";
import type { LearnerIntelligence } from "./learner-intelligence";
import type { TrainingDecision } from "./adaptive-training";

export type MissionArchetype =
  "REMEDIATION" | "SPACED_REVIEW" | "TRANSFER" | "PROGRESSION" | "MIXED_REINFORCEMENT";

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
  intelligence: LearnerIntelligence;
  recentMistakes?: readonly string[];
  recentTopics?: readonly string[];
  currentDifficulty?: number;
  storyObjects?: readonly string[];
  trainingDecision?: TrainingDecision;
}): MissionBlueprint {
  const ranked = [...input.skills].sort((a, b) => priority(b) - priority(a));
  const weak = ranked.filter((s) => s.mastery < 60);
  const due = ranked.filter((s) => s.nextReview && Date.parse(s.nextReview) <= Date.now());
  const primary =
    input.trainingDecision?.primarySkill ??
    (weak[0] ?? due[0] ?? ranked[0])?.skillId ??
    input.intelligence.focusSkills[0] ??
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

  const recentMistakes = [...(input.recentMistakes ?? []), ...input.intelligence.dominantMistakes];
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
  else if (input.intelligence.readiness >= 78 && input.intelligence.independence >= 70)
    archetype = "PROGRESSION";
  else if (input.intelligence.readiness >= 60) archetype = "TRANSFER";

  const adjustment = input.intelligence.difficultyAdjustment;
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

  const storyContinuity = input.storyObjects?.length
    ? `Continue the learner's existing lab story using one or more existing artifacts when appropriate: ${input.storyObjects.slice(-4).join(", ")}.`
    : "Create a small, self-contained lab story that can become a reusable artifact for a later mission.";

  const objectiveShape =
    archetype === "REMEDIATION"
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
    rationale: `${input.trainingDecision?.reason ?? `${archetype} selected for ${primary}`}; readiness ${input.intelligence.readiness}, independence ${input.intelligence.independence}, difficulty adjustment ${adjustment}. Grounding: ${grounding.map((g) => g.id).join(", ") || "none"}. Recent topics considered: ${(input.recentTopics ?? []).slice(-3).join(" | ") || "none"}.`,
    ...(input.trainingDecision ? { trainingDecision: input.trainingDecision } : {}),
  };
}
