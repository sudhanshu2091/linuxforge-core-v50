/**
 * Special Training Batches Engine.
 *
 * Implements deterministic multi-stage special batches for learner adaptation:
 * - Weakness batch (diagnostic -> medium scenario -> troubleshooting -> harder application -> transfer)
 * - Remediation batch (focused practice -> feedback -> variant)
 * - Spaced-review batch (retention retrieval in a novel scenario)
 * - Transfer batch (unfamiliar scenario with the same underlying skill)
 * - Advanced batch (multi-skill complex realistic environment)
 * - Security-context batch (Linux skill exercised in a cybersecurity / auditing context)
 *
 * Invariant: AI is advisory; batch structure, sequencing, and gates are deterministic.
 */

import type { ObservationCategory, SkillId, SkillMemoryView } from "@/lib/forge/types";
import type { LearnerIntelligence } from "@/lib/ai/learner-intelligence";

export type TrainingBatchType =
  | "WEAKNESS"
  | "REMEDIATION"
  | "SPACED_REVIEW"
  | "TRANSFER"
  | "ADVANCED"
  | "SECURITY_CONTEXT";

export type BatchItemRole =
  | "DIAGNOSTIC"
  | "FOCUSED_PRACTICE"
  | "TROUBLESHOOTING"
  | "ADVANCED_APPLICATION"
  | "TRANSFER_APPLICATION"
  | "CYBERSECURITY_CONTEXT"
  | "SPACED_RETRIEVAL";

export type TrainingBatchItem = {
  itemIndex: number;
  role: BatchItemRole;
  primarySkill: SkillId;
  supportingSkills: SkillId[];
  difficulty: number;
  scenarioType: string;
  reasoningPattern: string;
  cybersecurityContext: boolean;
  objectiveSummary: string;
  expectedArchetype: "REMEDIATION" | "SPACED_REVIEW" | "TRANSFER" | "PROGRESSION" | "MIXED_REINFORCEMENT";
};

export type TrainingBatch = {
  batchId: string;
  batchType: TrainingBatchType;
  title: string;
  rationale: string;
  primarySkill: SkillId;
  targetWeakness?: string | undefined;
  items: TrainingBatchItem[];
  createdAt: string;
};

export function evaluateBatchTrigger(input: {
  skills: readonly SkillMemoryView[];
  intelligence: LearnerIntelligence;
  recentMistakes: readonly string[];
  targetSkill?: SkillId | undefined;
  assessment?:
    | {
        status?: string | undefined;
        grade?: number | undefined;
        mistakeBreakdown?: Array<{ category: string }> | undefined;
      }
    | null
    | undefined;
}): {
  batchRecommended: boolean;
  recommendedBatchType?: TrainingBatchType | undefined;
  primarySkill?: SkillId | undefined;
  targetWeakness?: string | undefined;
  rationale?: string | undefined;
} {
  const { skills, intelligence, recentMistakes, assessment } = input;
  const focusSkill = input.targetSkill ?? intelligence.focusSkills[0] ?? skills[0]?.skillId ?? "filesystem";
  const skillMem = skills.find((s) => s.skillId === focusSkill);

  // 1. Weakness batch: detected confusion (e.g. CONCEPT_CONFUSION or permissions/ownership overlap)
  const hasConfusion =
    recentMistakes.includes("CONCEPT_CONFUSION") ||
    intelligence.repeatedMistakes.includes("CONCEPT_CONFUSION") ||
    recentMistakes.includes("SKILL_BYPASS");

  if (hasConfusion && skillMem && skillMem.mastery < 70) {
    const targetWeakness =
      focusSkill === "permissions"
        ? "permissions vs ownership semantics"
        : focusSkill === "shell-scripting"
          ? "variable expansion vs quoting"
          : `${focusSkill} conceptual model`;

    return {
      batchRecommended: true,
      recommendedBatchType: "WEAKNESS",
      primarySkill: focusSkill,
      targetWeakness,
      rationale: `Detected conceptual confusion in ${focusSkill}; recommending structured multi-stage weakness batch.`,
    };
  }

  // 2. Remediation batch: repeated failures or low recent score
  const isFailing =
    assessment?.status === "FAIL" ||
    (assessment?.grade !== undefined && assessment.grade < 60) ||
    intelligence.signals.includes("CONCEPT_GAP");

  if (isFailing) {
    return {
      batchRecommended: true,
      recommendedBatchType: "REMEDIATION",
      primarySkill: focusSkill,
      targetWeakness: "repeated operational failure",
      rationale: "Recent performance indicates conceptual breakdown requiring targeted remediation.",
    };
  }

  // 3. Spaced-review batch: review due or fragile retention
  const dueSkills = skills.filter((s) => s.nextReview && Date.parse(s.nextReview) <= Date.now());
  const fragileSkills = skills.filter((s) => (s.retention ?? s.mastery) < 60 && s.mastery >= 60);

  if (dueSkills.length > 0 || fragileSkills.length > 0) {
    const reviewSkill = dueSkills[0]?.skillId ?? fragileSkills[0]?.skillId ?? focusSkill;
    return {
      batchRecommended: true,
      recommendedBatchType: "SPACED_REVIEW",
      primarySkill: reviewSkill,
      targetWeakness: "retention decay",
      rationale: `Retention decay detected for ${reviewSkill}; spaced-review batch recommended.`,
    };
  }

  // 4. Security-context batch: learner has solid Linux basics (mastery >= 70) ready for cybersecurity context
  if (skillMem && skillMem.mastery >= 70 && !recentMistakes.includes("UNSAFE_APPROACH")) {
    return {
      batchRecommended: true,
      recommendedBatchType: "SECURITY_CONTEXT",
      primarySkill: focusSkill,
      targetWeakness: undefined,
      rationale: `Foundational Linux competence verified for ${focusSkill}; transitioning to cybersecurity investigation context.`,
    };
  }

  // 5. Transfer batch: readiness high, confidence solid, needs exposure to unfamiliar scenarios
  if (intelligence.readiness >= 65 && intelligence.independence >= 65) {
    return {
      batchRecommended: true,
      recommendedBatchType: "TRANSFER",
      primarySkill: focusSkill,
      targetWeakness: undefined,
      rationale: `Learner has demonstrated stable readiness; transfer batch recommended for cross-scenario competence.`,
    };
  }

  // 6. Advanced batch: high mastery across multiple skills
  const masteredSkills = skills.filter((s) => s.mastery >= 80);
  if (masteredSkills.length >= 2 && intelligence.independence >= 80) {
    return {
      batchRecommended: true,
      recommendedBatchType: "ADVANCED",
      primarySkill: focusSkill,
      targetWeakness: undefined,
      rationale: "Advanced learner performance qualifies for complex multi-skill scenarios.",
    };
  }

  return { batchRecommended: false };
}

export function buildSpecialTrainingBatch(input: {
  batchType: TrainingBatchType;
  primarySkill: SkillId;
  skills: readonly SkillMemoryView[];
  intelligence?: LearnerIntelligence | undefined;
  targetWeakness?: string | undefined;
  baseDifficulty?: number | undefined;
}): TrainingBatch {
  const { batchType, primarySkill } = input;
  const baseDiff = Math.max(1, Math.min(5, input.baseDifficulty ?? 2));
  const batchId = `batch-${batchType.toLowerCase()}-${primarySkill}-${Date.now()}`;

  const supportingSkills: SkillId[] = input.skills
    .filter((s) => s.skillId !== primarySkill && s.mastery >= 50)
    .slice(0, 2)
    .map((s) => s.skillId);

  const items: TrainingBatchItem[] = [];

  switch (batchType) {
    case "WEAKNESS": {
      // 5-stage weakness resolution sequence:
      // 1. diagnostic question
      items.push({
        itemIndex: 1,
        role: "DIAGNOSTIC",
        primarySkill,
        supportingSkills,
        difficulty: Math.max(1, baseDiff - 1),
        scenarioType: "diagnostic",
        reasoningPattern: "identify-misconfiguration",
        cybersecurityContext: false,
        objectiveSummary: `Diagnose and identify the baseline ${primarySkill} issue.`,
        expectedArchetype: "REMEDIATION",
      });
      // 2. different medium scenario
      items.push({
        itemIndex: 2,
        role: "FOCUSED_PRACTICE",
        primarySkill,
        supportingSkills,
        difficulty: baseDiff,
        scenarioType: "configuration-variant",
        reasoningPattern: "apply-standard-rule",
        cybersecurityContext: false,
        objectiveSummary: `Practice the corrected ${primarySkill} workflow in an alternate environment structure.`,
        expectedArchetype: "MIXED_REINFORCEMENT",
      });
      // 3. practical troubleshooting scenario
      items.push({
        itemIndex: 3,
        role: "TROUBLESHOOTING",
        primarySkill,
        supportingSkills,
        difficulty: baseDiff,
        scenarioType: "troubleshooting",
        reasoningPattern: "isolate-and-repair",
        cybersecurityContext: false,
        objectiveSummary: `Troubleshoot an active ${primarySkill} defect without assistance.`,
        expectedArchetype: "REMEDIATION",
      });
      // 4. harder application
      items.push({
        itemIndex: 4,
        role: "ADVANCED_APPLICATION",
        primarySkill,
        supportingSkills,
        difficulty: Math.min(5, baseDiff + 1),
        scenarioType: "multi-tier-application",
        reasoningPattern: "hierarchical-enforcement",
        cybersecurityContext: false,
        objectiveSummary: `Apply multi-step ${primarySkill} controls across nested structures.`,
        expectedArchetype: "PROGRESSION",
      });
      // 5. transfer scenario
      items.push({
        itemIndex: 5,
        role: "TRANSFER_APPLICATION",
        primarySkill,
        supportingSkills,
        difficulty: Math.min(5, baseDiff + 1),
        scenarioType: "cross-domain-transfer",
        reasoningPattern: "cross-domain-application",
        cybersecurityContext: false,
        objectiveSummary: `Transfer ${primarySkill} knowledge to a novel production scenario.`,
        expectedArchetype: "TRANSFER",
      });
      break;
    }

    case "REMEDIATION": {
      items.push({
        itemIndex: 1,
        role: "FOCUSED_PRACTICE",
        primarySkill,
        supportingSkills,
        difficulty: Math.max(1, baseDiff - 1),
        scenarioType: "guided-remediation",
        reasoningPattern: "direct-correction",
        cybersecurityContext: false,
        objectiveSummary: `Correct prior error pattern with strict constraints and immediate feedback.`,
        expectedArchetype: "REMEDIATION",
      });
      items.push({
        itemIndex: 2,
        role: "TROUBLESHOOTING",
        primarySkill,
        supportingSkills,
        difficulty: baseDiff,
        scenarioType: "alternate-variant",
        reasoningPattern: "independent-verification",
        cybersecurityContext: false,
        objectiveSummary: `Demonstrate independent execution on an alternate variant of the skill.`,
        expectedArchetype: "REMEDIATION",
      });
      break;
    }

    case "SPACED_REVIEW": {
      items.push({
        itemIndex: 1,
        role: "SPACED_RETRIEVAL",
        primarySkill,
        supportingSkills,
        difficulty: baseDiff,
        scenarioType: "retention-challenge",
        reasoningPattern: "retrieval-practice",
        cybersecurityContext: false,
        objectiveSummary: `Retrieve and exercise previously mastered ${primarySkill} in a fresh scenario.`,
        expectedArchetype: "SPACED_REVIEW",
      });
      items.push({
        itemIndex: 2,
        role: "TRANSFER_APPLICATION",
        primarySkill,
        supportingSkills,
        difficulty: Math.min(5, baseDiff + 1),
        scenarioType: "novel-environment-review",
        reasoningPattern: "transfer-retrieval",
        cybersecurityContext: false,
        objectiveSummary: `Consolidate retention by combining ${primarySkill} with supporting operations.`,
        expectedArchetype: "SPACED_REVIEW",
      });
      break;
    }

    case "TRANSFER": {
      items.push({
        itemIndex: 1,
        role: "TRANSFER_APPLICATION",
        primarySkill,
        supportingSkills,
        difficulty: baseDiff,
        scenarioType: "unfamiliar-domain",
        reasoningPattern: "generalize-concept",
        cybersecurityContext: false,
        objectiveSummary: `Apply ${primarySkill} in an unfamiliar domain or atypical file hierarchy.`,
        expectedArchetype: "TRANSFER",
      });
      items.push({
        itemIndex: 2,
        role: "ADVANCED_APPLICATION",
        primarySkill,
        supportingSkills,
        difficulty: Math.min(5, baseDiff + 1),
        scenarioType: "multi-system-transfer",
        reasoningPattern: "integrated-transfer",
        cybersecurityContext: false,
        objectiveSummary: `Coordinate ${primarySkill} execution alongside external tooling and dependencies.`,
        expectedArchetype: "TRANSFER",
      });
      break;
    }

    case "ADVANCED": {
      items.push({
        itemIndex: 1,
        role: "ADVANCED_APPLICATION",
        primarySkill,
        supportingSkills,
        difficulty: Math.min(5, baseDiff + 1),
        scenarioType: "production-incident",
        reasoningPattern: "multi-skill-incident-response",
        cybersecurityContext: false,
        objectiveSummary: `Respond to an active system scenario requiring deep ${primarySkill} mastery.`,
        expectedArchetype: "PROGRESSION",
      });
      items.push({
        itemIndex: 2,
        role: "ADVANCED_APPLICATION",
        primarySkill,
        supportingSkills,
        difficulty: Math.min(5, baseDiff + 2),
        scenarioType: "complex-architecture",
        reasoningPattern: "end-to-end-administration",
        cybersecurityContext: false,
        objectiveSummary: `Architect and verify robust ${primarySkill} posture across multiple components.`,
        expectedArchetype: "PROGRESSION",
      });
      break;
    }

    case "SECURITY_CONTEXT": {
      items.push({
        itemIndex: 1,
        role: "CYBERSECURITY_CONTEXT",
        primarySkill,
        supportingSkills,
        difficulty: baseDiff,
        scenarioType: "misconfiguration-audit",
        reasoningPattern: "vulnerability-enumeration",
        cybersecurityContext: true,
        objectiveSummary: `Audit the environment for security misconfigurations related to ${primarySkill} (e.g. overly permissive files or insecure services).`,
        expectedArchetype: "TRANSFER",
      });
      items.push({
        itemIndex: 2,
        role: "CYBERSECURITY_CONTEXT",
        primarySkill,
        supportingSkills,
        difficulty: Math.min(5, baseDiff + 1),
        scenarioType: "privilege-hardening",
        reasoningPattern: "defensive-hardening",
        cybersecurityContext: true,
        objectiveSummary: `Harden ${primarySkill} boundaries to prevent unauthorized privilege escalation.`,
        expectedArchetype: "PROGRESSION",
      });
      items.push({
        itemIndex: 3,
        role: "CYBERSECURITY_CONTEXT",
        primarySkill,
        supportingSkills,
        difficulty: Math.min(5, baseDiff + 1),
        scenarioType: "ctf-investigation",
        reasoningPattern: "forensic-investigation",
        cybersecurityContext: true,
        objectiveSummary: `CTF scenario: Investigate evidence of compromise utilizing ${primarySkill} inspection techniques.`,
        expectedArchetype: "TRANSFER",
      });
      break;
    }
  }

  const title =
    batchType === "WEAKNESS"
      ? `Targeted Weakness Remediation: ${primarySkill}`
      : batchType === "REMEDIATION"
        ? `Conceptual Remediation: ${primarySkill}`
        : batchType === "SPACED_REVIEW"
          ? `Spaced Review & Retention: ${primarySkill}`
          : batchType === "TRANSFER"
            ? `Transfer & Domain Generalization: ${primarySkill}`
            : batchType === "ADVANCED"
              ? `Advanced Real-World Challenges: ${primarySkill}`
              : `Cybersecurity Context Training: ${primarySkill}`;

  const rationale =
    input.targetWeakness
      ? `Structured ${items.length}-mission sequence focusing on ${input.targetWeakness}.`
      : `Structured ${items.length}-mission ${batchType.toLowerCase()} sequence for ${primarySkill}.`;

  return {
    batchId,
    batchType,
    title,
    rationale,
    primarySkill,
    ...(input.targetWeakness ? { targetWeakness: input.targetWeakness } : {}),
    items,
    createdAt: new Date().toISOString(),
  };
}
