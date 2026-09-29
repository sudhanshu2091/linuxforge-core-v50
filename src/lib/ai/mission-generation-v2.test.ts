import { describe, expect, it } from "vitest";
import type { AdaptiveExercise } from "@/lib/forge/types";
import type { CanonicalEnvironmentModel } from "@/lib/forge/environment/types";
import type { MissionBlueprint } from "./mission-generator";
import { validateAndPublishMissionV2 } from "./mission-generation-v2.server";

const validBlueprint: MissionBlueprint = {
  version: "v32",
  archetype: "PROGRESSION",
  primarySkill: "filesystem",
  supportingSkills: ["permissions"],
  difficulty: 2,
  prerequisites: ["filesystem", "iteration"],
  objectiveShape: "Create defensive workspace and audit permissions",
  storyContinuity: "Operation Citadel initialization",
  evidenceFocus: ["filesystem", "permissions"],
  knowledgeIds: ["kali-training"],
  mistakeFocus: null,
  rationale: "Progressive filesystem and permission verification",
};

const validExercise: AdaptiveExercise = {
  id: "test-mission-001",
  kind: "mission",
  title: "Defensive Workspace Audit",
  scenario: "The incident response team requires an isolated workspace in /home/learner/workspace.",
  objective: "Create defensive workspace and audit permissions for the team directory.",
  skills: ["filesystem", "permissions"],
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
  it("1. valid generated exercise publishes with deterministic Contract", () => {
    const res = validateAndPublishMissionV2(validExercise, {
      blueprint: validBlueprint,
      environment: mockSupportedEnv,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.exercise.title).toBe(validExercise.title);
      expect(res.contract).toBeDefined();
      expect(typeof res.contract?.verify).toBe("function");
      expect(res.contract?.id).toBe(validExercise.id);
      expect(res.contract?.difficulty).toBe(2);
    }
  });

  it("2. schema-invalid exercise is rejected (SCHEMA_INVALID)", () => {
    const invalid = {
      ...validExercise,
      title: "Too short", // title must be 8-160 characters
      sourceRefs: [], // must have approved source refs
    };

    const res = validateAndPublishMissionV2(invalid);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("SCHEMA_INVALID");
      expect(res.reasons.length).toBeGreaterThan(0);
    }
  });

  it("3. unsupported environment capability is rejected (ENVIRONMENT_UNSUPPORTED)", () => {
    const limitedEnv: CanonicalEnvironmentModel = {
      ...mockSupportedEnv,
      runtime: {
        ...mockSupportedEnv.runtime,
        capabilities: {
          ...mockSupportedEnv.runtime.capabilities,
          packages: false,
          services: false,
          network: false,
        },
      },
    };

    const pkgExercise: AdaptiveExercise = {
      ...validExercise,
      title: "Package Installation Challenge",
      objective: "Install nmap using apt install nmap and configure port scan options.",
      evaluationFocus: ["package installation"],
    };

    const res = validateAndPublishMissionV2(pkgExercise, {
      environment: limitedEnv,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("ENVIRONMENT_UNSUPPORTED");
      expect(res.reasons.some((r) => r.includes("packages capability"))).toBe(true);
    }
  });

  it("4. invalid objective is rejected (OBJECTIVE_INVALID)", () => {
    const mismatchedObjectiveExercise: AdaptiveExercise = {
      ...validExercise,
      skills: ["networking"], // Mismatches blueprint.primarySkill ("filesystem")
      objective: "Completely unrelated task that has no alignment with filesystem.",
    };

    const res = validateAndPublishMissionV2(mismatchedObjectiveExercise, {
      blueprint: validBlueprint,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("OBJECTIVE_INVALID");
      expect(res.reasons.some((r) => r.includes("primary skill"))).toBe(true);
    }
  });

  it("5. unsupported verifier / invalid evaluation plan is rejected (VERIFIER_UNSUPPORTED)", () => {
    const badPlanExercise: AdaptiveExercise = {
      ...validExercise,
      evaluationPlan: {
        objectives: [
          {
            label: "Invalid objective with illegal path traversal",
            path: "../../../etc/shadow",
            objectType: "file",
          },
        ],
      },
    };

    const res = validateAndPublishMissionV2(badPlanExercise);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("VERIFIER_UNSUPPORTED");
    }
  });

  it("6. invalid difficulty is rejected (DIFFICULTY_INVALID)", () => {
    const badDifficultyExercise: AdaptiveExercise = {
      ...validExercise,
      difficulty: 5, // Blueprint difficulty is 2, diff > 1
    };

    const res = validateAndPublishMissionV2(badDifficultyExercise, {
      blueprint: validBlueprint,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("DIFFICULTY_INVALID");
    }
  });

  it("7. invalid prerequisite is rejected (PREREQUISITE_INVALID)", () => {
    const circularPrereqBlueprint: MissionBlueprint = {
      ...validBlueprint,
      primarySkill: "filesystem",
      prerequisites: ["filesystem"], // Skill cannot be sole prerequisite of itself
    };

    const res = validateAndPublishMissionV2(validExercise, {
      blueprint: circularPrereqBlueprint,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("PREREQUISITE_INVALID");
    }
  });

  it("8. invalid continuity dependency is rejected (CONTINUITY_INVALID)", () => {
    const continuityExercise: AdaptiveExercise = {
      ...validExercise,
      evaluationPlan: {
        objectives: [
          {
            label: "Inspect project alpha",
            path: "project_alpha/data.txt",
            objectType: "file",
          },
        ],
      },
    };

    const res = validateAndPublishMissionV2(continuityExercise, {
      blueprint: validBlueprint,
      knownScenarioArtifacts: [], // Does not have project_alpha
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("CONTINUITY_INVALID");
    }
  });

  it("9. bounded repair succeeds for a safe deterministic structural correction", () => {
    const unformattedExercise: AdaptiveExercise = {
      ...validExercise,
      title: "   Defensive Workspace Audit   ", // leading/trailing spaces
      difficulty: 2.4, // float difficulty
      evaluationPlan: {
        objectives: [
          {
            label: "Workspace directory exists",
            path: "/home/learner/workspace", // leading home path that can be normalized safely
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

  it("10. repair stops after maximum 2 attempts and rejects if still invalid", () => {
    const irreparablyBrokenExercise: AdaptiveExercise = {
      ...validExercise,
      title: "bad", // Irreparably short (< 8 chars)
    };

    const res = validateAndPublishMissionV2(irreparablyBrokenExercise);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.repairAttempts).toBeLessThanOrEqual(2);
      expect(res.reason).toBe("SCHEMA_INVALID");
    }
  });

  it("11. impossible candidate is rejected rather than fabricated", () => {
    const emptyObjExercise: AdaptiveExercise = {
      ...validExercise,
      evaluationPlan: {
        objectives: [],
      },
    };

    const res = validateAndPublishMissionV2(emptyObjExercise);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("OBJECTIVE_INVALID");
    }
  });

  it("12. package requirement cannot be invented if unsupported", () => {
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

    const pkgExercise: AdaptiveExercise = {
      ...validExercise,
      scenario: "Learner must run apt install wireshark to capture packets.",
    };

    const res = validateAndPublishMissionV2(pkgExercise, {
      environment: noPkgEnv,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("ENVIRONMENT_UNSUPPORTED");
    }
  });

  it("13. service requirement cannot be invented if unsupported", () => {
    const noSvcEnv: CanonicalEnvironmentModel = {
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
      scenario: "Learner must restart service using systemctl restart ssh.",
    };

    const res = validateAndPublishMissionV2(svcExercise, {
      environment: noSvcEnv,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("ENVIRONMENT_UNSUPPORTED");
    }
  });

  it("14. network requirement cannot be invented if network is isolated or unsupported", () => {
    const isolatedEnv: CanonicalEnvironmentModel = {
      ...mockSupportedEnv,
      network: {
        supported: true,
        networkIsolationEnforced: true,
        listeners: [],
        evidence: "OBSERVED_FACT",
      },
    };

    const netExercise: AdaptiveExercise = {
      ...validExercise,
      skills: ["networking"],
      objective: "Connect to external server and download payload.",
      scenario: "Learner connects to external remote IP.",
    };

    const res = validateAndPublishMissionV2(netExercise, {
      environment: isolatedEnv,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("ENVIRONMENT_UNSUPPORTED");
    }
  });

  it("15. unknown environment capability does not become supported", () => {
    // When capability is undefined / unknown, it must not be assumed true
    const unverifiedEnv: CanonicalEnvironmentModel = {
      ...mockSupportedEnv,
      runtime: {
        ...mockSupportedEnv.runtime,
        capabilities: {
          ...mockSupportedEnv.runtime.capabilities,
          packages: undefined,
        },
      },
    };

    const pkgExercise: AdaptiveExercise = {
      ...validExercise,
      scenario: "Learner executes dpkg -i package.deb",
    };

    const res = validateAndPublishMissionV2(pkgExercise, {
      environment: unverifiedEnv,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("ENVIRONMENT_UNSUPPORTED");
    }
  });

  it("16. deterministic identical input produces identical validation outcome", () => {
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

  it("17. provenance requirements remain intact for questions and exercises", () => {
    const noProvenanceExercise: AdaptiveExercise = {
      ...validExercise,
      sourceRefs: [], // Missing provenance
    };

    const res = validateAndPublishMissionV2(noProvenanceExercise);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("SCHEMA_INVALID");
      expect(res.reasons.some((r) => r.includes("source reference"))).toBe(true);
    }
  });

  it("18. generated contract remains deterministic and verifies state strictly", () => {
    const res = validateAndPublishMissionV2(validExercise, {
      blueprint: validBlueprint,
      environment: mockSupportedEnv,
      knownScenarioArtifacts: ["existing_file.txt"],
    });

    expect(res.ok).toBe(true);
    if (res.ok && res.contract) {
      expect(res.contract.prerequisites).toEqual(["filesystem", "iteration"]);
      expect(res.contract.previousReferences).toEqual(["existing_file.txt"]);

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
});
