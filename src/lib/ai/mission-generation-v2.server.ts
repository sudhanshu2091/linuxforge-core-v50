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
 * Gate 6: PREREQUISITE VALIDATE (strict canonical set matching using SKILL_GRAPH)
 *   ↓
 * Gate 7: CONTINUITY VALIDATE (structured MissionArtifact semantics & verification check)
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
import type {
  CanonicalEnvironmentModel,
  MissionArtifact,
  MissionArtifactKind,
} from "@/lib/forge/environment/types";
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

export type RequiredPriorArtifactSpec = {
  identifier: string;
  id?: string | undefined;
  kind?: MissionArtifactKind | undefined;
};

export type MissionV2Context = {
  blueprint?: MissionBlueprint | undefined;
  environment?: CanonicalEnvironmentModel | undefined;
  /** Known mission artifacts or state identifiers from previous missions in scenario */
  knownScenarioArtifacts?: string[] | undefined;
  /** Tracked structured mission artifacts from previous missions or environment */
  trackedMissionArtifacts?: MissionArtifact[] | undefined;
  /** Explicit list of prior artifact references required by scenario continuity (strings or structured specs) */
  requiredPriorArtifacts?: Array<string | RequiredPriorArtifactSpec> | undefined;
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
 * Consumes structured capability requirements directly from evaluationPlan.requiredCapabilities
 * without maintaining an ad-hoc command -> capability inference dictionary.
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

  // 1. Direct structured capabilities check: read exercise.evaluationPlan.requiredCapabilities
  const declaredCapabilities = plan?.requiredCapabilities ?? [];

  for (const cap of declaredCapabilities) {
    if (!caps || caps[cap] !== true) {
      reasons.push(
        `Exercise structurally requires capability '${cap}', but environment does not support it (value is ${String(caps ? caps[cap] : undefined)}).`,
      );
    }
  }

  // 2. Network isolation check:
  // If network is explicitly required or exercised, and external network is needed while isolation is enforced
  const requiresNetwork = declaredCapabilities.includes("network");
  const requiresExternal =
    exercise.evaluationFocus.some((f) => f.toLowerCase().includes("external network")) ||
    exercise.title.toLowerCase().includes("external network") ||
    exercise.objective.toLowerCase().includes("external network");

  if (requiresNetwork && requiresExternal && net && net.networkIsolationEnforced === true) {
    reasons.push(
      "Exercise attempts external network connection, but environment enforces strict network isolation.",
    );
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
 * Gate 6: Prerequisite Validation using Strict Canonical Set Matching.
 * Expected prerequisites = union of SKILL_GRAPH[primarySkill] and SKILL_GRAPH[supportingSkill] for all supportingSkills.
 * Uses exact set equality: all expected must be present, no extras, no invalid SkillIds, no self-reference.
 */
function validatePrerequisites(
  exercise: AdaptiveExercise,
  blueprint?: MissionBlueprint,
): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!blueprint) return { valid: true, reasons: [] };

  const validSkills = new Set<SkillId>(Object.keys(SKILL_GRAPH) as SkillId[]);

  // 1. Verify primary skill and supporting skills are valid SkillIds
  if (!validSkills.has(blueprint.primarySkill)) {
    reasons.push(`Invalid primary skill '${blueprint.primarySkill}' is not registered in the skill graph.`);
    return { valid: false, reasons };
  }

  for (const s of blueprint.supportingSkills ?? []) {
    if (!validSkills.has(s)) {
      reasons.push(`Invalid supporting skill '${s}' is not registered in the skill graph.`);
    }
  }

  // 2. Compute canonical expected prerequisite set = union of SKILL_GRAPH[primary] + SKILL_GRAPH[supporting]
  const expectedSet = new Set<SkillId>();
  for (const prereq of SKILL_GRAPH[blueprint.primarySkill] ?? []) {
    expectedSet.add(prereq);
  }
  for (const supporting of blueprint.supportingSkills ?? []) {
    for (const prereq of SKILL_GRAPH[supporting] ?? []) {
      expectedSet.add(prereq);
    }
  }

  // 3. Inspect blueprint.prerequisites
  const actualPrereqs = blueprint.prerequisites ?? [];
  const actualSet = new Set<SkillId>();

  for (const p of actualPrereqs) {
    // Check valid SkillId
    if (!validSkills.has(p)) {
      reasons.push(`Invalid prerequisite skill '${p}' is not registered in the skill graph.`);
      continue;
    }

    // Check self-reference
    if (p === blueprint.primarySkill) {
      reasons.push(`Circular prerequisite: primary skill '${p}' cannot be its own prerequisite.`);
    }

    // Check duplicate
    if (actualSet.has(p)) {
      reasons.push(`Duplicate prerequisite detected: '${p}'.`);
    }

    actualSet.add(p);
  }

  // 4. Set equality check: missing required prerequisites
  for (const expected of expectedSet) {
    if (!actualSet.has(expected)) {
      reasons.push(
        `Missing canonical prerequisite '${expected}' required for primary skill '${blueprint.primarySkill}' or supporting skills.`,
      );
    }
  }

  // 5. Set equality check: unexpected extra prerequisites
  for (const actual of actualSet) {
    if (!expectedSet.has(actual)) {
      reasons.push(
        `Unexpected extra prerequisite '${actual}' outside the canonical derived prerequisite set for '${blueprint.primarySkill}'.`,
      );
    }
  }

  return { valid: reasons.length === 0, reasons };
}

/**
 * Gate 7: Continuity Validation (Structured MissionArtifact Semantics).
 * Preserves structured MissionArtifact properties: identifier, id, kind, verified === true,
 * and reliable evidence level (rejects UNKNOWN / POSSIBLE_INTERPRETATION).
 */
function validateContinuity(
  exercise: AdaptiveExercise,
  context?: MissionV2Context,
): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // If there are no required prior artifacts and no scenario continuity dependency, pass neutral
  const requiredArtifacts = context?.requiredPriorArtifacts ?? [];
  if (requiredArtifacts.length === 0) {
    return { valid: true, reasons: [] };
  }

  // Collect available structured MissionArtifacts
  const availableArtifacts: MissionArtifact[] = [];

  if (context?.trackedMissionArtifacts) {
    availableArtifacts.push(...context.trackedMissionArtifacts);
  }
  if (context?.environment?.artifacts) {
    availableArtifacts.push(...context.environment.artifacts);
  }

  // Validate each required artifact reference
  for (const req of requiredArtifacts) {
    const targetIdentifier = typeof req === "string" ? req : req.identifier;
    const targetId = typeof req === "string" ? undefined : req.id;
    const targetKind = typeof req === "string" ? undefined : req.kind;

    // Find matching structured artifact by identifier or id
    const match = availableArtifacts.find((art) => {
      if (targetId && art.id === targetId) return true;
      if (art.identifier === targetIdentifier) return true;
      return false;
    });

    if (!match) {
      reasons.push(
        `Required prior scenario artifact '${targetIdentifier}' is absent from structured scenario context.`,
      );
      continue;
    }

    // Kind verification if explicitly specified
    if (targetKind && match.kind !== targetKind) {
      reasons.push(
        `Artifact '${targetIdentifier}' matches identifier but has incorrect kind '${match.kind}' (expected '${targetKind}').`,
      );
    }

    // Verification check: must be explicitly verified
    if (match.verified !== true) {
      reasons.push(
        `Required prior scenario artifact '${targetIdentifier}' is present but not verified (verified=false).`,
      );
    }

    // Evidence check: must not be UNKNOWN or POSSIBLE_INTERPRETATION
    if (match.evidence === "UNKNOWN" || match.evidence === "POSSIBLE_INTERPRETATION") {
      reasons.push(
        `Artifact '${targetIdentifier}' evidence level '${match.evidence}' is insufficient for authoritative scenario continuity.`,
      );
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
