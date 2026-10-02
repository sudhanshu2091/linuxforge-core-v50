/**
 * V36 — deterministic mastery and progression engine.
 *
 * This module is intentionally pure: no AI, database, network, or UI. It
 * converts persisted learner evidence into an explainable mastery state and
 * a progression gate. The verifier remains authoritative for task correctness.
 */
import type {
  MissionAssessment,
  ProgressionAction,
  SkillId,
  SkillMasteryView,
  SkillMemoryView,
  MasteryState,
  ProgressionDecisionView,
  VerificationStatus,
} from "@/lib/forge/types";

export const PREREQUISITES: Record<SkillId, SkillId[]> = {
  filesystem: [],
  permissions: ["filesystem"],
  iteration: ["filesystem"],
  "shell-scripting": ["filesystem", "iteration"],
  processes: ["filesystem", "shell-scripting"],
  networking: ["filesystem"],
  hardening: ["filesystem", "permissions", "networking"],
};

const RISK_MISTAKES = new Set([
  "CONCEPT_CONFUSION",
  "MISREAD_QUESTION",
  "UNSAFE_APPROACH",
  "RANDOM_TRIAL_AND_ERROR",
  "SKILL_BYPASS",
]);
const clamp = (value: number, min = 0, max = 100) => Math.max(min, Math.min(max, value));

function successRate(skill: SkillMemoryView) {
  return skill.attempts > 0 ? (skill.successfulAttempts / skill.attempts) * 100 : 0;
}

function isDue(skill: SkillMemoryView, now: Date) {
  return Boolean(skill.nextReview && Date.parse(skill.nextReview) <= now.getTime());
}

export function assessSkillMastery(skill: SkillMemoryView, now = new Date()): SkillMasteryView {
  const retention = clamp(skill.retention ?? skill.mastery);
  const independence = clamp(skill.independence ?? 100 - skill.hintDependency);
  const evidenceCount = skill.evidenceCount ?? skill.attempts;
  const recentScore = skill.recentScore ?? 0;
  const rate = successRate(skill);
  const riskMistake = skill.recentMistakes.some((mistake) => RISK_MISTAKES.has(mistake));
  const due = isDue(skill, now);

  let state: MasteryState;
  if (skill.attempts === 0 && evidenceCount === 0) {
    state = "NOT_STARTED";
  } else if (
    skill.mastery >= 80 &&
    skill.confidence >= 70 &&
    retention >= 70 &&
    independence >= 65 &&
    rate >= 75 &&
    recentScore >= 80 &&
    evidenceCount >= 3 &&
    skill.successfulAttempts >= 2 &&
    (skill.difficultyRating === undefined || skill.difficultyRating >= 2.0) &&
    !due &&
    !riskMistake
  ) {
    // A skill can be mastered only through multiple varied independent evidence points.
    // Solving a single question or only trivial level-1 patterns never grants mastery.
    state = "MASTERED";
  } else if (
    skill.mastery >= 70 &&
    (retention < 60 || skill.confidence < 60 || (due && evidenceCount >= 3))
  ) {
    state = "FRAGILE";
  } else if (skill.mastery >= 70 && rate >= 60) {
    state = "FUNCTIONAL";
  } else if (skill.mastery >= 45 || evidenceCount >= 2) {
    state = "DEVELOPING";
  } else {
    state = "LEARNING";
  }

  const missingGates: string[] = [];
  if (skill.mastery < 80) missingGates.push("mastery ≥ 80");
  if (skill.confidence < 70) missingGates.push("confidence ≥ 70");
  if (retention < 70) missingGates.push("retention ≥ 70");
  if (independence < 65) missingGates.push("independence ≥ 65");
  if (rate < 75) missingGates.push("success rate ≥ 75%");
  if (recentScore < 80) missingGates.push("recent score ≥ 80");
  if (evidenceCount < 3) missingGates.push("at least 3 evidence points");
  if (skill.successfulAttempts < 2) missingGates.push("at least 2 successful attempts");
  if (skill.difficultyRating !== undefined && skill.difficultyRating < 2.0)
    missingGates.push("varied difficulty exposure (difficulty rating ≥ 2.0)");
  if (due) missingGates.push("retention review due");
  if (riskMistake) missingGates.push("resolve recent concept/safety evidence");

  const score = clamp(
    Math.round(
      skill.mastery * 0.32 +
        skill.confidence * 0.16 +
        retention * 0.16 +
        independence * 0.16 +
        clamp(rate) * 0.1 +
        recentScore * 0.06 +
        clamp((evidenceCount / 5) * 100) * 0.04,
    ),
  );

  const rationale =
    state === "MASTERED"
      ? "Multiple independent evidence dimensions meet the mastery gate."
      : state === "FRAGILE"
        ? "The learner previously built functional capability, but retention/confidence or review evidence has weakened."
        : riskMistake
          ? "Recent conceptual or safety evidence prevents a mastery declaration even when raw mastery is high."
          : "The evidence is still building toward the full mastery gate.";

  return {
    skillId: skill.skillId,
    state,
    masteryScore: score,
    successRate: Math.round(rate),
    evidenceCount,
    retention,
    independence,
    confidence: clamp(skill.confidence),
    recentScore,
    due,
    gatesSatisfied: Math.max(0, 8 - missingGates.length),
    gatesRequired: 8,
    missingGates,
    rationale,
  };
}

export function buildMasterySnapshot(
  skills: readonly SkillMemoryView[],
  now = new Date(),
): SkillMasteryView[] {
  return skills.map((skill) => assessSkillMastery(skill, now));
}

function prerequisitesMastered(skillId: SkillId, mastered: Set<SkillId>) {
  return (PREREQUISITES[skillId] ?? []).every((prerequisite) => mastered.has(prerequisite));
}

export function decideProgression(input: {
  skills: readonly SkillMemoryView[];
  targetSkills?: readonly SkillId[];
  assessment?: {
    status?: VerificationStatus;
    grade?: number;
    hintsUsed?: number;
    evidenceQuality?: MissionAssessment["evidenceQuality"];
  } | null;
  now?: Date;
}): ProgressionDecisionView {
  const now = input.now ?? new Date();
  const mastery = buildMasterySnapshot(input.skills, now);
  const bySkill = new Map(mastery.map((item) => [item.skillId, item]));
  const mastered = mastery.filter((item) => item.state === "MASTERED").map((item) => item.skillId);
  const fragile = mastery.filter((item) => item.state === "FRAGILE").map((item) => item.skillId);
  const masteredSet = new Set(mastered);
  const targets = [...new Set(input.targetSkills ?? [])];
  const effectiveTargets = targets.length
    ? targets
    : mastery
        .filter((item) => item.state !== "MASTERED")
        .sort((a, b) => b.masteryScore - a.masteryScore)
        .slice(0, 1)
        .map((item) => item.skillId);
  const targetViews = effectiveTargets
    .map((id) => bySkill.get(id))
    .filter((value): value is SkillMasteryView => Boolean(value));
  const assessment = input.assessment;
  const gateReasons: string[] = [];

  if (assessment?.status === "BLOCKED_BY_SAFETY_POLICY") {
    return {
      action: "REMEDIATE",
      targetSkills: effectiveTargets,
      masteredSkills: mastered,
      fragileSkills: fragile,
      eligibleNextSkills: [],
      mastery,
      rationale: "Safety evidence requires remediation before progression.",
      gateReasons: ["safety boundary was triggered"],
    };
  }

  const targetFragile = targetViews.some((item) => item.state === "FRAGILE");
  if (targetFragile || fragile.length > 0) {
    gateReasons.push("fragile skill requires spaced review");
  }

  const targetMastered =
    effectiveTargets.length > 0 &&
    targetViews.length === effectiveTargets.length &&
    targetViews.every((item) => item.state === "MASTERED");
  if (targetMastered) {
    const eligibleNextSkills = (Object.keys(PREREQUISITES) as SkillId[]).filter(
      (id) => !masteredSet.has(id) && prerequisitesMastered(id, masteredSet),
    );
    return {
      action: "ADVANCE",
      targetSkills: effectiveTargets,
      masteredSkills: mastered,
      fragileSkills: fragile,
      eligibleNextSkills,
      mastery,
      rationale:
        "The target skill has durable, multi-dimensional mastery evidence; prerequisite gates permit controlled advancement.",
      gateReasons: [],
    };
  }

  const confirmationReady = targetViews.some(
    (item) =>
      item.state === "FUNCTIONAL" &&
      item.masteryScore >= 72 &&
      item.evidenceCount >= 2 &&
      assessment?.status === "COMPLETE" &&
      (assessment.grade ?? 0) >= 85 &&
      (assessment.evidenceQuality?.independenceSignal === "high" || assessment?.hintsUsed === 0),
  );
  if (confirmationReady && !targetFragile) {
    gateReasons.push("mastery confirmation evidence is still required");
    return {
      action: "CONFIRM_MASTERY",
      targetSkills: effectiveTargets,
      masteredSkills: mastered,
      fragileSkills: fragile,
      eligibleNextSkills: [],
      mastery,
      rationale:
        "The learner is near the mastery threshold; a distinct confirmation task should test durable independent performance before advancement.",
      gateReasons,
    };
  }

  if (targetFragile || targetViews.some((item) => item.due)) {
    return {
      action: "REVIEW",
      targetSkills: effectiveTargets,
      masteredSkills: mastered,
      fragileSkills: fragile,
      eligibleNextSkills: [],
      mastery,
      rationale:
        "Retention evidence is due or fragile, so retrieval practice should precede progression.",
      gateReasons,
    };
  }

  if (assessment?.status === "COMPLETE" && (assessment.grade ?? 0) < 85) {
    gateReasons.push("latest verified score is below progression confirmation threshold");
  }
  if (targetViews.some((item) => item.missingGates.length > 0)) {
    gateReasons.push(...targetViews.flatMap((item) => item.missingGates).slice(0, 4));
  }
  return {
    action: "PRACTICE",
    targetSkills: effectiveTargets,
    masteredSkills: mastered,
    fragileSkills: fragile,
    eligibleNextSkills: [],
    mastery,
    rationale:
      "The learner is not yet through the deterministic mastery gate; continue targeted practice and collect more evidence.",
    gateReasons: [...new Set(gateReasons)],
  };
}
