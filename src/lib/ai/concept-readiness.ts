/**
 * Concept Readiness & Setup Planning.
 *
 * Deterministic authority that inspects the learner's current environment,
 * skills, and available artifacts to determine whether the target concept
 * is ready for immediate instruction or requires an explicit setup / prerequisite
 * mission first.
 *
 * Product Rule:
 * The current environment must NOT become a permanent limitation on what
 * LinuxForge can teach. If a concept requires setup, LinuxForge generates
 * an appropriate setup / preparation path before the concept mission.
 */

import type { SkillId, SkillMemoryView } from "@/lib/forge/types";
import type { CanonicalEnvironmentModel } from "@/lib/forge/environment/types";
import { SKILL_GRAPH } from "./mission-generator";

export type ConceptReadinessStatus = "READY" | "SETUP_REQUIRED" | "UNSUPPORTED_CAPABILITY";

export type SetupRequirement = {
  kind: "artifact" | "prerequisite_skill" | "capability";
  description: string;
  targetSkill?: SkillId;
  targetArtifactPath?: string;
  requiredCapability?: string;
  deterministicSetupPlan?: string;
};

export type ConceptReadinessResult = {
  status: ConceptReadinessStatus;
  targetSkill: SkillId;
  ready: boolean;
  missingPrerequisites: SkillId[];
  missingCapabilities: string[];
  setupRequirements: SetupRequirement[];
  setupPlan?: string;
  recommendedSetupSkill?: SkillId;
};

/**
 * Evaluates whether the environment and learner are ready for a target concept.
 *
 * Invariant: AI is advisory; readiness logic is 100% deterministic.
 */
export function evaluateConceptReadiness(input: {
  targetSkill: SkillId;
  environment?: CanonicalEnvironmentModel | undefined;
  skills: readonly SkillMemoryView[];
  knownScenarioArtifacts?: readonly string[] | undefined;
  supportedCommandKinds?: readonly string[] | undefined;
}): ConceptReadinessResult {
  const { targetSkill, environment, skills } = input;
  const knownArtifacts = input.knownScenarioArtifacts ?? [];

  const missingPrerequisites: SkillId[] = [];
  const missingCapabilities: string[] = [];
  const setupRequirements: SetupRequirement[] = [];

  // 1. Skill prerequisite check from canonical SKILL_GRAPH
  const requiredPrereqs = SKILL_GRAPH[targetSkill] ?? [];
  for (const prereq of requiredPrereqs) {
    const memory = skills.find((s) => s.skillId === prereq);
    const hasCompetence =
      memory &&
      ((memory.successfulAttempts ?? 0) > 0 || (memory.mastery ?? 0) >= 30);
    if (!hasCompetence) {
      missingPrerequisites.push(prereq);
      setupRequirements.push({
        kind: "prerequisite_skill",
        description: `Prerequisite skill '${prereq}' must be practiced before advancing to '${targetSkill}'.`,
        targetSkill: prereq,
        deterministicSetupPlan: `Complete prerequisite drill for ${prereq}.`,
      });
    }
  }

  // 2. Runtime Capability check (if authoritative environment model is present)
  if (environment?.runtime?.capabilities) {
    const caps = environment.runtime.capabilities;

    if (targetSkill === "processes" && caps.processes === false) {
      missingCapabilities.push("processes");
      setupRequirements.push({
        kind: "capability",
        description: "Runtime does not support process inspection capabilities.",
        requiredCapability: "processes",
      });
    }

    if (targetSkill === "networking" && caps.network === false) {
      missingCapabilities.push("network");
      setupRequirements.push({
        kind: "capability",
        description: "Runtime does not support network inspection capabilities.",
        requiredCapability: "network",
      });
    }
  }

  // 3. Environment Artifact / Workspace Readiness check
  // Determine if target concept can use existing files, directories, /tmp, or requires setup
  if (environment) {
    const observedPaths = environment.filesystem.map((f) => f.path);
    const allPaths = [...new Set([...observedPaths, ...knownArtifacts])];
    const hasAnyUsableDir = allPaths.some(
      (p) =>
        p === "workspace" ||
        p.startsWith("workspace/") ||
        p === "project" ||
        p.startsWith("project/") ||
        p === "tmp" ||
        p.startsWith("tmp/") ||
        p === "/tmp" ||
        p.startsWith("/tmp/") ||
        p.includes("home"),
    );

    if (targetSkill === "permissions") {
      // Permissions mission requires a target directory or file to modify
      if (!hasAnyUsableDir && observedPaths.length === 0) {
        setupRequirements.push({
          kind: "artifact",
          description: "A workspace directory is required before practicing permissions management.",
          targetArtifactPath: "workspace",
          targetSkill: "filesystem",
          deterministicSetupPlan: "Create the workspace directory using mkdir.",
        });
      }
    } else if (targetSkill === "shell-scripting") {
      // Shell scripting requires a directory for scripts
      if (!hasAnyUsableDir && observedPaths.length === 0) {
        setupRequirements.push({
          kind: "artifact",
          description: "A scripts workspace directory is required before authoring shell scripts.",
          targetArtifactPath: "workspace",
          targetSkill: "filesystem",
          deterministicSetupPlan: "Create workspace directory for executable scripts.",
        });
      }
    } else if (targetSkill === "hardening") {
      // Hardening requires an existing configuration or audit target
      const hasAuditTarget = allPaths.some(
        (p) =>
          p.endsWith(".conf") ||
          p.endsWith(".cfg") ||
          p === "workspace" ||
          p.startsWith("workspace/"),
      );
      if (!hasAuditTarget && observedPaths.length === 0) {
        setupRequirements.push({
          kind: "artifact",
          description: "A configuration baseline is required before security hardening.",
          targetArtifactPath: "workspace/audit.conf",
          targetSkill: "filesystem",
          deterministicSetupPlan: "Initialize baseline workspace configuration file.",
        });
      }
    }
  }

  if (missingCapabilities.length > 0) {
    return {
      status: "UNSUPPORTED_CAPABILITY",
      targetSkill,
      ready: false,
      missingPrerequisites,
      missingCapabilities,
      setupRequirements,
      setupPlan: setupRequirements.map((r) => r.description).join("; "),
    };
  }

  if (setupRequirements.length > 0 && setupRequirements[0]) {
    const firstReq = setupRequirements[0];
    return {
      status: "SETUP_REQUIRED",
      targetSkill,
      ready: false,
      missingPrerequisites,
      missingCapabilities,
      setupRequirements,
      setupPlan: firstReq.deterministicSetupPlan ?? firstReq.description,
      recommendedSetupSkill: firstReq.targetSkill ?? missingPrerequisites[0] ?? "filesystem",
    };
  }

  return {
    status: "READY",
    targetSkill,
    ready: true,
    missingPrerequisites: [],
    missingCapabilities: [],
    setupRequirements: [],
  };
}
