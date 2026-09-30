/**
 * V43 — Dynamic Teaching Engine.
 *
 * Chooses how LinuxForge should teach the learner inside an existing learning
 * session. It is deterministic orchestration: it may choose teaching style,
 * pacing, content mix, hint policy, and a bounded teaching brief, but it never
 * changes grades, mastery, progression, lab state, or security policy.
 */
import type { ObservationCategory, SkillId } from "@/lib/forge/types";
import type { LearnerIntelligence } from "./learner-intelligence";
import type {
  CurriculumContentItem,
  CurriculumContentKind,
} from "@/lib/learner/curriculum-content";
import type { LearningSession, LearningSessionPhase } from "@/lib/learner/learning-session";

export type TeachingStrategy =
  | "ORIENT"
  | "EXPLAIN"
  | "REMEDIATE"
  | "DEMONSTRATE"
  | "GUIDED_DISCOVERY"
  | "TRANSFER_COACH"
  | "ASSESSMENT_COACH"
  | "REFLECT";

export type TeachingPacing = "CONCISE" | "STANDARD" | "DEEP";
export type HintPolicy = "ON_REQUEST" | "PROGRESSIVE" | "MINIMAL";

export type DynamicTeachingDecision = {
  version: "v43";
  sessionPhase: LearningSessionPhase;
  strategy: TeachingStrategy;
  pacing: TeachingPacing;
  hintPolicy: HintPolicy;
  primarySkill: SkillId;
  supportingSkills: readonly SkillId[];
  focusMistakes: readonly ObservationCategory[];
  contentKinds: readonly CurriculumContentKind[];
  maxContentItems: number;
  rationale: string;
  teachingBrief: string;
  constraints: readonly string[];
};

export type DynamicTeachingInput = {
  session: Pick<LearningSession, "phase" | "plan">;
  intelligence: Pick<
    LearnerIntelligence,
    | "readiness"
    | "confidence"
    | "independence"
    | "hintDependency"
    | "signals"
    | "repeatedMistakes"
    | "dominantMistakes"
  >;
  content?: readonly CurriculumContentItem[];
};

const phaseKinds: Record<LearningSessionPhase, readonly CurriculumContentKind[]> = {
  ORIENT: ["EXPLANATION", "PREREQUISITE", "EXAMPLE"],
  TEACH: ["EXPLANATION", "EXAMPLE", "DEMONSTRATION", "HINT"],
  PRACTICE: ["DEMONSTRATION", "EXERCISE", "HINT", "VARIATION"],
  VERIFY: ["ASSESSMENT", "EXERCISE", "HINT"],
  REFLECT: ["REVIEW", "EXAMPLE", "VARIATION"],
  COMPLETE: ["REVIEW", "VARIATION"],
};

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Math.round(value)));

function hasSignal(input: DynamicTeachingInput, signal: LearnerIntelligence["signals"][number]) {
  return input.intelligence.signals.includes(signal);
}

function strategyFor(input: DynamicTeachingInput): TeachingStrategy {
  const { session, intelligence } = input;
  if (session.phase === "ORIENT") return "ORIENT";
  if (session.phase === "VERIFY") return "ASSESSMENT_COACH";
  if (session.phase === "REFLECT" || session.phase === "COMPLETE") return "REFLECT";
  if (session.phase === "PRACTICE") {
    if (session.plan.mode === "TRANSFER") return "TRANSFER_COACH";
    if (hasSignal(input, "DEPENDENT") || hasSignal(input, "CONCEPT_GAP")) return "GUIDED_DISCOVERY";
    if (session.plan.mode === "REMEDIATION") return "REMEDIATE";
    return "DEMONSTRATE";
  }
  if (session.phase === "TEACH") {
    if (session.plan.mode === "REMEDIATION" || hasSignal(input, "CONCEPT_GAP")) return "REMEDIATE";
    if (intelligence.readiness < 45 || hasSignal(input, "NEW_TO_SKILL")) return "EXPLAIN";
    if (session.plan.mode === "TRANSFER") return "TRANSFER_COACH";
    return intelligence.independence >= 75 ? "GUIDED_DISCOVERY" : "DEMONSTRATE";
  }
  return "EXPLAIN";
}

function pacingFor(input: DynamicTeachingInput, strategy: TeachingStrategy): TeachingPacing {
  if (strategy === "ORIENT" || strategy === "ASSESSMENT_COACH" || strategy === "REFLECT")
    return "CONCISE";
  if (
    hasSignal(input, "CONCEPT_GAP") ||
    input.intelligence.confidence < 50 ||
    input.session.plan.mode === "REMEDIATION"
  )
    return "DEEP";
  if (input.intelligence.readiness >= 78 && input.intelligence.independence >= 70) return "CONCISE";
  return "STANDARD";
}

function hintPolicyFor(input: DynamicTeachingInput): HintPolicy {
  // During concept remediation, progressive hints are part of the teaching
  // strategy even when the learner has generally shown high hint dependency.
  // In active practice, high dependency should instead minimize unsolicited
  // help and preserve independent problem solving.
  if (input.session.phase === "TEACH" && hasSignal(input, "CONCEPT_GAP")) return "PROGRESSIVE";
  if (input.session.plan.mode === "ASSESSMENT" || input.session.plan.mode === "PROGRESSION")
    return "MINIMAL";
  if (input.intelligence.hintDependency >= 60) return "MINIMAL";
  if (
    input.intelligence.hintDependency >= 35 ||
    hasSignal(input, "CONCEPT_GAP") ||
    input.session.plan.mode === "REMEDIATION" ||
    input.session.plan.mode === "GUIDED_PRACTICE"
  )
    return "PROGRESSIVE";
  return "ON_REQUEST";
}

function contentKindsFor(
  input: DynamicTeachingInput,
  strategy: TeachingStrategy,
): readonly CurriculumContentKind[] {
  if (strategy === "REMEDIATE") return ["REMEDIATION", "EXPLANATION", "EXAMPLE", "HINT"];
  if (strategy === "GUIDED_DISCOVERY") return ["EXAMPLE", "DEMONSTRATION", "EXERCISE", "HINT"];
  if (strategy === "DEMONSTRATE") return ["DEMONSTRATION", "EXPLANATION", "EXAMPLE", "EXERCISE"];
  if (strategy === "TRANSFER_COACH") return ["VARIATION", "EXAMPLE", "EXERCISE", "HINT"];
  if (strategy === "ASSESSMENT_COACH") return ["ASSESSMENT", "EXERCISE", "HINT"];
  if (strategy === "REFLECT") return ["REVIEW", "EXAMPLE", "VARIATION"];
  return phaseKinds[input.session.phase];
}

function rationaleFor(input: DynamicTeachingInput, strategy: TeachingStrategy): string {
  const reasons: string[] = [];
  reasons.push(`session phase ${input.session.phase}`);
  reasons.push(`mode ${input.session.plan.mode}`);
  reasons.push(`readiness ${input.intelligence.readiness}`);
  if (input.intelligence.hintDependency >= 35)
    reasons.push(`hint dependency ${input.intelligence.hintDependency}`);
  if (input.intelligence.repeatedMistakes.length)
    reasons.push(`repeated mistakes ${input.intelligence.repeatedMistakes.slice(0, 2).join(", ")}`);
  return `${strategy} selected from bounded learner evidence: ${reasons.join("; ")}.`;
}

function briefFor(
  input: DynamicTeachingInput,
  strategy: TeachingStrategy,
  pacing: TeachingPacing,
  hintPolicy: HintPolicy,
): string {
  const skill = input.session.plan.primarySkill;
  const mistakes = input.intelligence.repeatedMistakes.slice(0, 3).join(", ");
  const mistakeClause = mistakes ? ` Pay particular attention to ${mistakes}.` : "";
  return `Teach ${skill} using ${strategy.toLowerCase()} at ${pacing.toLowerCase()} pacing. Hint policy: ${hintPolicy.toLowerCase()}.${mistakeClause} Keep the learner-facing explanation grounded in approved curriculum and knowledge context.`;
}

function filterContent(
  content: readonly CurriculumContentItem[],
  kinds: readonly CurriculumContentKind[],
  limit: number,
): CurriculumContentItem[] {
  const rank = new Map(kinds.map((kind, index) => [kind, index]));
  return content
    .filter((item) => rank.has(item.kind))
    .sort((a, b) => {
      const aRank = rank.get(a.kind) ?? Number.MAX_SAFE_INTEGER;
      const bRank = rank.get(b.kind) ?? Number.MAX_SAFE_INTEGER;
      return aRank - bRank || a.difficulty - b.difficulty || a.id.localeCompare(b.id);
    })
    .slice(0, limit);
}

export function decideDynamicTeaching(input: DynamicTeachingInput): DynamicTeachingDecision {
  const strategy = strategyFor(input);
  const pacing = pacingFor(input, strategy);
  const hintPolicy = hintPolicyFor(input);
  const contentKinds = contentKindsFor(input, strategy);
  const maxContentItems = clamp(pacing === "DEEP" ? 6 : pacing === "CONCISE" ? 3 : 4, 2, 6);
  const focusMistakes = [
    ...new Set([...input.intelligence.repeatedMistakes, ...input.intelligence.dominantMistakes]),
  ].slice(0, 4);
  const constraints = [
    "Do not alter verifier grades, mastery, progression, or learner records.",
    "Do not reveal internal contracts, provider configuration, secrets, or hidden challenge solutions.",
    "Keep examples and demonstrations inside the authorized LinuxForge learning scope.",
  ];
  if (hintPolicy === "MINIMAL")
    constraints.push(
      "Avoid unsolicited step-by-step hints; ask the learner to attempt the next step independently.",
    );
  if (strategy === "TRANSFER_COACH")
    constraints.push(
      "Change the scenario while preserving the target concept and objective evidence.",
    );
  if (strategy === "ASSESSMENT_COACH")
    constraints.push("Explain what evidence is required without revealing the expected solution.");
  if (strategy === "REMEDIATE")
    constraints.push("Address the underlying concept before adding task complexity.");

  return {
    version: "v43",
    sessionPhase: input.session.phase,
    strategy,
    pacing,
    hintPolicy,
    primarySkill: input.session.plan.primarySkill,
    supportingSkills: input.session.plan.supportingSkills,
    focusMistakes,
    contentKinds,
    maxContentItems,
    rationale: rationaleFor(input, strategy),
    teachingBrief: briefFor(input, strategy, pacing, hintPolicy),
    constraints,
  };
}

export function selectTeachingContent(
  input: DynamicTeachingInput,
  decision = decideDynamicTeaching(input),
): CurriculumContentItem[] {
  return filterContent(input.content ?? [], decision.contentKinds, decision.maxContentItems);
}
