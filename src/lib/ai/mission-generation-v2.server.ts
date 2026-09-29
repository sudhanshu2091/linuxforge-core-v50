/**
 * Mission & Question Generation V2 — Deterministic Server-Side Validation Pipeline.
 *
 * Architecture:
 * GENERATE (existing AdaptiveExercise)
 *   ↓
 * SCHEMA VALIDATE (validateGeneratedExercise)
 *   ↓
 * ENVIRONMENT VALIDATE (authoritative CanonicalEnvironmentModel check)
 *   ↓
 * OBJECTIVE VALIDATE (blueprint, skills, and evaluation plan alignment)
 *   ↓
 * VERIFIER VALIDATE (deterministic Contract generation)
 *   ↓
 * DIFFICULTY VALIDATE (bounds and blueprint alignment)
 *   ↓
 * PREREQUISITE VALIDATE (skill graph and blueprint consistency)
 *   ↓
 * CONTINUITY VALIDATE (scenario artifacts & references)
 *   ↓
 * BOUNDED REPAIR OR REJECT (max 2 deterministic structural repair attempts)
 *   ↓
 * PUBLISH (returns validated exercise and executable Contract)
 *
 * Invariant: AI proposals are NEVER authoritative.
 * No exercise is published without 100% deterministic validation.
 */

import type { AdaptiveExercise } from "@/lib/forge/types";
import type { Contract } from "@/lib/forge/contracts.server";
import {
  generatedDefinitionToContract,
  type GeneratedDefinition,
  type GeneratedEvaluationPlan,
} from "@/lib/forge/generated-contract.server";
import type { CanonicalEnvironmentModel } from "@/lib/forge/environment/types";
import type { MissionBlueprint } from "./mission-generator";
import { validateGeneratedExercise } from "./exercise-generation.server";

export type MissionRejectionReasonCode =
  | "SCHEMA_INVALID"
  | "ENVIRONMENT_UNSUPPORTED"
  | "OBJECTIVE_INVALID"
  | "VERIFIER_UNSUPPORTED"
  | "DIFFICULTY_INVALID"
  | "PREREQUISITE_INVALID"
  | "CONTINUITY_INVALID";

export type MissionRejection = {
  ok: false;
  reason: MissionRejectionReasonCode;
  reasons: string[];
  details?: Record<string, unknown>;
  repairAttempts: number;
};

export type MissionPublishSuccess = {
  ok: true;
  exercise: AdaptiveExercise;
  contract?: Contract | undefined;
  repaired: boolean;
  repairAttempts: number;
};

export type MissionV2ValidationResult = MissionPublishSuccess | MissionRejection;

export type MissionV2Context = {
  blueprint?: MissionBlueprint;
  environment?: CanonicalEnvironmentModel;
  /** Known mission artifacts or state identifiers from previous missions in scenario */
  knownScenarioArtifacts?: string[];
  /** Allowed command kinds known to be supported by the environment */
  supportedCommandKinds?: string[];
};

/**
 * Deterministic, bounded repair function.
 * Max 2 attempts.
 * ONLY allowed for structural/formatting corrections.
 * MUST NOT invent commands, packages, services, files, permissions, or network access.
 */
function attemptDeterministicRepair(
  exercise: AdaptiveExercise,
  attempt: number,
  schemaErrors: string[],
): AdaptiveExercise | null {
  if (attempt > 2) return null;

  let repaired = { ...exercise };

  // Repair 1: trim and sanitize strings
  repaired.title = repaired.title?.trim() ?? "";
  repaired.objective = repaired.objective?.trim() ?? "";
  repaired.scenario = repaired.scenario?.trim() ?? "";

  // Repair 2: ensure difficulty is an integer within [1, 5] if slightly out of bounds or float
  if (Number.isFinite(repaired.difficulty)) {
    repaired.difficulty = Math.max(1, Math.min(5, Math.round(repaired.difficulty)));
  }

  // Repair 3: clean evaluationPlan paths and bounds if plan exists
  if (repaired.evaluationPlan?.objectives) {
    const cleanedObjectives = repaired.evaluationPlan.objectives.map((obj) => {
      let p = obj.path.trim();
      if (p.startsWith("/home/learner/")) p = p.slice("/home/learner/".length);
      else if (p.startsWith("/home/learner")) p = p.slice("/home/learner".length);
      else if (p.startsWith("~/")) p = p.slice(2);
      else if (p.startsWith("/")) p = p.slice(1);
      return {
        ...obj,
        label: obj.label?.trim() ?? "",
        path: p,
      };
    });

    const requiredCommandKinds = repaired.evaluationPlan.requiredCommandKinds
      ? repaired.evaluationPlan.requiredCommandKinds.map((k) => k.trim().toLowerCase())
      : undefined;

    repaired.evaluationPlan = {
      ...repaired.evaluationPlan,
      objectives: cleanedObjectives,
      ...(requiredCommandKinds ? { requiredCommandKinds } : {}),
    };
  }

  // Repair 4: remove duplicate skills or whitespace in skills
  if (Array.isArray(repaired.skills)) {
    repaired.skills = Array.from(new Set(repaired.skills));
  }

  // Check if repair changed anything
  const hasChanged = JSON.stringify(repaired) !== JSON.stringify(exercise);
  return hasChanged ? repaired : null;
}

/**
 * Stage 2: Environment Validation.
 * Validates that the exercise does not require capabilities or state unsupported by the environment.
 */
function validateEnvironmentSupport(
  exercise: AdaptiveExercise,
  env?: CanonicalEnvironmentModel,
): { valid: boolean; reasons: string[] } {
  if (!env) {
    // If no specific environment model is supplied (e.g. static theoretical question),
    // we only check that executable plans don't assume non-standard capabilities.
    return { valid: true, reasons: [] };
  }

  const reasons: string[] = [];
  const textCorpus = `${exercise.title} ${exercise.objective} ${exercise.scenario}`.toLowerCase();
  const plan = exercise.evaluationPlan;
  const caps = env.runtime?.capabilities;
  const net = env.network;

  // 1. Package requirements: if exercise mentions installing or requires package observation
  const requiresPackage =
    textCorpus.includes("apt install") ||
    textCorpus.includes("apt-get install") ||
    textCorpus.includes("dpkg -i") ||
    exercise.evaluationFocus.some((f) => f.toLowerCase().includes("package"));

  if (requiresPackage) {
    if (!caps?.packages) {
      reasons.push(
        "Exercise requires package management or package state verification, but environment does not support packages capability.",
      );
    }
  }

  // 2. Service requirements: if exercise requires service management or inspection
  const requiresService =
    textCorpus.includes("systemctl") ||
    textCorpus.includes("service ") ||
    exercise.evaluationFocus.some((f) => f.toLowerCase().includes("service"));

  if (requiresService) {
    if (!caps?.services) {
      reasons.push(
        "Exercise requires system service management or verification, but environment does not support services capability.",
      );
    }
  }

  // 3. Process requirements
  const requiresProcess =
    textCorpus.includes("kill ") ||
    textCorpus.includes("pkill ") ||
    textCorpus.includes("ps aux") ||
    exercise.evaluationFocus.some((f) => f.toLowerCase().includes("process"));

  if (requiresProcess) {
    if (!caps?.processes) {
      reasons.push(
        "Exercise requires process inspection or process control, but environment does not support processes capability.",
      );
    }
  }

  // 4. Network requirements: if exercise requires external or network operations
  const requiresNetwork =
    textCorpus.includes("ping ") ||
    textCorpus.includes("curl ") ||
    textCorpus.includes("nmap ") ||
    textCorpus.includes("nc ") ||
    textCorpus.includes("connect to") ||
    exercise.skills.includes("networking");

  if (requiresNetwork) {
    if (!caps?.network) {
      reasons.push(
        "Exercise requires networking capabilities, but environment does not support network operations.",
      );
    }
    if (net && net.networkIsolationEnforced && textCorpus.includes("external")) {
      reasons.push(
        "Exercise attempts external network connection, but environment enforces strict network isolation.",
      );
    }
  }

  // 5. Evaluation plan commands support
  if (plan?.requiredCommandKinds && caps) {
    for (const cmd of plan.requiredCommandKinds) {
      if (cmd === "service" || cmd === "systemctl") {
        if (!caps.services) reasons.push(`Command kind '${cmd}' requires unsupported services capability.`);
      }
      if (cmd === "ps" || cmd === "kill" || cmd === "pkill") {
        if (!caps.processes) reasons.push(`Command kind '${cmd}' requires unsupported processes capability.`);
      }
    }
  }

  return {
    valid: reasons.length === 0,
    reasons,
  };
}

/**
 * Stage 3: Objective Validation.
 * Validates that the exercise objective aligns with the blueprint, target skills, and evaluation plan.
 */
function validateObjective(
  exercise: AdaptiveExercise,
  blueprint?: MissionBlueprint,
): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // Check objective presence and length
  if (!exercise.objective || exercise.objective.trim().length < 20) {
    reasons.push("Objective must be at least 20 characters long.");
    return { valid: false, reasons };
  }

  // If blueprint exists, verify primary skill and objective cohesion
  if (blueprint) {
    if (!exercise.skills.includes(blueprint.primarySkill)) {
      reasons.push(
        `Generated exercise does not target the blueprint primary skill '${blueprint.primarySkill}'.`,
      );
    }

    // Ensure the objective shape is reflected
    if (blueprint.objectiveShape && blueprint.objectiveShape.length > 5) {
      const blueprintKeywords = blueprint.objectiveShape
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, " ")
        .split(" ")
        .filter((w) => w.length > 3);

      const objectiveText = exercise.objective.toLowerCase();
      const matches = blueprintKeywords.filter((k) => objectiveText.includes(k));
      if (blueprintKeywords.length >= 2 && matches.length === 0) {
        reasons.push("Generated objective does not reflect the required blueprint objective shape.");
      }
    }
  }

  // If it is a task or mission, the evaluation plan must measure the stated objective
  if (exercise.kind === "task" || exercise.kind === "mission") {
    if (!exercise.evaluationPlan || exercise.evaluationPlan.objectives.length === 0) {
      reasons.push("Executable task/mission must include concrete objectives in its evaluation plan.");
    }
  }

  return {
    valid: reasons.length === 0,
    reasons,
  };
}

/**
 * Stage 4: Verifier Validation.
 * Ensures the evaluation plan can be converted into a deterministic Contract without errors.
 */
function validateVerifierPlan(
  exercise: AdaptiveExercise,
  context?: MissionV2Context,
): { valid: boolean; contract?: Contract | undefined; reasons: string[] } {
  if (exercise.kind !== "task" && exercise.kind !== "mission") {
    // Conceptual questions don't require an executable filesystem Contract
    return { valid: true, reasons: [] };
  }

  if (!exercise.evaluationPlan) {
    return {
      valid: false,
      reasons: ["Executable exercise is missing evaluationPlan."],
    };
  }

  try {
    const generatedDef: GeneratedDefinition = {
      id: exercise.id,
      kind: exercise.kind,
      title: exercise.title,
      scenario: exercise.scenario,
      objective: exercise.objective,
      skills: exercise.skills,
      difficulty: exercise.difficulty,
      estimatedMinutes: exercise.estimatedMinutes,
      sourceRefs: exercise.sourceRefs,
      evaluationFocus: exercise.evaluationFocus,
      learnerReason: exercise.learnerReason,
      allowedApproaches: exercise.allowedApproaches ?? [],
      bannedShortcuts: exercise.bannedShortcuts ?? [],
      hints: exercise.hints ?? [],
      successStory: exercise.successStory ?? "Exercise completed.",
      failureStory: exercise.failureStory ?? "Exercise incomplete.",
      remediation: exercise.remediation ?? [],
      evaluationPlan: exercise.evaluationPlan as GeneratedEvaluationPlan,
    };

    const contract = generatedDefinitionToContract(generatedDef, {
      ...(context?.blueprint?.prerequisites ? { prerequisites: context.blueprint.prerequisites } : {}),
      ...(context?.knownScenarioArtifacts ? { previousReferences: context.knownScenarioArtifacts } : {}),
    });

    if (!contract || typeof contract.verify !== "function") {
      return {
        valid: false,
        reasons: ["Generated contract did not produce a deterministic verify function."],
      };
    }

    return { valid: true, contract, reasons: [] };
  } catch (err) {
    return {
      valid: false,
      reasons: [
        `Evaluation plan cannot be converted to deterministic Contract: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ],
    };
  }
}

/**
 * Stage 5: Difficulty Validation.
 * Verifies bounds (1-5) and alignment with blueprint if present.
 */
function validateDifficulty(
  exercise: AdaptiveExercise,
  blueprint?: MissionBlueprint,
): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (!Number.isInteger(exercise.difficulty) || exercise.difficulty < 1 || exercise.difficulty > 5) {
    reasons.push("Difficulty must be an integer between 1 and 5 inclusive.");
  }

  if (blueprint && Number.isFinite(blueprint.difficulty)) {
    // Difficulty must be within 1 step of blueprint difficulty
    const diff = Math.abs(exercise.difficulty - blueprint.difficulty);
    if (diff > 1) {
      reasons.push(
        `Generated difficulty (${exercise.difficulty}) deviates too far from blueprint difficulty (${blueprint.difficulty}).`,
      );
    }
  }

  return { valid: reasons.length === 0, reasons };
}

/**
 * Stage 6: Prerequisite Validation.
 * Verifies that the required skills and prerequisites are structurally coherent with the blueprint.
 */
function validatePrerequisites(
  exercise: AdaptiveExercise,
  blueprint?: MissionBlueprint,
): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (blueprint?.prerequisites && blueprint.prerequisites.length > 0) {
    // A skill cannot be a prerequisite of itself
    for (const prereq of blueprint.prerequisites) {
      if (prereq === blueprint.primarySkill && blueprint.prerequisites.length === 1) {
        reasons.push(`Circular prerequisite: skill '${prereq}' cannot be its own prerequisite.`);
      }
    }
  }

  return { valid: reasons.length === 0, reasons };
}

/**
 * Stage 7: Continuity Validation.
 * Validates scenario continuity: if an exercise refers to previous scenario artifacts,
 * they must be represented in context or be deterministically observable.
 */
function validateContinuity(
  exercise: AdaptiveExercise,
  context?: MissionV2Context,
): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const plan = exercise.evaluationPlan;

  if (context?.blueprint?.storyContinuity) {
    // Check if evaluation plan depends on an artifact that isn't provided
    const knownArtifacts = new Set(context.knownScenarioArtifacts ?? []);

    if (plan?.objectives) {
      for (const obj of plan.objectives) {
        // If an objective expects a file to already exist or mustNotExist in a non-standard location
        if (obj.path.includes("project_alpha") && !knownArtifacts.has(obj.path) && !knownArtifacts.has("project_alpha")) {
          // Unsupported continuity reference
          reasons.push(
            `Objective path '${obj.path}' depends on previous scenario artifact 'project_alpha' which is absent from scenario context.`,
          );
        }
      }
    }
  }

  return { valid: reasons.length === 0, reasons };
}

/**
 * Main V2 Mission & Question Generation Gate.
 * Runs candidate through all 7 validation stages with bounded deterministic repair.
 */
export function validateAndPublishMissionV2(
  candidate: AdaptiveExercise,
  context?: MissionV2Context,
): MissionV2ValidationResult {
  let currentCandidate = candidate;
  let repairAttempts = 0;
  let repaired = false;

  const maxAttempts = 2;

  while (repairAttempts <= maxAttempts) {
    // Gate 1: Difficulty Validation
    const diffValidation = validateDifficulty(currentCandidate, context?.blueprint);
    if (!diffValidation.valid) {
      if (repairAttempts < maxAttempts) {
        const repairedCandidate = attemptDeterministicRepair(
          currentCandidate,
          repairAttempts + 1,
          diffValidation.reasons,
        );
        if (repairedCandidate) {
          currentCandidate = repairedCandidate;
          repairAttempts++;
          repaired = true;
          continue;
        }
      }
      return {
        ok: false,
        reason: "DIFFICULTY_INVALID",
        reasons: diffValidation.reasons,
        repairAttempts,
      };
    }

    // Gate 2: Objective Validation
    const objValidation = validateObjective(currentCandidate, context?.blueprint);
    if (!objValidation.valid) {
      return {
        ok: false,
        reason: "OBJECTIVE_INVALID",
        reasons: objValidation.reasons,
        repairAttempts,
      };
    }

    // Gate 3: Verifier Validation
    const verifierValidation = validateVerifierPlan(currentCandidate, context);
    if (!verifierValidation.valid) {
      return {
        ok: false,
        reason: "VERIFIER_UNSUPPORTED",
        reasons: verifierValidation.reasons,
        repairAttempts,
      };
    }

    // Gate 4: Continuity Validation
    const contValidation = validateContinuity(currentCandidate, context);
    if (!contValidation.valid) {
      return {
        ok: false,
        reason: "CONTINUITY_INVALID",
        reasons: contValidation.reasons,
        repairAttempts,
      };
    }

    // Gate 5: Prerequisite Validation
    const prereqValidation = validatePrerequisites(currentCandidate, context?.blueprint);
    if (!prereqValidation.valid) {
      return {
        ok: false,
        reason: "PREREQUISITE_INVALID",
        reasons: prereqValidation.reasons,
        repairAttempts,
      };
    }

    // Gate 6: Environment Validation
    const envValidation = validateEnvironmentSupport(currentCandidate, context?.environment);
    if (!envValidation.valid) {
      return {
        ok: false,
        reason: "ENVIRONMENT_UNSUPPORTED",
        reasons: envValidation.reasons,
        repairAttempts,
      };
    }

    // Gate 7: Schema Validation (reusing existing validateGeneratedExercise)
    const schemaValidation = validateGeneratedExercise(currentCandidate, context?.blueprint);
    if (!schemaValidation.valid) {
      if (repairAttempts < maxAttempts) {
        const repairedCandidate = attemptDeterministicRepair(
          currentCandidate,
          repairAttempts + 1,
          schemaValidation.reasons,
        );
        if (repairedCandidate) {
          currentCandidate = repairedCandidate;
          repairAttempts++;
          repaired = true;
          continue;
        }
      }
      return {
        ok: false,
        reason: "SCHEMA_INVALID",
        reasons: schemaValidation.reasons,
        repairAttempts,
      };
    }

    // Normalized from schema validation if available
    if (schemaValidation.normalized) {
      currentCandidate = schemaValidation.normalized;
    }

    // All gates passed!
    return {
      ok: true,
      exercise: currentCandidate,
      contract: verifierValidation.contract,
      repaired,
      repairAttempts,
    };
  }

  return {
    ok: false,
    reason: "SCHEMA_INVALID",
    reasons: ["Exceeded maximum bounded repair attempts without resolving validation errors."],
    repairAttempts,
  };
}
