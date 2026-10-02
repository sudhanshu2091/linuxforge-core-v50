import type {
  MissionAssessment,
  ObservationCategory,
  SkillId,
  SkillMemoryView,
} from "@/lib/forge/types";
import type { LearnerIntelligence } from "./learner-intelligence";
import { decideProgression } from "@/lib/learner/mastery-engine";
import { buildLearnerJourney } from "@/lib/learner/journey-engine";
import {
  buildSpecialTrainingBatch,
  evaluateBatchTrigger,
  type TrainingBatch,
} from "@/lib/learner/training-batches";

export type LearningMode =
  "REMEDIATION" | "GUIDED_PRACTICE" | "SPACED_REVIEW" | "TRANSFER" | "PROGRESSION" | "ASSESSMENT";

export type TrainingDecision = {
  version: "v37";
  mode: LearningMode;
  primarySkill: SkillId;
  supportingSkills: SkillId[];
  difficulty: number;
  reason: string;
  evidence: string[];
  focusMistakes: ObservationCategory[];
  constraints: string[];
  sourceStrategy:
    "targeted-patterns" | "review-patterns" | "transfer-patterns" | "progression-patterns";
  masteryGate: "PRACTICE" | "REVIEW" | "CONFIRM_MASTERY" | "ADVANCE" | "REMEDIATE";
  journeyPhase: string;
  journeyNextSkills: SkillId[];
  specialBatch?: TrainingBatch | undefined;
};

const SKILL_GRAPH: Record<SkillId, SkillId[]> = {
  filesystem: [],
  permissions: ["filesystem"],
  iteration: ["filesystem"],
  "shell-scripting": ["filesystem", "iteration"],
  processes: ["filesystem", "shell-scripting"],
  networking: ["filesystem"],
  hardening: ["filesystem", "permissions", "networking"],
};

const MISTAKES: readonly ObservationCategory[] = [
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

const clamp = (value: number, min = 1, max = 5) => Math.max(min, Math.min(max, Math.round(value)));

function isMistake(value: string): value is ObservationCategory {
  return MISTAKES.includes(value as ObservationCategory);
}

function skillPriority(skill: SkillMemoryView): number {
  const weakness = 100 - skill.mastery;
  const fragility = 100 - (skill.retention ?? skill.mastery);
  const confidenceGap = 100 - skill.confidence;
  const due = skill.nextReview && Date.parse(skill.nextReview) <= Date.now() ? 25 : 0;
  const errors = Math.min(20, (skill.recentMistakes ?? []).length * 5);
  const evidenceGap = Math.max(0, 10 - (skill.evidenceCount ?? skill.attempts));
  return (
    weakness * 0.38 +
    fragility * 0.22 +
    confidenceGap * 0.18 +
    due * 0.1 +
    errors * 0.08 +
    evidenceGap * 0.04
  );
}

function pickSupporting(skills: readonly SkillMemoryView[], primary: SkillId): SkillId[] {
  const prerequisiteSkills = SKILL_GRAPH[primary] ?? [];
  const nearby = [...skills]
    .filter((skill) => skill.skillId !== primary && skill.mastery < 80)
    .sort((a, b) => skillPriority(b) - skillPriority(a))
    .map((skill) => skill.skillId);
  return [...new Set([...prerequisiteSkills, ...nearby])]
    .filter((skill) => skill !== primary)
    .slice(0, 2);
}

function collectMistakes(
  skills: readonly SkillMemoryView[],
  assessment?: Pick<MissionAssessment, "mistakeBreakdown"> | null,
): ObservationCategory[] {
  const values = [
    ...(assessment?.mistakeBreakdown?.flatMap((item) =>
      Array.from({ length: item.count }, () => item.category),
    ) ?? []),
    ...skills.flatMap((skill) => skill.recentMistakes ?? []),
  ];
  const counts = new Map<ObservationCategory, number>();
  for (const value of values) {
    if (!isMistake(value)) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([category]) => category);
}

export function selectAdaptiveTraining(input: {
  skills: readonly SkillMemoryView[];
  intelligence: LearnerIntelligence;
  assessment?: Pick<
    MissionAssessment,
    "learningSignal" | "grade" | "mistakeBreakdown" | "hintsUsed"
  > | null;
  currentDifficulty?: number;
}): TrainingDecision {
  const ranked = [...input.skills].sort((a, b) => skillPriority(b) - skillPriority(a));
  const candidatePrimary = ranked[0]?.skillId ?? input.intelligence.focusSkills[0] ?? "filesystem";
  const current = clamp(input.currentDifficulty ?? 1);
  const assessment = input.assessment;
  const initialMasteryDecision = decideProgression({
    skills: input.skills,
    targetSkills: [candidatePrimary],
    ...(assessment ? { assessment } : {}),
  });
  // Once a skill has actually passed V36, select a newly eligible skill rather
  // than repeatedly training the already-mastered skill.
  const nextEligibleSkill =
    initialMasteryDecision.action === "ADVANCE"
      ? initialMasteryDecision.eligibleNextSkills[0]
      : undefined;
  const journey = buildLearnerJourney({ skills: input.skills, trainingDecision: null });
  const primary = nextEligibleSkill ?? candidatePrimary;
  const supporting = pickSupporting(input.skills, primary);
  const mistakes = collectMistakes(input.skills, input.assessment);
  const topMistake = mistakes[0];
  const due = ranked.filter(
    (skill) => skill.nextReview && Date.parse(skill.nextReview) <= Date.now(),
  );
  const weak = ranked.filter((skill) => skill.mastery < 60 || skill.confidence < 55);
  const masteryDecision = initialMasteryDecision;

  let mode: LearningMode;
  let sourceStrategy: TrainingDecision["sourceStrategy"];
  let difficulty = current + input.intelligence.difficultyAdjustment;
  let reason: string;
  const evidence: string[] = [];
  const constraints: string[] = [];

  if (masteryDecision.action === "REMEDIATE") {
    mode = "REMEDIATION";
    sourceStrategy = "targeted-patterns";
    difficulty = current;
    reason = masteryDecision.rationale;
    evidence.push(...masteryDecision.gateReasons);
    constraints.push("Keep the task inside the approved isolated lab workflow.");
  } else if (
    assessment?.learningSignal === "blocked" ||
    topMistake === "UNSAFE_APPROACH" ||
    input.intelligence.repeatedMistakes.includes("UNSAFE_APPROACH")
  ) {
    mode = "REMEDIATION";
    sourceStrategy = "targeted-patterns";
    difficulty = current;
    reason = "Safety evidence requires a controlled remediation cycle before increasing challenge.";
    evidence.push("safety boundary or unsafe approach detected");
    constraints.push("Keep the task inside the approved isolated lab workflow.");
    constraints.push("Enforce strict parameter and path boundaries.");
  } else if (
    topMistake === "SKILL_BYPASS" ||
    input.intelligence.repeatedMistakes.includes("SKILL_BYPASS")
  ) {
    mode = "GUIDED_PRACTICE";
    sourceStrategy = "targeted-patterns";
    difficulty = current;
    reason =
      "Target skill was bypassed or unobserved; a guided practice cycle is required to verify the specific technique.";
    evidence.push("skill bypass detected; method evidence required");
    constraints.push("Require explicit method evidence rather than verifying only output state.");
  } else if (
    topMistake === "TYPO" &&
    mistakes.every((m) => m === "TYPO") &&
    assessment &&
    assessment.grade >= 70
  ) {
    mode = "GUIDED_PRACTICE";
    sourceStrategy = "targeted-patterns";
    difficulty = current;
    reason =
      "Command failure was driven by typing errors rather than conceptual misunderstanding; repeat with low penalty.";
    evidence.push("isolated typo detected");
    constraints.push("Provide exact syntax patterns and focus on accurate typing.");
  } else if (
    assessment?.learningSignal === "needs_practice" ||
    (assessment && assessment.grade < 70) ||
    input.intelligence.signals.includes("CONCEPT_GAP")
  ) {
    mode = "REMEDIATION";
    sourceStrategy = "targeted-patterns";
    difficulty = Math.max(1, current - 1);
    reason =
      "Recent evidence indicates a weak or misunderstood concept that should be repaired before progression.";
    evidence.push(`readiness ${input.intelligence.readiness}`, `focus skill ${primary}`);
    if (topMistake) evidence.push(`repeated evidence around ${topMistake}`);
  } else if (masteryDecision.action === "REVIEW") {
    mode = "SPACED_REVIEW";
    sourceStrategy = "review-patterns";
    difficulty = current;
    reason = masteryDecision.rationale;
    evidence.push(...masteryDecision.gateReasons);
  } else if (masteryDecision.action === "CONFIRM_MASTERY") {
    mode = "ASSESSMENT";
    sourceStrategy = "targeted-patterns";
    difficulty = current;
    reason = masteryDecision.rationale;
    evidence.push(...masteryDecision.gateReasons);
    constraints.push("Use a distinct scenario; do not copy the prior task.");
  } else if (masteryDecision.action === "ADVANCE") {
    mode = "PROGRESSION";
    sourceStrategy = "progression-patterns";
    difficulty += 1;
    reason = nextEligibleSkill
      ? `Mastery gate passed for ${candidatePrimary}; the next prerequisite-eligible skill is ${nextEligibleSkill}.`
      : masteryDecision.rationale;
    evidence.push(...masteryDecision.gateReasons);
    if (nextEligibleSkill) evidence.push(`next eligible skill ${nextEligibleSkill}`);
  } else if (due.length > 0) {
    mode = "SPACED_REVIEW";
    sourceStrategy = "review-patterns";
    difficulty = current;
    reason =
      "One or more skills are due for retrieval practice, so retention is checked before adding complexity.";
    evidence.push(
      `review due: ${due
        .slice(0, 3)
        .map((skill) => skill.skillId)
        .join(", ")}`,
    );
  } else if (
    assessment?.learningSignal === "mastered" &&
    assessment.grade >= 85 &&
    input.intelligence.independence >= 70 &&
    input.intelligence.hintDependency < 35 &&
    !input.intelligence.signals.includes("DEPENDENT")
  ) {
    mode = "PROGRESSION";
    sourceStrategy = "progression-patterns";
    difficulty += 1;
    reason =
      "The latest run was independently verified at a high level, supporting a controlled increase in complexity.";
    evidence.push(
      `verified grade ${assessment.grade}`,
      `independence ${input.intelligence.independence}`,
    );
  } else if (
    input.intelligence.readiness >= 78 &&
    input.intelligence.independence >= 70 &&
    input.intelligence.hintDependency < 35 &&
    !input.intelligence.signals.includes("DEPENDENT")
  ) {
    mode = "PROGRESSION";
    sourceStrategy = "progression-patterns";
    difficulty += 1;
    reason = "Readiness, confidence and independence support a modest increase in challenge.";
    evidence.push(
      `readiness ${input.intelligence.readiness}`,
      `independence ${input.intelligence.independence}`,
    );
  } else if (input.intelligence.readiness >= 60) {
    mode = "TRANSFER";
    sourceStrategy = "transfer-patterns";
    reason =
      "The learner has enough foundation to apply the target skill in a new context without jumping directly to a higher difficulty.";
    evidence.push(
      `readiness ${input.intelligence.readiness}`,
      `confidence ${input.intelligence.confidence}`,
    );
  } else if (weak.length || input.intelligence.hintDependency >= 45) {
    mode = "GUIDED_PRACTICE";
    sourceStrategy = "targeted-patterns";
    difficulty = current;
    reason =
      "The learner needs another focused practice cycle with controlled guidance and observable evidence.";
    evidence.push(
      `readiness ${input.intelligence.readiness}`,
      `hint dependency ${input.intelligence.hintDependency}`,
    );
    constraints.push(
      "Prefer a small number of explicit success checks over unnecessary task complexity.",
    );
  } else {
    mode = "ASSESSMENT";
    sourceStrategy = "targeted-patterns";
    difficulty = current;
    reason =
      "There is not enough recent evidence to justify a large adaptation, so the next activity should gather clean evidence.";
    evidence.push("limited recent evidence");
  }

  if (input.intelligence.hintDependency >= 50 || input.intelligence.signals.includes("DEPENDENT")) {
    difficulty = Math.min(difficulty, current);
    constraints.push(
      "Do not increase difficulty until the learner demonstrates more independent execution.",
    );
  }
  if (input.intelligence.signals.includes("CONCEPT_GAP"))
    constraints.push("Test the underlying concept, not just command recall.");
  if (mode === "SPACED_REVIEW")
    constraints.push("Change the context while preserving the reviewed concept.");
  if (mode === "TRANSFER")
    constraints.push(
      "Use a new scenario and combine the primary skill with at most two supporting skills.",
    );
  if (mode === "PROGRESSION")
    constraints.push("Increase complexity without removing objective verifiability.");

  const batchTrigger = evaluateBatchTrigger({
    skills: input.skills,
    intelligence: input.intelligence,
    recentMistakes: mistakes,
    assessment: input.assessment,
  });

  const specialBatch =
    batchTrigger.batchRecommended && batchTrigger.recommendedBatchType
      ? buildSpecialTrainingBatch({
          batchType: batchTrigger.recommendedBatchType,
          primarySkill: batchTrigger.primarySkill ?? primary,
          skills: input.skills,
          intelligence: input.intelligence,
          targetWeakness: batchTrigger.targetWeakness,
          baseDifficulty: clamp(difficulty),
        })
      : undefined;

  return {
    version: "v37",
    mode,
    primarySkill: primary,
    supportingSkills: supporting,
    difficulty: clamp(difficulty),
    reason,
    evidence,
    focusMistakes: mistakes,
    constraints,
    sourceStrategy,
    masteryGate: masteryDecision.action,
    journeyPhase: journey.currentPhaseName,
    journeyNextSkills: journey.nextSkills,
    ...(specialBatch ? { specialBatch } : {}),
  };
}
