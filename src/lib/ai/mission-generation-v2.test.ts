import { describe, expect, it } from "vitest";
import type { AdaptiveExercise } from "@/lib/forge/types";
import type { CanonicalEnvironmentModel, MissionArtifact } from "@/lib/forge/environment/types";
import type { MissionBlueprint } from "./mission-generator";
import { validateAndPublishMissionV2 } from "./mission-generation-v2.server";

// Valid base blueprint: primarySkill is "permissions", which has canonical prerequisite ["filesystem"] in SKILL_GRAPH
const validBlueprint: MissionBlueprint = {
  version: "v32",
  archetype: "PROGRESSION",
  primarySkill: "permissions",
  supportingSkills: [],
  difficulty: 2,
  prerequisites: ["filesystem"], // Exact canonical prerequisite set
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
  skills: ["permissions"],
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

describe("Mission Generation V2 — Pass 2B Formal Suite", () => {
  // ---------------------------------------------------------
  // 1. Pipeline Gate Order
  // ---------------------------------------------------------
  it("Gate 1 executes first: schema failure rejects as SCHEMA_INVALID before later gates", () => {
    const invalidSchema: AdaptiveExercise = {
      ...validExercise,
      title: "bad", // < 8 chars -> SCHEMA_INVALID
      evaluationPlan: {
        objectives: [{ label: "obj", path: "test", objectType: "file" }],
        requiredCapabilities: ["packages"],
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

    const res = validateAndPublishMissionV2(invalidSchema, {
      environment: noPkgEnv,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("SCHEMA_INVALID");
    }
  });

  // ---------------------------------------------------------
  // 2. PREREQUISITES (A through J)
  // ---------------------------------------------------------
  describe("Prerequisites — Exact Canonical Set Equality (A-J)", () => {
    it("A. filesystem with [] => PASS (filesystem has empty canonical prerequisite set)", () => {
      const fsBlueprint: MissionBlueprint = {
        ...validBlueprint,
        primarySkill: "filesystem",
        supportingSkills: [],
        prerequisites: [],
        objectiveShape: "Audit files in directory",
      };
      const fsExercise: AdaptiveExercise = {
        ...validExercise,
        skills: ["filesystem"],
        objective: "Audit files in directory and list contents accurately.",
      };

      const res = validateAndPublishMissionV2(fsExercise, {
        blueprint: fsBlueprint,
        environment: mockSupportedEnv,
      });

      expect(res.ok).toBe(true);
    });

    it("B. permissions with ['filesystem'] => PASS", () => {
      const res = validateAndPublishMissionV2(validExercise, {
        blueprint: validBlueprint,
        environment: mockSupportedEnv,
      });

      expect(res.ok).toBe(true);
    });

    it("C. hardening with ['filesystem', 'permissions', 'networking'] => PASS", () => {
      const hardeningBlueprint: MissionBlueprint = {
        ...validBlueprint,
        primarySkill: "hardening",
        supportingSkills: [],
        prerequisites: ["filesystem", "permissions", "networking"],
        objectiveShape: "Harden system and secure network configuration",
      };
      const hardeningExercise: AdaptiveExercise = {
        ...validExercise,
        skills: ["hardening"],
        objective: "Harden system and secure network configuration against attacks.",
      };

      const res = validateAndPublishMissionV2(hardeningExercise, {
        blueprint: hardeningBlueprint,
        environment: mockSupportedEnv,
      });

      expect(res.ok).toBe(true);
    });

    it("D. hardening with only ['filesystem'] => FAIL (incomplete canonical set)", () => {
      const incompleteBlueprint: MissionBlueprint = {
        ...validBlueprint,
        primarySkill: "hardening",
        supportingSkills: [],
        prerequisites: ["filesystem"],
        objectiveShape: "Harden system and secure network configuration",
      };
      const hardeningExercise: AdaptiveExercise = {
        ...validExercise,
        skills: ["hardening"],
        objective: "Harden system and secure network configuration against attacks.",
      };

      const res = validateAndPublishMissionV2(hardeningExercise, {
        blueprint: incompleteBlueprint,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("PREREQUISITE_INVALID");
        expect(res.reasons.some((r) => r.includes("Missing canonical prerequisite 'permissions'"))).toBe(true);
        expect(res.reasons.some((r) => r.includes("Missing canonical prerequisite 'networking'"))).toBe(true);
      }
    });

    it("E. hardening missing any one canonical prerequisite => FAIL", () => {
      const missingNetworkingBlueprint: MissionBlueprint = {
        ...validBlueprint,
        primarySkill: "hardening",
        supportingSkills: [],
        prerequisites: ["filesystem", "permissions"], // Missing networking
        objectiveShape: "Harden system and secure network configuration",
      };
      const hardeningExercise: AdaptiveExercise = {
        ...validExercise,
        skills: ["hardening"],
        objective: "Harden system and secure network configuration against attacks.",
      };

      const res = validateAndPublishMissionV2(hardeningExercise, {
        blueprint: missingNetworkingBlueprint,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("PREREQUISITE_INVALID");
        expect(res.reasons.some((r) => r.includes("Missing canonical prerequisite 'networking'"))).toBe(true);
      }
    });

    it("F. hardening with an unexpected extra prerequisite => FAIL", () => {
      const extraBlueprint: MissionBlueprint = {
        ...validBlueprint,
        primarySkill: "hardening",
        supportingSkills: [],
        prerequisites: ["filesystem", "permissions", "networking", "iteration"], // 'iteration' is extra
        objectiveShape: "Harden system and secure network configuration",
      };
      const hardeningExercise: AdaptiveExercise = {
        ...validExercise,
        skills: ["hardening"],
        objective: "Harden system and secure network configuration against attacks.",
      };

      const res = validateAndPublishMissionV2(hardeningExercise, {
        blueprint: extraBlueprint,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("PREREQUISITE_INVALID");
        expect(res.reasons.some((r) => r.includes("Unexpected extra prerequisite 'iteration'"))).toBe(true);
      }
    });

    it("G. primary skill included as its own prerequisite => FAIL", () => {
      const selfPrereqBlueprint: MissionBlueprint = {
        ...validBlueprint,
        primarySkill: "permissions",
        prerequisites: ["permissions"],
      };

      const res = validateAndPublishMissionV2(validExercise, {
        blueprint: selfPrereqBlueprint,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("PREREQUISITE_INVALID");
        expect(res.reasons.some((r) => r.includes("Circular prerequisite"))).toBe(true);
      }
    });

    it("H. invalid SkillId => FAIL", () => {
      const invalidSkillBlueprint: MissionBlueprint = {
        ...validBlueprint,
        primarySkill: "permissions",
        prerequisites: ["nonexistent_skill" as any],
      };

      const res = validateAndPublishMissionV2(validExercise, {
        blueprint: invalidSkillBlueprint,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("PREREQUISITE_INVALID");
        expect(res.reasons.some((r) => r.includes("not registered"))).toBe(true);
      }
    });

    it("I. supporting-skill prerequisites included in canonical expected set => PASS only when complete set is present", () => {
      // primary: "permissions" (needs filesystem)
      // supporting: ["shell-scripting"] (needs filesystem, iteration)
      // expected union: ["filesystem", "iteration"]
      const multiSkillBlueprint: MissionBlueprint = {
        ...validBlueprint,
        primarySkill: "permissions",
        supportingSkills: ["shell-scripting"],
        prerequisites: ["filesystem", "iteration"],
      };

      const multiSkillExercise: AdaptiveExercise = {
        ...validExercise,
        skills: ["permissions", "shell-scripting"],
      };

      const res = validateAndPublishMissionV2(multiSkillExercise, {
        blueprint: multiSkillBlueprint,
        environment: mockSupportedEnv,
      });

      expect(res.ok).toBe(true);
    });

    it("J. duplicate prerequisite => FAIL", () => {
      const duplicatePrereqBlueprint: MissionBlueprint = {
        ...validBlueprint,
        primarySkill: "permissions",
        prerequisites: ["filesystem", "filesystem"], // Duplicate
      };

      const res = validateAndPublishMissionV2(validExercise, {
        blueprint: duplicatePrereqBlueprint,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("PREREQUISITE_INVALID");
        expect(res.reasons.some((r) => r.includes("Duplicate prerequisite"))).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------
  // 3. ENVIRONMENT (K through S)
  // ---------------------------------------------------------
  describe("Environment — Explicit Capabilities Only (K-S)", () => {
    it("K. requiredCapabilities ['packages'] + packages=true => PASS", () => {
      const exerciseWithPackages: AdaptiveExercise = {
        ...validExercise,
        evaluationPlan: {
          ...validExercise.evaluationPlan!,
          requiredCapabilities: ["packages"],
        },
      };

      const res = validateAndPublishMissionV2(exerciseWithPackages, {
        blueprint: validBlueprint,
        environment: mockSupportedEnv,
      });

      expect(res.ok).toBe(true);
    });

    it("L. requiredCapabilities ['packages'] + packages=false => FAIL ENVIRONMENT_UNSUPPORTED", () => {
      const exerciseWithPackages: AdaptiveExercise = {
        ...validExercise,
        evaluationPlan: {
          ...validExercise.evaluationPlan!,
          requiredCapabilities: ["packages"],
        },
      };

      const envNoPkg: CanonicalEnvironmentModel = {
        ...mockSupportedEnv,
        runtime: {
          ...mockSupportedEnv.runtime,
          capabilities: {
            ...mockSupportedEnv.runtime.capabilities,
            packages: false,
          },
        },
      };

      const res = validateAndPublishMissionV2(exerciseWithPackages, {
        blueprint: validBlueprint,
        environment: envNoPkg,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("ENVIRONMENT_UNSUPPORTED");
        expect(res.reasons.some((r) => r.includes("packages"))).toBe(true);
      }
    });

    it("M. requiredCapabilities ['packages'] + packages=undefined => FAIL ENVIRONMENT_UNSUPPORTED", () => {
      const exerciseWithPackages: AdaptiveExercise = {
        ...validExercise,
        evaluationPlan: {
          ...validExercise.evaluationPlan!,
          requiredCapabilities: ["packages"],
        },
      };

      const envUndefinedPkg: CanonicalEnvironmentModel = {
        ...mockSupportedEnv,
        runtime: {
          ...mockSupportedEnv.runtime,
          capabilities: {
            ...mockSupportedEnv.runtime.capabilities,
            packages: undefined,
          },
        },
      };

      const res = validateAndPublishMissionV2(exerciseWithPackages, {
        blueprint: validBlueprint,
        environment: envUndefinedPkg,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("ENVIRONMENT_UNSUPPORTED");
      }
    });

    it("N. services=false => FAIL", () => {
      const exerciseWithServices: AdaptiveExercise = {
        ...validExercise,
        evaluationPlan: {
          ...validExercise.evaluationPlan!,
          requiredCapabilities: ["services"],
        },
      };

      const envNoSvc: CanonicalEnvironmentModel = {
        ...mockSupportedEnv,
        runtime: {
          ...mockSupportedEnv.runtime,
          capabilities: {
            ...mockSupportedEnv.runtime.capabilities,
            services: false,
          },
        },
      };

      const res = validateAndPublishMissionV2(exerciseWithServices, {
        blueprint: validBlueprint,
        environment: envNoSvc,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("ENVIRONMENT_UNSUPPORTED");
        expect(res.reasons.some((r) => r.includes("services"))).toBe(true);
      }
    });

    it("O. processes=false => FAIL", () => {
      const exerciseWithProcesses: AdaptiveExercise = {
        ...validExercise,
        evaluationPlan: {
          ...validExercise.evaluationPlan!,
          requiredCapabilities: ["processes"],
        },
      };

      const envNoProc: CanonicalEnvironmentModel = {
        ...mockSupportedEnv,
        runtime: {
          ...mockSupportedEnv.runtime,
          capabilities: {
            ...mockSupportedEnv.runtime.capabilities,
            processes: false,
          },
        },
      };

      const res = validateAndPublishMissionV2(exerciseWithProcesses, {
        blueprint: validBlueprint,
        environment: envNoProc,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("ENVIRONMENT_UNSUPPORTED");
        expect(res.reasons.some((r) => r.includes("processes"))).toBe(true);
      }
    });

    it("P. network=false => FAIL", () => {
      const exerciseWithNetwork: AdaptiveExercise = {
        ...validExercise,
        evaluationPlan: {
          ...validExercise.evaluationPlan!,
          requiredCapabilities: ["network"],
        },
      };

      const envNoNet: CanonicalEnvironmentModel = {
        ...mockSupportedEnv,
        runtime: {
          ...mockSupportedEnv.runtime,
          capabilities: {
            ...mockSupportedEnv.runtime.capabilities,
            network: false,
          },
        },
      };

      const res = validateAndPublishMissionV2(exerciseWithNetwork, {
        blueprint: validBlueprint,
        environment: envNoNet,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("ENVIRONMENT_UNSUPPORTED");
        expect(res.reasons.some((r) => r.includes("network"))).toBe(true);
      }
    });

    it("Q. network isolation enforced + external network requirement => FAIL", () => {
      const exerciseWithExternalNet: AdaptiveExercise = {
        ...validExercise,
        evaluationFocus: ["external network sync"],
        evaluationPlan: {
          ...validExercise.evaluationPlan!,
          requiredCapabilities: ["network"],
        },
      };

      const isolatedEnv: CanonicalEnvironmentModel = {
        ...mockSupportedEnv,
        network: {
          supported: true,
          networkIsolationEnforced: true,
          listeners: [],
          evidence: "OBSERVED_FACT",
        },
      };

      const res = validateAndPublishMissionV2(exerciseWithExternalNet, {
        blueprint: validBlueprint,
        environment: isolatedEnv,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("ENVIRONMENT_UNSUPPORTED");
        expect(res.reasons.some((r) => r.includes("strict network isolation"))).toBe(true);
      }
    });

    it("R. no requiredCapabilities => does not invent requirements", () => {
      const res = validateAndPublishMissionV2(validExercise, {
        blueprint: validBlueprint,
        environment: mockSupportedEnv,
      });

      expect(res.ok).toBe(true);
    });

    it("S. requiredCommandKinds alone MUST NOT infer capability support", () => {
      // Evaluation plan contains "apt" in requiredCommandKinds (command evidence),
      // but requiredCapabilities is empty. Therefore V2 does NOT infer packages requirement.
      const envNoPkg: CanonicalEnvironmentModel = {
        ...mockSupportedEnv,
        runtime: {
          ...mockSupportedEnv.runtime,
          capabilities: {
            ...mockSupportedEnv.runtime.capabilities,
            packages: false,
          },
        },
      };

      const res = validateAndPublishMissionV2(validExercise, {
        blueprint: validBlueprint,
        environment: envNoPkg,
      });

      // Passes without error because requiredCapabilities was not requested!
      expect(res.ok).toBe(true);
    });
  });

  // ---------------------------------------------------------
  // 4. CONTINUITY (T through Z)
  // ---------------------------------------------------------
  describe("Continuity — Structured MissionArtifact Semantics (T-Z)", () => {
    it("T. verified file artifact workspace/report.txt => PASS", () => {
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

    it("U. verified file artifact incident/evidence.log => PASS", () => {
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

    it("V. missing artifact => FAIL CONTINUITY_INVALID", () => {
      const res = validateAndPublishMissionV2(validExercise, {
        blueprint: validBlueprint,
        environment: mockSupportedEnv,
        trackedMissionArtifacts: [],
        requiredPriorArtifacts: ["incident/evidence.log"],
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("CONTINUITY_INVALID");
        expect(res.reasons.some((r) => r.includes("incident/evidence.log"))).toBe(true);
      }
    });

    it("W. same identifier but verified=false => FAIL", () => {
      const unverifiedArtifact: MissionArtifact = {
        id: "art-unverified",
        kind: "file",
        identifier: "workspace/report.txt",
        verified: false,
        evidence: "OBSERVED_FACT",
      };

      const res = validateAndPublishMissionV2(validExercise, {
        blueprint: validBlueprint,
        environment: mockSupportedEnv,
        trackedMissionArtifacts: [unverifiedArtifact],
        requiredPriorArtifacts: ["workspace/report.txt"],
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("CONTINUITY_INVALID");
        expect(res.reasons.some((r) => r.includes("not verified"))).toBe(true);
      }
    });

    it("X. same identifier but wrong explicit kind => FAIL", () => {
      const dirArtifact: MissionArtifact = {
        id: "art-dir",
        kind: "directory", // Wrong kind (expected "file")
        identifier: "workspace/report.txt",
        verified: true,
        evidence: "OBSERVED_FACT",
      };

      const res = validateAndPublishMissionV2(validExercise, {
        blueprint: validBlueprint,
        environment: mockSupportedEnv,
        trackedMissionArtifacts: [dirArtifact],
        requiredPriorArtifacts: [{ identifier: "workspace/report.txt", kind: "file" }],
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("CONTINUITY_INVALID");
        expect(res.reasons.some((r) => r.includes("incorrect kind"))).toBe(true);
      }
    });

    it("Y. compatible id/identifier + verified=true => PASS", () => {
      const structuredArtifact: MissionArtifact = {
        id: "unique-artifact-uuid-99",
        kind: "file",
        identifier: "workspace/evidence.dat",
        verified: true,
        evidence: "STRONG_INFERENCE",
      };

      const res = validateAndPublishMissionV2(validExercise, {
        blueprint: validBlueprint,
        environment: mockSupportedEnv,
        trackedMissionArtifacts: [structuredArtifact],
        requiredPriorArtifacts: [{ identifier: "workspace/evidence.dat", id: "unique-artifact-uuid-99", kind: "file" }],
      });

      expect(res.ok).toBe(true);
    });

    it("Z. no continuity dependency => PASS", () => {
      const res = validateAndPublishMissionV2(validExercise, {
        blueprint: validBlueprint,
        environment: mockSupportedEnv,
      });

      expect(res.ok).toBe(true);
    });
  });

  // ---------------------------------------------------------
  // 5. Determinism & Bounded Repair Tests
  // ---------------------------------------------------------
  describe("Determinism, Repair & Contract Preservation", () => {
    it("identical input produces identical deterministic validation outcome without timestamps or generated IDs", () => {
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

    it("bounded repair still works for safe structural formatting", () => {
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

    it("deterministic contract preserves prerequisites and previousReferences", () => {
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
  });
});
