import type { AdaptiveExercise, SkillId } from "@/lib/forge/types";
import type { MissionBlueprint } from "./mission-generator";
import { QUESTION_SOURCES } from "./question-bank";

const SKILLS: readonly SkillId[] = [
  "filesystem",
  "permissions",
  "iteration",
  "shell-scripting",
  "processes",
  "networking",
  "hardening",
];

const EXECUTABLE_COMMANDS = new Set([
  "pwd",
  "ls",
  "cd",
  "mkdir",
  "touch",
  "cat",
  "echo",
  "chmod",
  "stat",
  "tree",
  "rm",
  "clear",
  "help",
  "for",
]);

export type GenerationValidation = {
  valid: boolean;
  reasons: string[];
  normalized?: AdaptiveExercise;
};

const cleanText = (value: unknown, fallback = "") =>
  typeof value === "string" ? value.trim() : fallback;
const bounded = (value: unknown, max: number, fallback: string[] = []) =>
  Array.isArray(value)
    ? value
        .filter((v): v is string => typeof v === "string" && Boolean(v.trim()))
        .map((v) => v.trim())
        .slice(0, max)
    : fallback;

function safeRelativePath(path: unknown): boolean {
  if (typeof path !== "string" || !path.trim()) return false;
  const value = path.trim();
  if (value.startsWith("/") || value.includes("..")) return false;
  return value
    .split("/")
    .filter(Boolean)
    .every((part) => /^[A-Za-z0-9._-]+$/.test(part));
}

function planIsSafe(exercise: AdaptiveExercise): string[] {
  if (exercise.kind !== "task" && exercise.kind !== "mission") return [];
  const plan = exercise.evaluationPlan;
  if (
    !plan ||
    !Array.isArray(plan.objectives) ||
    plan.objectives.length < 1 ||
    plan.objectives.length > 12
  )
    return ["Executable exercises require 1-12 machine-verifiable objectives."];
  const reasons: string[] = [];
  for (const objective of plan.objectives) {
    if (!safeRelativePath(objective.path))
      reasons.push(`Unsafe objective path: ${String(objective.path)}`);
    if (objective.objectType !== "file" && objective.objectType !== "directory")
      reasons.push("Objective objectType is invalid.");
    if (objective.permissions !== undefined && !/^\d{3}$/.test(objective.permissions))
      reasons.push("Permissions must be exactly three octal digits.");
  }
  for (const command of plan.requiredCommandKinds ?? []) {
    const normalized = command.toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!EXECUTABLE_COMMANDS.has(normalized))
      reasons.push(`Unsupported generated command kind: ${command}`);
  }
  if ((plan.minimumMutations ?? 0) < 0 || (plan.minimumMutations ?? 0) > 100)
    reasons.push("Mutation requirement is outside the safe range.");
  const validCapabilities = new Set([
    "interactiveShell",
    "streaming",
    "resize",
    "processes",
    "services",
    "environmentVariables",
    "network",
    "snapshots",
    "pauseResume",
    "packages",
  ]);
  for (const cap of plan.requiredCapabilities ?? []) {
    if (!validCapabilities.has(cap)) {
      reasons.push(`Invalid evaluation plan capability requirement: ${cap}`);
    }
  }
  return reasons;
}

function blueprintReasons(exercise: AdaptiveExercise, blueprint?: MissionBlueprint): string[] {
  if (!blueprint) return [];
  const reasons: string[] = [];
  if (exercise.difficulty !== blueprint.difficulty)
    reasons.push("Difficulty does not match the mission blueprint.");
  if (!exercise.skills.includes(blueprint.primarySkill))
    reasons.push("Primary blueprint skill is missing.");
  for (const skill of blueprint.supportingSkills) {
    if (!exercise.skills.includes(skill)) reasons.push(`Supporting skill is missing: ${skill}`);
  }
  if (
    blueprint.mistakeFocus &&
    !new RegExp(blueprint.mistakeFocus.replace(/_/g, "[ _-]"), "i").test(
      `${exercise.objective} ${exercise.scenario} ${exercise.learnerReason}`,
    )
  ) {
    // A generated task does not need to expose the internal category name. Require
    // learner-facing evidence of the repair intent instead of leaking policy labels.
    if (
      blueprint.archetype === "REMEDIATION" &&
      !/repair|practice|correct|avoid|re-?demonstrat/i.test(
        `${exercise.objective} ${exercise.scenario} ${exercise.learnerReason}`,
      )
    )
      reasons.push("Remediation exercise does not clearly address the planned repair intent.");
  }
  return reasons;
}

function sourceReasons(exercise: AdaptiveExercise): string[] {
  const allowed = new Set<string>(QUESTION_SOURCES.map((source) => source.id));
  return exercise.sourceRefs.every((source) => allowed.has(source.id))
    ? []
    : ["One or more source references are not from the approved catalogue."];
}

/**
 * Server-side quality gate for AI-generated exercises. The model proposes the
 * content; this deterministic gate decides whether the proposal is safe and
 * coherent enough to become learner-facing/persisted content.
 */
export function validateGeneratedExercise(
  exercise: AdaptiveExercise,
  blueprint?: MissionBlueprint,
): GenerationValidation {
  const reasons: string[] = [];
  const title = cleanText(exercise.title);
  const objective = cleanText(exercise.objective);
  const scenario = cleanText(exercise.scenario);
  if (!title || title.length < 8 || title.length > 160)
    reasons.push("Title must be 8-160 characters.");
  if (!objective || objective.length < 20 || objective.length > 1200)
    reasons.push("Objective must be 20-1200 characters.");
  if (!scenario || scenario.length < 20 || scenario.length > 2000)
    reasons.push("Scenario must be 20-2000 characters.");
  if (!Number.isInteger(exercise.difficulty) || exercise.difficulty < 1 || exercise.difficulty > 5)
    reasons.push("Difficulty must be an integer from 1 to 5.");
  if (
    !Number.isFinite(exercise.estimatedMinutes) ||
    exercise.estimatedMinutes < 1 ||
    exercise.estimatedMinutes > 180
  )
    reasons.push("Estimated time must be 1-180 minutes.");
  if (!exercise.skills.length || exercise.skills.some((skill) => !SKILLS.includes(skill)))
    reasons.push("Skills contain an unsupported value.");
  if (!exercise.evaluationFocus.length) reasons.push("Evaluation focus cannot be empty.");
  if (!exercise.hints?.length) reasons.push("Generated exercises must provide at least one hint.");
  if (!exercise.sourceRefs.length)
    reasons.push("Generated exercises require at least one approved source reference.");
  reasons.push(
    ...sourceReasons(exercise),
    ...planIsSafe(exercise),
    ...blueprintReasons(exercise, blueprint),
  );

  if ((exercise.kind === "task" || exercise.kind === "mission") && !exercise.evaluationPlan) {
    reasons.push("Executable exercises require an evaluation plan.");
  }
  if (exercise.kind === "question" || exercise.kind === "mock_exam") {
    if (exercise.evaluationPlan)
      reasons.push("Conceptual exercises must not expose an executable evaluation plan.");
  }

  if (reasons.length) return { valid: false, reasons };
  return {
    valid: true,
    reasons: [],
    normalized: {
      ...exercise,
      title: title.slice(0, 160),
      scenario: scenario.slice(0, 2000),
      objective: objective.slice(0, 1200),
      learnerReason: cleanText(
        exercise.learnerReason,
        "Selected from the learner's verified evidence.",
      ).slice(0, 1200),
      evaluationFocus: bounded(exercise.evaluationFocus, 12),
      allowedApproaches: bounded(exercise.allowedApproaches, 12),
      bannedShortcuts: bounded(exercise.bannedShortcuts, 12),
      hints: bounded(exercise.hints, 8),
      remediation: bounded(exercise.remediation, 8),
      successStory: cleanText(exercise.successStory, "Exercise complete.").slice(0, 600),
      failureStory: cleanText(exercise.failureStory, "The exercise is not complete yet.").slice(
        0,
        600,
      ),
    },
  };
}

export function isMeaningfullyDifferent(
  exercise: AdaptiveExercise,
  recentTopics: readonly string[],
): boolean {
  const haystack = `${exercise.title} ${exercise.scenario}`.toLowerCase();
  const recent = recentTopics
    .map((topic) => topic.toLowerCase().trim())
    .filter((topic) => topic.length >= 5)
    .slice(-8);
  if (!recent.length) return true;
  return recent.every((topic) => !haystack.includes(topic));
}
