/**
 * Turns a persisted AI-generated exercise into a server-only executable
 * contract. The AI supplies the plan; this module supplies the enforcement.
 * No generated text is trusted as a verifier.
 */
import type { MethodEvidence, World } from "./executor.server";
import type { ChallengeBrief, LearnerContext, ObjectiveResult, SkillId } from "./types";
import type { Contract, VerifyOutcome } from "./contracts.server";

export type GeneratedObjectivePlan = {
  label: string;
  path: string;
  objectType: "file" | "directory";
  permissions?: string;
  contentEquals?: string;
  contentContains?: string;
  mustNotExist?: boolean;
};

export type GeneratedEvaluationPlan = {
  objectives: GeneratedObjectivePlan[];
  requiredCommandKinds?: string[];
  requireLoop?: boolean;
  minimumMutations?: number;
  requiredCapabilities?: string[];
};

export type GeneratedDefinition = {
  id: string;
  kind: "question" | "task" | "mission" | "mock_exam";
  title: string;
  scenario: string;
  objective: string;
  skills: SkillId[];
  difficulty: number;
  estimatedMinutes: number;
  sourceRefs: { id: string; name: string; url: string }[];
  evaluationFocus: string[];
  learnerReason: string;
  allowedApproaches: string[];
  bannedShortcuts: string[];
  hints: string[];
  successStory: string;
  failureStory: string;
  remediation: string[];
  evaluationPlan: GeneratedEvaluationPlan;
};

const normalizePath = (raw: string): string | null => {
  let path = raw.trim();
  if (path.startsWith("/home/learner")) path = path.slice("/home/learner".length);
  if (path.startsWith("~/")) path = path.slice(1);
  if (path.startsWith("/")) path = path.slice(1);
  if (!path || path.includes("..")) return null;
  const parts = path.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || !/^[A-Za-z0-9._-]+$/.test(part))) return null;
  return parts.join("/");
};

const safePlan = (plan: GeneratedEvaluationPlan): GeneratedEvaluationPlan | null => {
  if (!Array.isArray(plan.objectives) || plan.objectives.length < 1 || plan.objectives.length > 12)
    return null;
  const objectives: GeneratedObjectivePlan[] = [];
  for (const item of plan.objectives) {
    const path = normalizePath(item.path);
    if (!path || typeof item.label !== "string") return null;
    if (item.permissions !== undefined && !/^\d{3}$/.test(item.permissions)) return null;
    objectives.push({
      label: item.label.slice(0, 160),
      path,
      objectType: item.objectType === "directory" ? "directory" : "file",
      ...(item.permissions ? { permissions: item.permissions } : {}),
      ...(typeof item.contentEquals === "string"
        ? { contentEquals: item.contentEquals.slice(0, 2000) }
        : {}),
      ...(typeof item.contentContains === "string"
        ? { contentContains: item.contentContains.slice(0, 2000) }
        : {}),
      ...(item.mustNotExist ? { mustNotExist: true } : {}),
    });
  }
  const requiredCommandKinds = Array.isArray(plan.requiredCommandKinds)
    ? plan.requiredCommandKinds
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.toLowerCase().replace(/[^a-z0-9_-]/g, ""))
        .filter(Boolean)
        .slice(0, 8)
    : [];
  const minimumMutations = Number.isFinite(plan.minimumMutations)
    ? Math.max(0, Math.min(100, Math.floor(plan.minimumMutations!)))
    : 0;
  return {
    objectives,
    requiredCommandKinds,
    requireLoop: plan.requireLoop === true,
    minimumMutations,
  };
};

export function generatedDefinitionToContract(
  definition: GeneratedDefinition,
  options?: {
    prerequisites?: string[];
    previousReferences?: string[];
  },
): Contract {
  const plan = safePlan(definition.evaluationPlan);
  if (!plan) throw new Error("Generated exercise has an invalid evaluation plan.");
  const requiredSkills = definition.skills.length
    ? definition.skills
    : (["filesystem"] as SkillId[]);
  const commandKinds = plan.requiredCommandKinds ?? [];
  return {
    id: definition.id,
    order: 100000,
    title: definition.title,
    storyIntro: definition.scenario,
    objective: definition.objective,
    requiredSkills,
    allowedApproaches: definition.allowedApproaches,
    bannedShortcuts: definition.bannedShortcuts,
    difficulty: definition.difficulty,
    prerequisites: options?.prerequisites ? [...options.prerequisites] : [],
    previousReferences: options?.previousReferences ? [...options.previousReferences] : [],
    contextRequirements: [
      "learner_level",
      "current_lab_state",
      "desired_difficulty",
    ] as (keyof LearnerContext)[],
    xpReward: Math.max(50, Math.min(500, 80 + definition.difficulty * 40)),
    hints: definition.hints,
    successStory: definition.successStory,
    failureStory: definition.failureStory,
    remediation: definition.remediation,
    verify(world: World, evidence: MethodEvidence): VerifyOutcome {
      const objectives: ObjectiveResult[] = plan.objectives.map((expected) => {
        const actual = world.get(expected.path);
        if (expected.mustNotExist) {
          return {
            label: expected.label,
            met: !actual,
            evidence: actual
              ? `${expected.path} still exists as a ${actual.objectType}`
              : `${expected.path} is absent as required`,
          };
        }
        const typeOk = actual?.objectType === expected.objectType;
        const permissionOk = !expected.permissions || actual?.permissions === expected.permissions;
        const equalsOk =
          expected.contentEquals === undefined || actual?.content === expected.contentEquals;
        const containsOk =
          expected.contentContains === undefined ||
          actual?.content.includes(expected.contentContains);
        const met = Boolean(actual && typeOk && permissionOk && equalsOk && containsOk);
        return {
          label: expected.label,
          met,
          evidence: !actual
            ? `${expected.path} does not exist`
            : `${expected.path}: ${actual.objectType}, permissions ${actual.permissions}${actual.content ? `, content ${JSON.stringify(actual.content.slice(0, 120))}` : ""}`,
        };
      });

      const commands = evidence.commands.map(
        (command) => command.trim().split(/\s+/)[0]?.toLowerCase() ?? "",
      );
      const commandKindsOk = commandKinds.every((kind) => commands.includes(kind));
      const loopOk = !plan.requireLoop || evidence.usedLoop;
      const mutationOk = evidence.operations >= (plan.minimumMutations ?? 0);
      const skillDemonstrated =
        commandKindsOk && loopOk && mutationOk && evidence.commands.length > 0;
      const allMet = objectives.every((o) => o.met);
      return {
        objectives,
        skillDemonstrated,
        skillAppliedToWrongTarget: evidence.commands.length > 0 && !allMet,
      };
    },
  };
}

export function generatedToBrief(definition: GeneratedDefinition): ChallengeBrief {
  return {
    id: definition.id,
    order: 100000,
    title: definition.title,
    storyIntro: definition.scenario,
    objective: definition.objective,
    requiredSkills: definition.skills,
    allowedApproaches: definition.allowedApproaches,
    bannedShortcuts: definition.bannedShortcuts,
    difficulty: definition.difficulty,
    prerequisites: [],
    previousReferences: [],
    xpReward: Math.max(50, Math.min(500, 80 + definition.difficulty * 40)),
    hintLevels: definition.hints.length,
  };
}
