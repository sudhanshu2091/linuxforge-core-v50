import type { ObservationCategory, SkillId, SkillMemoryView } from "@/lib/forge/types";

export type LearnerSignal =
  | "NEW_TO_SKILL"
  | "BUILDING"
  | "FRAGILE"
  | "DEPENDENT"
  | "CONCEPT_GAP"
  | "RECOVERING"
  | "INDEPENDENT"
  | "MASTERED";

export type LearnerIntelligence = {
  focusSkills: SkillId[];
  fragileSkills: SkillId[];
  masteredSkills: SkillId[];
  dominantMistakes: ObservationCategory[];
  repeatedMistakes: ObservationCategory[];
  averageMastery: number;
  hintDependency: number;
  independence: number;
  confidence: number;
  readiness: number;
  difficultyAdjustment: -1 | 0 | 1;
  signals: LearnerSignal[];
  explanation: string;
};

const clamp = (n: number, min = 0, max = 100) => Math.max(min, Math.min(max, n));

export function analyzeLearner(
  skills: readonly SkillMemoryView[],
  recentMistakes: readonly string[] = [],
): LearnerIntelligence {
  const observed = skills.filter((s) => s.attempts > 0);
  const averageMastery = observed.length
    ? Math.round(observed.reduce((sum, s) => sum + s.mastery, 0) / observed.length)
    : 0;
  const focusSkills = [...skills]
    .filter((s) => s.mastery < 65 || s.confidence < 55)
    .sort((a, b) => a.mastery - b.mastery || a.confidence - b.confidence)
    .slice(0, 4)
    .map((s) => s.skillId);
  const fragileSkills = skills
    .filter(
      (s) =>
        s.mastery >= 55 &&
        ((s.confidence ?? 50) < 60 ||
          (s.retention ?? s.mastery) < 60 ||
          (s.recentMistakes ?? []).some((m) => m === "SKILL_BYPASS" || m === "UNSAFE_APPROACH")),
    )
    .sort((a, b) => (a.retention ?? a.mastery) - (b.retention ?? b.mastery))
    .slice(0, 4)
    .map((s) => s.skillId);
  const masteredSkills = skills
    .filter((s) => s.mastery >= 80 && (s.confidence ?? 50) >= 70 && (s.recentMistakes ?? []).length === 0)
    .map((s) => s.skillId);

  const mistakeCounts = new Map<ObservationCategory, number>();
  for (const value of [...recentMistakes, ...skills.flatMap((s) => s.recentMistakes ?? [])]) {
    if (!isMistake(value)) continue;
    mistakeCounts.set(value, (mistakeCounts.get(value) ?? 0) + 1);
  }
  const dominantMistakes = [...mistakeCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([category]) => category);
  const repeatedMistakes = [...mistakeCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([category]) => category);

  const hintDependency = skills.length
    ? Math.round(skills.reduce((sum, s) => sum + (s.hintDependency ?? 0), 0) / skills.length)
    : 0;
  const independence = skills.length
    ? Math.round(
        skills.reduce(
          (sum, s) => sum + (s.independence ?? Math.max(0, 100 - (s.hintDependency ?? 0))),
          0,
        ) / skills.length,
      )
    : 50;
  const confidence = skills.length
    ? Math.round(skills.reduce((sum, s) => sum + (s.confidence ?? 50), 0) / skills.length)
    : 50;
  const readiness = clamp(
    Math.round(
      averageMastery * 0.45 + confidence * 0.25 + independence * 0.2 + (100 - hintDependency) * 0.1,
    ),
  );

  const signals: LearnerSignal[] = [];
  if (!observed.length) signals.push("NEW_TO_SKILL");
  if (focusSkills.length) signals.push("BUILDING");
  if (fragileSkills.length) signals.push("FRAGILE");
  if (hintDependency >= 55) signals.push("DEPENDENT");
  if (
    repeatedMistakes.some(
      (m) => m === "CONCEPT_CONFUSION" || m === "MISREAD_QUESTION" || m === "SKILL_BYPASS",
    )
  )
    signals.push("CONCEPT_GAP");
  if (
    dominantMistakes.length &&
    dominantMistakes.every((m) =>
      ["TYPO", "WRONG_PATH", "WRONG_FILENAME", "WRONG_ARGUMENT"].includes(m),
    )
  )
    signals.push("RECOVERING");
  if (independence >= 75 && confidence >= 70) signals.push("INDEPENDENT");
  if (masteredSkills.length && averageMastery >= 80) signals.push("MASTERED");

  const difficultyAdjustment: -1 | 0 | 1 =
    readiness >= 78 && independence >= 70 && hintDependency < 35
      ? 1
      : readiness < 42 || hintDependency >= 70
        ? -1
        : 0;
  const explanation =
    difficultyAdjustment === 1
      ? "Evidence supports a modest increase in challenge while preserving the learner's focus skills."
      : difficultyAdjustment === -1
        ? "Evidence suggests keeping difficulty manageable while repairing weak or dependent areas."
        : "Keep the current difficulty and use targeted practice until stronger evidence appears.";

  return {
    focusSkills,
    fragileSkills,
    masteredSkills,
    dominantMistakes,
    repeatedMistakes,
    averageMastery,
    hintDependency,
    independence,
    confidence,
    readiness,
    difficultyAdjustment,
    signals,
    explanation,
  };
}

export function skillPriority(skill: SkillMemoryView): number {
  const weakness = 100 - skill.mastery;
  const fragility = 100 - (skill.retention ?? skill.mastery);
  const confidenceGap = 100 - skill.confidence;
  const recency = skill.nextReview && Date.parse(skill.nextReview) <= Date.now() ? 20 : 0;
  return Math.round(weakness * 0.45 + fragility * 0.25 + confidenceGap * 0.2 + recency * 0.1);
}

function isMistake(value: string): value is ObservationCategory {
  return [
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
  ].includes(value);
}
