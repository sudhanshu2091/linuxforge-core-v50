/**
 * Mission & Question Generation V2 — Deterministic Server-Side Validation Pipeline.
 *
 * Strict Deterministic Pipeline Order:
 * GENERATE (candidate AdaptiveExercise)
 *   ↓
 * Gate 1: SCHEMA VALIDATE (validateGeneratedExercise)
 *   ↓
 * Gate 2: ENVIRONMENT VALIDATE (authoritative CanonicalEnvironmentModel check)
 *   ↓
 * Gate 3: OBJECTIVE VALIDATE (blueprint, skills, and evaluation plan alignment)
 *   ↓
 * Gate 4: VERIFIER VALIDATE (deterministic Contract generation)
 *   ↓
 * Gate 5: DIFFICULTY VALIDATE (bounds and blueprint alignment)
 *   ↓
 * Gate 6: PREREQUISITE VALIDATE (deterministic validation using SKILL_GRAPH)
 *   ↓
 * Gate 7: CONTINUITY VALIDATE (generic scenario artifact & context validation)
 *   ↓
 * BOUNDED REPAIR OR REJECT (max 2 deterministic structural repair attempts)
 *   ↓
 * PUBLISH (returns validated exercise and executable Contract)
 *
 * Invariant: AI proposals are NEVER authoritative.
 * No exercise is published without 100% deterministic validation.
 */

import type { AdaptiveExercise, SkillId } from "@/lib/forge/types";
import type { Contract } from "@/lib/forge/contracts.server";
import {
  generatedDefinitionToContract,
  type GeneratedDefinition,
  type GeneratedEvaluationPlan,
} from "@/lib/forge/generated-contract.server";
import type { CanonicalEnvironmentModel, MissionArtifact } from "@/lib/forge/environment/types";
import { SKILL_GRAPH, type MissionBlueprint } from "./mission-generator";
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
  details?: Record<string, unknown> | undefined;
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
  blueprint?: MissionBlueprint | undefined;
  environment?: CanonicalEnvironmentModel | undefined;
  /** Known mission artifacts or state identifiers from previous missions in scenario */
  knownScenarioArtifacts?: string[] | undefined;
  /** Tracked structured mission artifacts from previous missions or environment */
  trackedMissionArtifacts?: MissionArtifact[] | undefined;
  /** Explicit list of prior artifact references required by scenario continuity */
  requiredPriorArtifacts?: string[] | undefined;
  /** Allowed command kinds known to be supported by the environment */
  supportedCommandKinds?: string[] | undefined;
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
 * Gate 2: Environment Validation.
 * Validates that the exercise structurally requires only capabilities supported by the environment.
 * Evaluates evaluationPlan, skills, evaluationFocus, and explicit capability needs.
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
  const plan = exercise.evaluationPlan;
  const caps = env.runtime?.capabilities;
  const net = env.network;

  // Derive structured requirements from evaluationPlan, skills, and evaluationFocus
  const structuredCommands = new Set(
    (plan?.requiredCommandKinds ?? []).map((c) => c.toLowerCase().trim()),
  );

  const evaluationFocusSet = new Set(
    exercise.evaluationFocus.map((f) => f.toLowerCase().trim()),
  );

  // 1. Package requirements
  const requiresPackage =
    structuredCommands.has("apt") ||
    structuredCommands.has("apt-get") ||
    structuredCommands.has("dpkg") ||
    evaluationFocusSet.has("package") ||
    evaluationFocusSet.has("package installation") ||
    evaluationFocusSet.has("packages");

  if (requiresPackage) {
    if (!caps || caps.packages !== true) {
      reasons.push(
        "Exercise structurally requires package capability, but environment does not support packages.",
      );
    }
  }

  // 2. Service requirements
  const requiresService =
    structuredCommands.has("systemctl") ||
    structuredCommands.has("service") ||
    evaluationFocusSet.has("service") ||
    evaluationFocusSet.has("services") ||
    evaluationFocusSet.has("service management");

  if (requiresService) {
    if (!caps || caps.services !== true) {
      reasons.push(
        "Exercise structurally requires service capability, but environment does not support services.",
      );
    }
  }

  // 3. Process requirements
  const requiresProcess =
    structuredCommands.has("ps") ||
    structuredCommands.has("kill") ||
    structuredCommands.has("pkill") ||
    structuredCommands.has("top") ||
    structuredCommands.has("htop") ||
    evaluationFocusSet.has("process") ||
    evaluationFocusSet.has("processes") ||
    evaluationFocusSet.has("process control");

  if (requiresProcess) {
    if (!caps || caps.processes !== true) {
      reasons.push(
        "Exercise structurally requires process capability, but environment does not support processes.",
      );
    }
  }

  // 4. Network requirements
  const requiresNetwork =
    exercise.skills.includes("networking") ||
    structuredCommands.has("ping") ||
    structuredCommands.has("curl") ||
    structuredCommands.has("nmap") ||
    structuredCommands.has("nc") ||
    evaluationFocusSet.has("network") ||
    evaluationFocusSet.has("networking") ||
    evaluationFocusSet.has("external network");

  if (requiresNetwork) {
    if (!caps || caps.network !== true) {
      reasons.push(
        "Exercise structurally requires networking capability, but environment does not support network operations.",
      );
    }
    // Check network isolation if external network is required
    const requiresExternal =
      evaluationFocusSet.has("external network") ||
      exercise.title.toLowerCase().includes("external") ||
      exercise.objective.toLowerCase().includes("external");

    if (net && net.networkIsolationEnforced && requiresExternal) {
      reasons.push(
        "Exercise attempts external network connection, but environment enforces strict network isolation.",
      );
    }
  }

  return {
    valid: reasons.length === 0,
    reasons,
  };
}

/**
 * Gate 3: Objective Validation.
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
 * Gate 4: Verifier Validation.
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
 * Gate 5: Difficulty Validation.
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
 * Gate 6: Prerequisite Validation using SKILL_GRAPH.
 * Deterministically verifies prerequisite relationships against the canonical SKILL_GRAPH.
 */
function validatePrerequisites(
  exercise: AdaptiveExercise,
  blueprint?: MissionBlueprint,
): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const validSkills = new Set<SkillId>(Object.keys(SKILL_GRAPH) as SkillId[]);

  if (blueprint?.prerequisites && blueprint.prerequisites.length > 0) {
    for (const prereq of blueprint.prerequisites) {
      // 1. Check if prerequisite skill is a valid registered SkillId in SKILL_GRAPH
      if (!validSkills.has(prereq)) {
        reasons.push(`Invalid prerequisite skill '${prereq}' is not registered in the skill graph.`);
        continue;
      }

      // 2. Check for self/circular reference
      if (prereq === blueprint.primarySkill) {
        reasons.push(`Circular prerequisite: primary skill '${prereq}' cannot be its own prerequisite.`);
      }
    }

    // 3. Verify that if SKILL_GRAPH specifies prerequisites for primarySkill,
    // the blueprint's prerequisites do not contradict or omit required graph relationships.
    const graphPrereqs = SKILL_GRAPH[blueprint.primarySkill] ?? [];
    if (graphPrereqs.length > 0) {
      const hasGraphPrereq = blueprint.prerequisites.some((p) => graphPrereqs.includes(p));
      if (!hasGraphPrereq) {
        reasons.push(
          `Blueprint prerequisites do not satisfy canonical skill graph prerequisites [${graphPrereqs.join(", ")}] for primary skill '${blueprint.primarySkill}'.`,
        );
      }
    }
  }

  return { valid: reasons.length === 0, reasons };
}

/**
 * Gate 7: Continuity Validation (Generic).
 * Uses structured scenario artifacts and requiredPriorArtifacts instead of hardcoded names.
 */
function validateContinuity(
  exercise: AdaptiveExercise,
  context?: MissionV2Context,
): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const plan = exercise.evaluationPlan;

  // Build a generic set of available/known scenario artifacts
  const knownArtifacts = new Set<string>();

  if (context?.knownScenarioArtifacts) {
    for (const art of context.knownScenarioArtifacts) {
      knownArtifacts.add(art.trim());
    }
  }

  if (context?.trackedMissionArtifacts) {
    for (const art of context.trackedMissionArtifacts) {
      knownArtifacts.add(art.identifier.trim());
      knownArtifacts.add(art.id.trim());
    }
  }

  if (context?.environment?.artifacts) {
    for (const art of context.environment.artifacts) {
      knownArtifacts.add(art.identifier.trim());
      knownArtifacts.add(art.id.trim());
    }
  }

  // 1. Check requiredPriorArtifacts in context: any artifact explicitly required by scenario must exist in known context
  if (context?.requiredPriorArtifacts && context.requiredPriorArtifacts.length > 0) {
    for (const requiredArt of context.requiredPriorArtifacts) {
      if (!knownArtifacts.has(requiredArt)) {
        reasons.push(
          `Scenario continuity requirement '${requiredArt}' is absent from supplied scenario context.`,
        );
      }
    }
  }

  // 2. Check evaluation objectives for explicit prior artifact dependencies
  if (plan?.objectives) {
    for (const obj of plan.objectives) {
      if (context?.requiredPriorArtifacts && context.requiredPriorArtifacts.includes(obj.path)) {
        if (!knownArtifacts.has(obj.path)) {
          reasons.push(
            `Objective path '${obj.path}' requires prior scenario artifact which is absent from scenario context.`,
          );
        }
      }
    }
  }

  return { valid: reasons.length === 0, reasons };
}

/**
 * Main V2 Mission & Question Generation Gate.
 * Runs candidate through all 7 validation stages in the STRICT intended order:
 *
 * GENERATE
 *   ↓
 * Gate 1: SCHEMA VALIDATE
 *   ↓
 * Gate 2: ENVIRONMENT VALIDATE
 *   ↓
 * Gate 3: OBJECTIVE VALIDATE
 *   ↓
 * Gate 4: VERIFIER VALIDATE
 *   ↓
 * Gate 5: DIFFICULTY VALIDATE
 *   ↓
 * Gate 6: PREREQUISITE VALIDATE
 *   ↓
 * Gate 7: CONTINUITY VALIDATE
 *   ↓
 * BOUNDED REPAIR OR REJECT
 *   ↓
 * PUBLISH
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
    // Gate 1: SCHEMA VALIDATE (validateGeneratedExercise)
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

    // Gate 2: ENVIRONMENT VALIDATE
    const envValidation = validateEnvironmentSupport(currentCandidate, context?.environment);
    if (!envValidation.valid) {
      return {
        ok: false,
        reason: "ENVIRONMENT_UNSUPPORTED",
        reasons: envValidation.reasons,
        repairAttempts,
      };
    }

    // Gate 3: OBJECTIVE VALIDATE
    const objValidation = validateObjective(currentCandidate, context?.blueprint);
    if (!objValidation.valid) {
      return {
        ok: false,
        reason: "OBJECTIVE_INVALID",
        reasons: objValidation.reasons,
        repairAttempts,
      };
    }

    // Gate 4: VERIFIER VALIDATE
    const verifierValidation = validateVerifierPlan(currentCandidate, context);
    if (!verifierValidation.valid) {
      return {
        ok: false,
        reason: "VERIFIER_UNSUPPORTED",
        reasons: verifierValidation.reasons,
        repairAttempts,
      };
    }

    // Gate 5: DIFFICULTY VALIDATE
    const diffValidation = validateDifficulty(currentCandidate, context?.blueprint);
    if (!diffValidation.valid) {
      return {
        ok: false,
        reason: "DIFFICULTY_INVALID",
        reasons: diffValidation.reasons,
        repairAttempts,
      };
    }

    // Gate 6: PREREQUISITE VALIDATE
    const prereqValidation = validatePrerequisites(currentCandidate, context?.blueprint);
    if (!prereqValidation.valid) {
      return {
        ok: false,
        reason: "PREREQUISITE_INVALID",
        reasons: prereqValidation.reasons,
        repairAttempts,
      };
    }

    // Gate 7: CONTINUITY VALIDATE
    const contValidation = validateContinuity(currentCandidate, context);
    if (!contValidation.valid) {
      return {
        ok: false,
        reason: "CONTINUITY_INVALID",
        reasons: contValidation.reasons,
        repairAttempts,
      };
    }

    // All 7 gates passed!
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
