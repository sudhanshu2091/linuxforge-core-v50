import { describe, expect, it } from "vitest";
import type { AdaptiveExercise } from "@/lib/forge/types";
import type { CanonicalEnvironmentModel, MissionArtifact } from "@/lib/forge/environment/types";
import type { MissionBlueprint } from "./mission-generator";
import { validateAndPublishMissionV2 } from "./mission-generation-v2.server";

const validBlueprint: MissionBlueprint = {
  version: "v32",
  archetype: "PROGRESSION",
  primarySkill: "permissions",
  supportingSkills: ["filesystem"],
  difficulty: 2,
  prerequisites: ["filesystem"], // Valid: permissions depends on filesystem in SKILL_GRAPH
  objectiveShape: "Audit permissions for the team directory",
  storyContinuity: "Operation Citadel initialization",
  evidenceFocus: ["permissions"],
  knowledgeIds: ["kali-training"],
  mistakeFocus: null,
  rationale: "Progressive permission verification",
};

const validExercise: AdaptiveExercise = {
  id: "test-mission-001",
  kind: "mission",
  title: "Defensive Workspace Audit",
  scenario: "The incident response team requires an isolated workspace in /home/learner/workspace.",
  objective: "Audit permissions for the team directory and verify security mode.",
  skills: ["permissions", "filesystem"],
  difficulty: 2,
  estimatedMinutes: 15,
  sourceRefs: [
    {
      id: "kali-training",
      name: "Kali Training",
      url: "https://kali.training/",
    },
  ],
  evaluationFocus: ["Directory presence", "Permissions 750"],
  learnerReason: "Reinforcing secure directory configuration",
  allowedApproaches: ["mkdir -p workspace", "chmod 750 workspace"],
  bannedShortcuts: ["chmod 777"],
  hints: ["Use mkdir to make directory", "Use chmod 750 for permissions"],
  successStory: "Defensive workspace provisioned securely.",
  failureStory: "Defensive workspace permissions were left open or missing.",
  remediation: ["Review chmod permission octets."],
  evaluationPlan: {
    objectives: [
      {
        label: "Workspace directory exists",
        path: "workspace",
        objectType: "directory",
        permissions: "750",
      },
    ],
    requiredCommandKinds: ["mkdir", "chmod"],
  },
};

const mockSupportedEnv: CanonicalEnvironmentModel = {
  identity: {
    environmentId: "env-1",
    labId: "lab-1",
    userId: "user-1",
    provider: "mock-modelled-v1",
    runtimeClass: "container-dev",
    guestName: "Kali Linux",
    distribution: "Kali Linux",
    guestVersion: "2026.2",
    expectedArtifactRelease: "2026.2",
    guestVersionMatchesArtifact: true,
    architecture: "aarch64",
    kernel: "Linux 6.18",
    hostname: "kali",
    shell: "/bin/bash",
    currentUser: "linuxforge",
    privilegeState: "sudo_capable",
    evidence: "OBSERVED_FACT",
  },
  users: [],
  groups: [],
  filesystem: [],
  processes: [],
  services: [],
  packages: [],
  environment: { variables: {}, redactedKeys: [], evidence: "UNKNOWN" },
  network: { supported: true, networkIsolationEnforced: true, listeners: [], evidence: "OBSERVED_FACT" },
  system: { os: "Linux", distribution: "Kali", version: "2026.2", kernel: "6.18", architecture: "aarch64", hostname: "kali", evidence: "OBSERVED_FACT" },
  runtime: {
    provider: "mock-modelled-v1",
    runtimeClass: "container-dev",
    capabilities: {
      interactiveShell: true,
      streaming: true,
      resize: true,
      processes: true,
      services: true,
      environmentVariables: true,
      network: true,
      snapshots: true,
      pauseResume: true,
      packages: true,
    },
    security: {
      guestRootAllowed: true,
      hostFilesystemBlocked: true,
      privilegeEscalationBlocked: true,
      metadataAccessBlocked: true,
      networkIsolationEnforced: true,
    },
    lifecycleState: "RUNNING",
    evidence: "OBSERVED_FACT",
  },
  artifacts: [],
  capturedAt: new Date().toISOString(),
};

describe("Mission & Question Generation V2 — Deterministic Server-Side Validation Pipeline", () => {
  it("1. schema gate executes first: candidate failing schema is rejected as SCHEMA_INVALID before later gates", () => {
    // Fails schema (short title) AND environment (requires network on no-network env)
    const invalidSchemaAndEnv: AdaptiveExercise = {
      ...validExercise,
      title: "bad", // < 8 characters -> SCHEMA_INVALID
      skills: ["networking"],
    };

    const noNetEnv: CanonicalEnvironmentModel = {
      ...mockSupportedEnv,
      runtime: {
        ...mockSupportedEnv.runtime,
        capabilities: {
          ...mockSupportedEnv.runtime.capabilities,
          network: false,
        },
      },
    };

    const res = validateAndPublishMissionV2(invalidSchemaAndEnv, {
      environment: noNetEnv,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("SCHEMA_INVALID");
    }
  });

  it("2. structured environment capability requirement: enforced without literal prose strings", () => {
    // Evaluation focus says "package" and requiredCommandKinds has "mkdir" (valid command in executor)
    const structuredPkgExercise: AdaptiveExercise = {
      ...validExercise,
      title: "Package Requirement Verification",
      scenario: "Prepare the defensive tools suite for the forensic team workspace.",
      objective: "Audit permissions for the team directory and verify tool packages.",
      evaluationFocus: ["package installation"], // Structured requirement
      evaluationPlan: {
        objectives: [{ label: "tool ready", path: "tools", objectType: "directory" }],
        requiredCommandKinds: ["mkdir"],
      },
    };

    const noPkgEnv: CanonicalEnvironmentModel = {
      ...mockSupportedEnv,
      runtime: {
        ...mockSupportedEnv.runtime,
        capabilities: {
          ...mockSupportedEnv.runtime.capabilities,
          packages: false,
        },
      },
    };

    const res = validateAndPublishMissionV2(structuredPkgExercise, {
      blueprint: validBlueprint,
      environment: noPkgEnv,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("ENVIRONMENT_UNSUPPORTED");
      expect(res.reasons.some((r) => r.includes("package capability"))).toBe(true);
    }
  });

  it("3. unknown environment capability (undefined/null/false) is treated as unsupported", () => {
    const unknownEnv: CanonicalEnvironmentModel = {
      ...mockSupportedEnv,
      runtime: {
        ...mockSupportedEnv.runtime,
        capabilities: {
          ...mockSupportedEnv.runtime.capabilities,
          services: false,
        },
      },
    };

    const svcExercise: AdaptiveExercise = {
      ...validExercise,
      title: "Service Requirement Verification",
      scenario: "Prepare the daemon logging directory for the team.",
      objective: "Audit permissions for the team directory and verify background service.",
      evaluationFocus: ["service management"],
      evaluationPlan: {
        objectives: [{ label: "svc ready", path: "svc", objectType: "directory" }],
        requiredCommandKinds: ["mkdir"],
      },
    };

    const res = validateAndPublishMissionV2(svcExercise, {
      blueprint: validBlueprint,
      environment: unknownEnv,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("ENVIRONMENT_UNSUPPORTED");
      expect(res.reasons.some((r) => r.includes("service capability"))).toBe(true);
    }
  });

  it("4. network isolation remains strictly enforced for external operations", () => {
    const isolatedEnv: CanonicalEnvironmentModel = {
      ...mockSupportedEnv,
      network: {
        supported: true,
        networkIsolationEnforced: true,
        listeners: [],
        evidence: "OBSERVED_FACT",
      },
    };

    const netBlueprint: MissionBlueprint = {
      ...validBlueprint,
      primarySkill: "networking",
      supportingSkills: ["filesystem"],
      prerequisites: ["filesystem"],
      objectiveShape: "Configure local network diagnostics",
    };

    const netExercise: AdaptiveExercise = {
      ...validExercise,
      title: "External Network Sync Drill",
      skills: ["networking", "filesystem"],
      objective: "Configure local network diagnostics and sync external telemetry.",
      evaluationFocus: ["external network"],
      evaluationPlan: {
        objectives: [{ label: "sync", path: "sync.log", objectType: "file" }],
        requiredCommandKinds: ["touch"],
      },
    };

    const res = validateAndPublishMissionV2(netExercise, {
      blueprint: netBlueprint,
      environment: isolatedEnv,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("ENVIRONMENT_UNSUPPORTED");
      expect(res.reasons.some((r) => r.includes("strict network isolation"))).toBe(true);
    }
  });

  it("5. valid prerequisite consistent with SKILL_GRAPH passes", () => {
    const res = validateAndPublishMissionV2(validExercise, {
      blueprint: validBlueprint,
      environment: mockSupportedEnv,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.exercise.skills).toContain("permissions");
    }
  });

  it("6. invalid prerequisite skill rejected (PREREQUISITE_INVALID)", () => {
    const invalidPrereqBlueprint: MissionBlueprint = {
      ...validBlueprint,
      primarySkill: "permissions",
      prerequisites: ["nonexistent_skill" as any],
    };

    const res = validateAndPublishMissionV2(validExercise, {
      blueprint: invalidPrereqBlueprint,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("PREREQUISITE_INVALID");
      expect(res.reasons.some((r) => r.includes("not registered"))).toBe(true);
    }
  });

  it("7. circular or self prerequisite rejected (PREREQUISITE_INVALID)", () => {
    const circularBlueprint: MissionBlueprint = {
      ...validBlueprint,
      primarySkill: "permissions",
      prerequisites: ["permissions"], // Self reference
    };

    const res = validateAndPublishMissionV2(validExercise, {
      blueprint: circularBlueprint,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("PREREQUISITE_INVALID");
      expect(res.reasons.some((r) => r.includes("Circular prerequisite"))).toBe(true);
    }
  });

  it("8. generic continuity with arbitrary artifact A (workspace/report.txt)", () => {
    const artifactA: MissionArtifact = {
      id: "art-alpha",
      kind: "file",
      identifier: "workspace/report.txt",
      verified: true,
      evidence: "OBSERVED_FACT",
    };

    const res = validateAndPublishMissionV2(validExercise, {
      blueprint: validBlueprint,
      environment: mockSupportedEnv,
      trackedMissionArtifacts: [artifactA],
      requiredPriorArtifacts: ["workspace/report.txt"],
    });

    expect(res.ok).toBe(true);
  });

  it("9. generic continuity with arbitrary artifact B (incident/evidence.log)", () => {
    const artifactB: MissionArtifact = {
      id: "art-beta",
      kind: "file",
      identifier: "incident/evidence.log",
      verified: true,
      evidence: "OBSERVED_FACT",
    };

    const res = validateAndPublishMissionV2(validExercise, {
      blueprint: validBlueprint,
      environment: mockSupportedEnv,
      trackedMissionArtifacts: [artifactB],
      requiredPriorArtifacts: ["incident/evidence.log"],
    });

    expect(res.ok).toBe(true);
  });

  it("10. missing required prior artifact rejected (CONTINUITY_INVALID)", () => {
    const res = validateAndPublishMissionV2(validExercise, {
      blueprint: validBlueprint,
      environment: mockSupportedEnv,
      trackedMissionArtifacts: [], // Empty context
      requiredPriorArtifacts: ["incident/evidence.log"], // Missing!
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("CONTINUITY_INVALID");
      expect(res.reasons.some((r) => r.includes("incident/evidence.log"))).toBe(true);
    }
  });

  it("11. mission without continuity dependency passes normally", () => {
    const res = validateAndPublishMissionV2(validExercise, {
      blueprint: validBlueprint,
      environment: mockSupportedEnv,
    });

    expect(res.ok).toBe(true);
  });

  it("12. bounded repair still works for safe structural formatting", () => {
    const unformattedExercise: AdaptiveExercise = {
      ...validExercise,
      title: "   Defensive Workspace Audit   ",
      difficulty: 2.3,
      evaluationPlan: {
        objectives: [
          {
            label: "Workspace directory exists",
            path: "/home/learner/workspace",
            objectType: "directory",
            permissions: "750",
          },
        ],
        requiredCommandKinds: [" mkdir ", "CHMOD"],
      },
    };

    const res = validateAndPublishMissionV2(unformattedExercise, {
      blueprint: validBlueprint,
      environment: mockSupportedEnv,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.repaired).toBe(true);
      expect(res.repairAttempts).toBe(1);
      expect(res.exercise.title).toBe("Defensive Workspace Audit");
      expect(res.exercise.difficulty).toBe(2);
      expect(res.exercise.evaluationPlan?.objectives[0]?.path).toBe("workspace");
    }
  });

  it("13. deterministic contract preserves prerequisites and previousReferences", () => {
    const res = validateAndPublishMissionV2(validExercise, {
      blueprint: validBlueprint,
      environment: mockSupportedEnv,
      knownScenarioArtifacts: ["archive/evidence.tar.gz"],
    });

    expect(res.ok).toBe(true);
    if (res.ok && res.contract) {
      expect(res.contract.prerequisites).toEqual(["filesystem"]);
      expect(res.contract.previousReferences).toEqual(["archive/evidence.tar.gz"]);

      // Verify contract with mock world
      const mockWorld = new Map();
      mockWorld.set("workspace", {
        path: "workspace",
        objectType: "directory",
        permissions: "750",
      });

      const outcome = res.contract.verify(mockWorld as any, {
        commands: ["mkdir -p workspace", "chmod 750 workspace"],
        usedLoop: false,
        operations: 2,
      } as any);

      expect(outcome.objectives[0]?.met).toBe(true);
      expect(outcome.skillDemonstrated).toBe(true);
    }
  });

  it("14. identical input remains strictly deterministic", () => {
    const run1 = validateAndPublishMissionV2(validExercise, {
      blueprint: validBlueprint,
      environment: mockSupportedEnv,
    });

    const run2 = validateAndPublishMissionV2(validExercise, {
      blueprint: validBlueprint,
      environment: mockSupportedEnv,
    });

    expect(run1.ok).toBe(run2.ok);
    if (run1.ok && run2.ok) {
      expect(run1.exercise.id).toBe(run2.exercise.id);
      expect(run1.contract?.id).toBe(run2.contract?.id);
      expect(run1.contract?.xpReward).toBe(run2.contract?.xpReward);
    }
  });
});
