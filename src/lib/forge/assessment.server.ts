/**
 * Deterministic mission assessment summary (server-only).
 *
 * This module never replaces the verifier. It explains the evidence already
 * produced by the verifier/observer: execution effort, hints, mistakes,
 * objectives and learning signals. No AI output can change the final grade.
 */
import type { Contract } from "./contracts.server";
import type {
  MissionAssessment as MissionAssessmentType,
  ObservationCategory,
  SkillId,
  Verification,
} from "./types";
import { buildAdaptivePlan } from "@/lib/learner/adaptive-plan";

export type AssessmentCommand = {
  commands: string[];
  exitCode: number;
  mutationCount: number;
  blocked: string | null;
  usedLoop: boolean;
};

export type AssessmentObservation = {
  category: ObservationCategory | null;
  conceptUnderstanding: "unclear" | "partial" | "solid";
  skillDemonstrated: boolean;
};

export type AssessmentInput = {
  contract: Pick<Contract, "difficulty" | "requiredSkills">;
  verification: Verification | null;
  commands: AssessmentCommand[];
  observations: AssessmentObservation[];
  hintsUsed: number;
  startedAt: string | null;
  completedAt: string | null;
  now?: Date;
  skillMemory?: import("./types").SkillMemoryView[];
};

export type MissionAssessment = {
  grade: number;
  status: Verification["status"];
  objectivesMet: number;
  objectivesTotal: number;
  attempts: number;
  commandCount: number;
  successfulCommands: number;
  failedCommands: number;
  blockedCommands: number;
  mutationOperations: number;
  usedLoop: boolean;
  hintsUsed: number;
  elapsedSeconds: number | null;
  mistakeBreakdown: Array<{ category: ObservationCategory; count: number }>;
  strengths: string[];
  nextActions: string[];
  learningSignal: "mastered" | "progressing" | "needs_practice" | "blocked";
  evidenceQuality: NonNullable<MissionAssessmentType["evidenceQuality"]>;
  adaptivePlan: NonNullable<MissionAssessmentType["adaptivePlan"]>;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function buildMissionAssessment(input: AssessmentInput): MissionAssessment {
  const verification = input.verification;
  const objectives = verification?.objectives ?? [];
  const objectivesMet = objectives.filter((o) => o.met).length;
  const objectivesTotal = objectives.length;
  const commandCount = input.commands.reduce((sum, event) => sum + event.commands.length, 0);
  const failedCommands = input.commands.filter((event) => event.exitCode !== 0).length;
  const blockedCommands = input.commands.filter((event) => Boolean(event.blocked)).length;
  const successfulCommands = Math.max(0, input.commands.length - failedCommands);
  const mutationOperations = input.commands.reduce((sum, event) => sum + event.mutationCount, 0);
  const usedLoop = input.commands.some((event) => event.usedLoop);

  const counts = new Map<ObservationCategory, number>();
  for (const observation of input.observations) {
    if (!observation.category) continue;
    counts.set(observation.category, (counts.get(observation.category) ?? 0) + 1);
  }
  const mistakeBreakdown = [...counts.entries()]
    .filter(([category]) => category !== "VALID_ALTERNATIVE" && category !== "INDEPENDENT_SOLUTION")
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([category, count]) => ({ category, count }));

  const elapsedSeconds = elapsedBetween(
    input.startedAt,
    input.completedAt,
    input.now ?? new Date(),
  );
  const strengths: string[] = [];
  const nextActions: string[] = [];

  if (verification?.status === "COMPLETE") strengths.push("All required objectives were verified.");
  if (verification?.status === "RESULT_CORRECT_SKILL_NOT_DEMONSTRATED")
    nextActions.push(
      "Repeat the mission and make the required skill visible in the commands you use.",
    );
  if (verification?.status === "RESULT_INCORRECT_SKILL_DEMONSTRATED")
    nextActions.push(
      "Keep the same technique, but target the exact path, filename or object named by the brief.",
    );
  if (verification?.status === "BLOCKED_BY_SAFETY_POLICY")
    nextActions.push(
      "Stay inside the modelled lab and use commands supported by the training sandbox.",
    );
  if (verification?.status === "INCOMPLETE") nextActions.push(...(verification?.remediation ?? []));

  if (input.hintsUsed === 0) strengths.push("No hints were used.");
  if (usedLoop) strengths.push("A loop was explicitly demonstrated.");
  if (mistakeBreakdown.length > 0) {
    const top = mistakeBreakdown[0]!;
    nextActions.push(`Review ${labelForCategory(top.category)} before the next similar challenge.`);
  }
  if (failedCommands > 0 && verification?.status === "COMPLETE")
    strengths.push("You recovered from failed commands and still produced a verified result.");
  if (
    commandCount > 0 &&
    successfulCommands === input.commands.length &&
    mistakeBreakdown.length === 0
  )
    strengths.push("Command execution stayed clean during this run.");

  const status = verification?.status ?? "INCOMPLETE";
  const learningSignal =
    status === "COMPLETE"
      ? "mastered"
      : status === "BLOCKED_BY_SAFETY_POLICY"
        ? "blocked"
        : status === "RESULT_CORRECT_SKILL_NOT_DEMONSTRATED" ||
            status === "RESULT_INCORRECT_SKILL_DEMONSTRATED"
          ? "progressing"
          : "needs_practice";

  // Evidence quality is deliberately separate from the verifier grade. It
  // describes how convincingly the learner demonstrated the skill: method
  // evidence, recovery from mistakes and independence/hint dependency.
  const successfulObservations = input.observations.filter((o) => o.skillDemonstrated).length;
  let recoveryCount = 0;
  let hadFailure = false;
  for (const event of input.commands) {
    if (event.blocked || event.exitCode !== 0) {
      hadFailure = true;
      continue;
    }
    if (hadFailure) {
      recoveryCount += 1;
      hadFailure = false;
    }
  }
  const cleanExecution = commandCount > 0 && failedCommands === 0 && blockedCommands === 0;
  const methodEvidenceScore = clamp(
    Math.round(
      (successfulObservations / Math.max(1, input.observations.length)) * 50 +
        (cleanExecution ? 25 : Math.max(0, 25 - failedCommands * 5)) +
        (input.hintsUsed === 0 ? 25 : Math.max(0, 25 - input.hintsUsed * 5)),
    ),
    0,
    100,
  );
  const independenceSignal =
    input.hintsUsed === 0 && successfulObservations > 0
      ? "high"
      : input.hintsUsed <= 2 && successfulObservations > 0
        ? "developing"
        : "low";
  const evidenceQuality: NonNullable<MissionAssessmentType["evidenceQuality"]> = {
    methodEvidenceScore,
    recoveryCount,
    independenceSignal,
    cleanExecution,
  };

  const adaptivePlan = buildAdaptivePlan({
    skills: input.skillMemory ?? [],
    assessment: {
      learningSignal,
      grade: clamp(verification?.score ?? 0, 0, 100),
      hintsUsed: input.hintsUsed,
      mistakeBreakdown,
    },
    currentDifficulty: input.contract.difficulty,
  });

  return {
    grade: clamp(verification?.score ?? 0, 0, 100),
    status,
    objectivesMet,
    objectivesTotal,
    attempts: input.commands.length,
    commandCount,
    successfulCommands,
    failedCommands,
    blockedCommands,
    mutationOperations,
    usedLoop,
    hintsUsed: input.hintsUsed,
    elapsedSeconds,
    mistakeBreakdown,
    strengths: unique(strengths),
    nextActions: unique(nextActions).slice(0, 4),
    learningSignal,
    evidenceQuality,
    adaptivePlan,
  };
}

function elapsedBetween(
  startedAt: string | null,
  completedAt: string | null,
  now: Date,
): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return null;
  const end = completedAt ? Date.parse(completedAt) : now.getTime();
  if (Number.isNaN(end)) return null;
  return Math.max(0, Math.floor((end - start) / 1000));
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function labelForCategory(category: ObservationCategory) {
  return category
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
