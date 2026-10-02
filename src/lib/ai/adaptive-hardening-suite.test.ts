import { describe, expect, it } from "vitest";
import {
  validateTutorResponse,
  validateDiagnosisResponse,
  validateHintResponse,
  validateMissionGenerationResponse,
} from "./ai-contracts";
import {
  buildAdaptiveMissionCandidate,
  createDeterministicCandidate,
} from "./adaptive-mission-bridge";
import { buildMissionBlueprint } from "./mission-generator";
import { validateAndPublishMissionV2 } from "./mission-generation-v2.server";
import { evaluateConceptReadiness } from "./concept-readiness";
import type { AdaptiveExercise, SkillMemoryView } from "@/lib/forge/types";
import type { CanonicalEnvironmentModel } from "@/lib/forge/environment/types";

describe("Adaptive Mission & AI Hardening Test Suite", () => {
  const mockSkills: SkillMemoryView[] = [
    {
      skillId: "filesystem",
      mastery: 85,
      attempts: 5,
      successfulAttempts: 5,
      recentScore: 85,
      recentMistakes: [],
      confidence: 85,
      hintDependency: 0,
      lastPracticed: new Date().toISOString(),
      nextReview: null,
    },
    {
      skillId: "permissions",
      mastery: 40,
      attempts: 3,
      successfulAttempts: 1,
      recentScore: 40,
      recentMistakes: [],
      confidence: 50,
      hintDependency: 10,
      lastPracticed: new Date().toISOString(),
      nextReview: null,
    },
    {
      skillId: "processes",
      mastery: 10,
      attempts: 1,
      successfulAttempts: 0,
      recentScore: 10,
      recentMistakes: [],
      confidence: 30,
      hintDependency: 20,
      lastPracticed: new Date().toISOString(),
      nextReview: null,
    },
    {
      skillId: "networking",
      mastery: 0,
      attempts: 0,
      successfulAttempts: 0,
      recentScore: 0,
      recentMistakes: [],
      confidence: 20,
      hintDependency: 0,
      lastPracticed: null,
      nextReview: null,
    },
  ];

  const baseEnvironment: CanonicalEnvironmentModel = {
    identity: {
      environmentId: "env-test-01",
      labId: "lab-test-01",
      userId: "user-test-01",
      provider: "mock-modelled-v1",
      runtimeClass: "container-dev",
      guestName: "Kali Linux",
      distribution: "Kali Linux",
      guestVersion: "2026.2",
      expectedArtifactRelease: "2026.2",
      guestVersionMatchesArtifact: true,
      architecture: "x86_64",
      kernel: "Linux 6.12",
      hostname: "kali-forge",
      shell: "/bin/bash",
      currentUser: "linuxforge",
      privilegeState: "sudo_capable",
      evidence: "OBSERVED_FACT",
    },
    users: [],
    groups: [],
    filesystem: [
      {
        path: "workspace",
        objectType: "directory",
        permissions: "755",
        owner: "linuxforge",
        group: "linuxforge",
        sizeBytes: 4096,
        exists: true,
        content: null,
        contentTruncated: false,
        evidence: "OBSERVED_FACT",
      },
    ],
    processes: [],
    services: [],
    packages: [],
    environment: { variables: {}, redactedKeys: [], evidence: "UNKNOWN" },
    network: {
      supported: true,
      networkIsolationEnforced: true,
      listeners: [],
      evidence: "OBSERVED_FACT",
    },
    system: {
      os: "Linux",
      distribution: "Kali",
      version: "2026.2",
      kernel: "6.12",
      architecture: "x86_64",
      hostname: "kali-forge",
      evidence: "OBSERVED_FACT",
    },
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
        snapshots: false,
        pauseResume: false,
        packages: false,
      },
      security: {
        guestRootAllowed: true,
        hostFilesystemBlocked: true,
        privilegeEscalationBlocked: false,
        metadataAccessBlocked: true,
        networkIsolationEnforced: true,
      },
      lifecycleState: "RUNNING",
      evidence: "OBSERVED_FACT",
    },
    artifacts: [],
    capturedAt: new Date().toISOString(),
  };

  /* ------------------------------------------------------------------ */
  /* 1. AI Validation: Safe Normalization vs Rejection                  */
  /* ------------------------------------------------------------------ */

  describe("1. AI Validation Semantics", () => {
    it("A. harmless malformed AI presentation fields are safely normalized", () => {
      // Tutor response: missing/unknown stage safely normalizes to lowest stage 'CONCEPT'
      const tutorRaw = {
        text: "You can inspect directory permissions using ls -ld.",
        stage: "UNKNOWN_ULTRA_STAGE",
        coachingNotes: 12345, // malformed non-string
        suggestedAction: null,
      };
      const tutorResult = validateTutorResponse(tutorRaw);
      expect(tutorResult.ok).toBe(true);
      if (tutorResult.ok) {
        expect(tutorResult.data.stage).toBe("CONCEPT");
        expect(tutorResult.data.text).toBe("You can inspect directory permissions using ls -ld.");
        expect(tutorResult.data.coachingNotes).toBeUndefined();
      }

      // Diagnosis response: malformed category safely normalizes to null, missing coaching gets safe fallback
      const diagRaw = {
        category: "SOMETHING_MADE_UP",
        conceptUnderstanding: "weird_value",
        coaching: "   ",
      };
      const diagResult = validateDiagnosisResponse(diagRaw);
      expect(diagResult.ok).toBe(true);
      if (diagResult.ok) {
        expect(diagResult.data.category).toBeNull();
        expect(diagResult.data.conceptUnderstanding).toBe("unclear");
        expect(diagResult.data.coaching).toBe("Review the mission objective and try again.");
      }

      // Hint response: invalid stage normalizes to CONCEPT
      const hintRaw = {
        text: "Check permissions mode with stat or ls -l.",
        stage: "INVALID_STAGE",
      };
      const hintResult = validateHintResponse(hintRaw);
      expect(hintResult.ok).toBe(true);
      if (hintResult.ok) {
        expect(hintResult.data.stage).toBe("CONCEPT");
      }
    });

    it("B. unsafe executable fields are strictly rejected", () => {
      // Unsafe path traversal in mission evaluation plan
      const badPathMission = {
        title: "Defensive File Audit Mission",
        objective: "Read shadow passwords file",
        skills: ["filesystem"],
        difficulty: 2,
        evaluationPlan: {
          objectives: [
            {
              label: "Audit shadow file",
              path: "../../etc/shadow", // Unsafe path traversal
              objectType: "file",
            },
          ],
          requiredCommandKinds: ["cat"],
        },
      };
      const badPathResult = validateMissionGenerationResponse(badPathMission);
      expect(badPathResult.ok).toBe(false);
      if (!badPathResult.ok) {
        expect(badPathResult.error).toContain("Unsafe filesystem path");
      }

      // Invalid permissions format
      const badPermsMission = {
        title: "Set Workspace Permissions",
        objective: "Configure workspace mode to 7777",
        skills: ["permissions"],
        difficulty: 2,
        evaluationPlan: {
          objectives: [
            {
              label: "Workspace directory",
              path: "workspace",
              objectType: "directory",
              permissions: "7777", // Invalid octal format (requires 3 octal digits)
            },
          ],
          requiredCommandKinds: ["chmod"],
        },
      };
      const badPermsResult = validateMissionGenerationResponse(badPermsMission);
      expect(badPermsResult.ok).toBe(false);
      if (!badPermsResult.ok) {
        expect(badPermsResult.error).toContain("Permissions must be exactly three octal digits");
      }

      // Invalid difficulty (out of bounds)
      const badDiffMission = {
        title: "Extreme Shell Mission",
        objective: "Run complex scripts",
        skills: ["shell-scripting"],
        difficulty: 99, // Out of bounds
        evaluationPlan: {
          objectives: [
            {
              label: "Script exists",
              path: "workspace/run.sh",
              objectType: "file",
            },
          ],
          requiredCommandKinds: ["bash"],
        },
      };
      const badDiffResult = validateMissionGenerationResponse(badDiffMission);
      expect(badDiffResult.ok).toBe(false);
      if (!badDiffResult.ok) {
        expect(badDiffResult.error).toContain("difficulty must be an integer between 1 and 5");
      }

      // Unsupported / arbitrary capability injection
      const badCapMission = {
        title: "Privilege Escalation Drill",
        objective: "Access root hypervisor directly",
        skills: ["hardening"],
        difficulty: 3,
        evaluationPlan: {
          objectives: [
            {
              label: "Root access",
              path: "workspace/root.flag",
              objectType: "file",
            },
          ],
          requiredCapabilities: ["hypervisor_escape", "arbitrary_kernel_access"],
        },
      };
      const badCapResult = validateMissionGenerationResponse(badCapMission);
      expect(badCapResult.ok).toBe(false);
      if (!badCapResult.ok) {
        expect(badCapResult.error).toContain("Unknown or unsupported capability");
      }
    });

    it("C. deterministic fallback remains authoritative when proposal is invalid", () => {
      const blueprint = buildMissionBlueprint({
        skills: mockSkills,
      });

      const invalidAiProposal: AdaptiveExercise = {
        id: "ai-bad-proposal",
        kind: "mission",
        title: "Bad Proposal",
        scenario: "Invalid scenario with unsafe path",
        objective: "Inspect host shadow file",
        skills: ["permissions"],
        difficulty: 2,
        estimatedMinutes: 10,
        sourceRefs: [{ id: "kali-training", name: "Kali Training", url: "https://kali.training/" }],
        evaluationFocus: ["Permissions"],
        learnerReason: "Testing fallback",
        allowedApproaches: ["cat /etc/shadow"],
        bannedShortcuts: [],
        hints: ["Inspect file"],
        successStory: "Done",
        failureStory: "Not done",
        remediation: [],
        evaluationPlan: {
          objectives: [
            {
              label: "Unsafe shadow path",
              path: "/etc/shadow", // Unsafe absolute path
              objectType: "file",
            },
          ],
          requiredCommandKinds: ["cat"],
        },
      };

      // V2 validation directly rejects the unsafe proposal
      const v2Result = validateAndPublishMissionV2(invalidAiProposal, { blueprint });
      expect(v2Result.ok).toBe(false);

      // The deterministic candidate generator produces a safe, valid mission
      const candidateResult = buildAdaptiveMissionCandidate({
        skills: mockSkills,
      });
      expect(candidateResult.validation.ok).toBe(true);
      expect(candidateResult.contract).toBeDefined();
      expect(typeof candidateResult.contract?.verify).toBe("function");
    });
  });

  /* ------------------------------------------------------------------ */
  /* 2. Real Environment Model & Capability Validation                  */
  /* ------------------------------------------------------------------ */

  describe("2. Real Environment Model & Capability Validation", () => {
    it("rejects an exercise requiring an unsupported capability in the current environment", () => {
      const snapshotExercise: AdaptiveExercise = {
        id: "snapshot-mission",
        kind: "mission",
        title: "Lab State Snapshot Mission",
        scenario: "Create a persistent state snapshot of the training lab in the isolated sandbox.",
        objective: "Take and verify a machine snapshot before state mutation.",
        skills: ["filesystem"],
        difficulty: 2,
        estimatedMinutes: 15,
        sourceRefs: [{ id: "kali-training", name: "Kali Training", url: "https://kali.training/" }],
        evaluationFocus: ["Snapshots"],
        learnerReason: "Demonstrate snapshot capture",
        allowedApproaches: ["Use snapshot command"],
        bannedShortcuts: [],
        hints: ["Snapshot"],
        successStory: "Snapshot captured",
        failureStory: "No snapshot",
        remediation: [],
        evaluationPlan: {
          objectives: [
            {
              label: "Snapshot state captured",
              path: "workspace/snap.state",
              objectType: "file",
            },
          ],
          requiredCapabilities: ["snapshots"], // Not supported in baseEnvironment!
        },
      };

      const result = validateAndPublishMissionV2(snapshotExercise, {
        environment: baseEnvironment,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("ENVIRONMENT_UNSUPPORTED");
        expect(result.reasons.some((r) => r.includes("snapshots"))).toBe(true);
      }
    });

    it("accepts an exercise requiring a supported capability in the current environment", () => {
      const processExercise: AdaptiveExercise = {
        id: "process-audit-mission",
        kind: "mission",
        title: "Process Table Inspection Drill",
        scenario: "The incident response team requires an active process table audit in workspace.",
        objective: "Inspect running processes with ps in the isolated environment.",
        skills: ["processes"],
        difficulty: 2,
        estimatedMinutes: 10,
        sourceRefs: [{ id: "kali-training", name: "Kali Training", url: "https://kali.training/" }],
        evaluationFocus: ["Process table inspection"],
        learnerReason: "Demonstrate process monitoring skills",
        allowedApproaches: ["ps aux"],
        bannedShortcuts: [],
        hints: ["Use ps aux"],
        successStory: "Processes audited",
        failureStory: "Processes not inspected",
        remediation: [],
        evaluationPlan: {
          objectives: [
            {
              label: "Inspect process table",
              path: "processes",
              objectType: "process",
            },
          ],
          requiredCapabilities: ["processes"], // Supported in baseEnvironment!
          requiredCommandKinds: ["ps"],
          minimumMutations: 0,
        },
      };

      const result = validateAndPublishMissionV2(processExercise, {
        environment: baseEnvironment,
        supportedCommandKinds: ["ps", "mkdir", "touch"],
      });

      expect(result.ok).toBe(true);
    });

    it("rejects network-required external activity in a network-isolated environment", () => {
      const externalNetExercise: AdaptiveExercise = {
        id: "external-net-mission",
        kind: "mission",
        title: "External Network Recon Drill",
        scenario: "Perform external network probing to remote servers in training lab.",
        objective: "Connect to external network hosts and download definitions.",
        skills: ["networking"],
        difficulty: 2,
        estimatedMinutes: 10,
        sourceRefs: [{ id: "kali-training", name: "Kali Training", url: "https://kali.training/" }],
        evaluationFocus: ["External network ping"],
        learnerReason: "Testing external connectivity",
        allowedApproaches: ["ping external.example.com"],
        bannedShortcuts: [],
        hints: ["Use ping"],
        successStory: "External ping verified",
        failureStory: "Failed to connect",
        remediation: [],
        evaluationPlan: {
          objectives: [
            {
              label: "Network check",
              path: "network",
              objectType: "network",
            },
          ],
          requiredCapabilities: ["network"],
        },
      };

      const result = validateAndPublishMissionV2(externalNetExercise, {
        environment: baseEnvironment, // enforces networkIsolationEnforced: true
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("ENVIRONMENT_UNSUPPORTED");
        expect(result.reasons.some((r) => r.includes("network isolation"))).toBe(true);
      }
    });

    it("rejects an exercise requiring unsupported command kinds", () => {
      const cmdExercise: AdaptiveExercise = {
        id: "ps-cmd-drill",
        kind: "mission",
        title: "Process Inspection Command Drill",
        scenario: "Inspect process list in the isolated training lab safely.",
        objective: "Run process inspection using ps in the workspace.",
        skills: ["processes"],
        difficulty: 2,
        estimatedMinutes: 10,
        sourceRefs: [{ id: "kali-training", name: "Kali Training", url: "https://kali.training/" }],
        evaluationFocus: ["Process inspection"],
        learnerReason: "Demonstrate ps command usage",
        allowedApproaches: ["ps aux"],
        bannedShortcuts: [],
        hints: ["ps aux"],
        successStory: "Processes inspected",
        failureStory: "No process inspection",
        remediation: [],
        evaluationPlan: {
          objectives: [
            {
              label: "Inspect processes",
              path: "processes",
              objectType: "process",
            },
          ],
          requiredCommandKinds: ["ps"], // In EXECUTABLE_COMMANDS, but not in supportedCommandKinds!
        },
      };

      const result = validateAndPublishMissionV2(cmdExercise, {
        environment: baseEnvironment,
        supportedCommandKinds: ["mkdir", "touch", "ls"], // ps is absent
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("ENVIRONMENT_UNSUPPORTED");
        expect(result.reasons.some((r) => r.includes("Command 'ps'"))).toBe(true);
      }
    });

    it("preserves safe behavior when environment is genuinely unavailable", () => {
      // Environment is undefined
      const result = buildAdaptiveMissionCandidate({
        skills: mockSkills,
        environment: undefined,
      });

      expect(result.validation.ok).toBe(true);
      expect(result.contract).toBeDefined();
    });
  });

  /* ------------------------------------------------------------------ */
  /* 3. Real Process and Network Skill Mission Semantics                */
  /* ------------------------------------------------------------------ */

  describe("3. Real Process and Network Mission Semantics", () => {
    it("generates genuine process inspection mission and verifies real process evidence", () => {
      const candidateResult = buildAdaptiveMissionCandidate({
        skills: mockSkills.map((s) => (s.skillId === "processes" ? { ...s, mastery: 10 } : s)),
        trainingDecision: {
          version: "v37",
          mode: "REMEDIATION",
          primarySkill: "processes",
          supportingSkills: [],
          difficulty: 1,
          reason: "Practice process table inspection",
          evidence: ["Process concepts not demonstrated"],
          focusMistakes: [],
          constraints: [],
        },
        environment: baseEnvironment,
        supportedCommandKinds: ["ps", "mkdir", "touch"],
      });

      // Verify that candidate is NOT a dummy proc.txt file shortcut!
      expect(candidateResult.exercise?.evaluationPlan?.objectives?.[0]?.path).toBe("processes");
      expect(candidateResult.exercise?.evaluationPlan?.objectives?.[0]?.objectType).toBe("process");
      expect(candidateResult.exercise?.evaluationPlan?.requiredCommandKinds).toContain("ps");
      expect(candidateResult.exercise?.evaluationPlan?.requiredCapabilities).toContain("processes");
      expect(candidateResult.exercise?.evaluationPlan?.minimumMutations).toBe(0);

      expect(candidateResult.validation.ok).toBe(true);
      expect(candidateResult.contract).toBeDefined();
      if (candidateResult.contract) {
        const contract = candidateResult.contract;

        // Evidence WITH a process command: passes verification!
        const successEvidence = {
          commands: ["ps aux", "echo done"],
          usedLoop: false,
          operations: 0,
          invocations: 1,
        };
        const passOutcome = contract.verify(new Map(), successEvidence);
        expect(passOutcome.objectives[0]?.met).toBe(true);
        expect(passOutcome.skillDemonstrated).toBe(true);

        // Evidence WITHOUT a process command: fails verification!
        const failEvidence = {
          commands: ["ls -la", "echo done"],
          usedLoop: false,
          operations: 0,
          invocations: 1,
        };
        const failOutcome = contract.verify(new Map(), failEvidence);
        expect(failOutcome.objectives[0]?.met).toBe(false);
        expect(failOutcome.skillDemonstrated).toBe(false);
      }
    });

    it("generates genuine network inspection mission and verifies real network evidence", () => {
      const candidateResult = buildAdaptiveMissionCandidate({
        skills: mockSkills,
        trainingDecision: {
          version: "v37",
          mode: "GUIDED_PRACTICE",
          primarySkill: "networking",
          supportingSkills: [],
          difficulty: 2,
          reason: "Inspect local interfaces",
          evidence: [],
          focusMistakes: [],
          constraints: [],
        },
        environment: baseEnvironment,
        supportedCommandKinds: ["ip", "ss", "ls"],
      });

      // Verify that candidate is NOT a dummy net.txt file shortcut!
      expect(candidateResult.exercise?.evaluationPlan?.objectives?.[0]?.path).toBe("network");
      expect(candidateResult.exercise?.evaluationPlan?.objectives?.[0]?.objectType).toBe("network");
      expect(candidateResult.exercise?.evaluationPlan?.requiredCommandKinds).toContain("ip");
      expect(candidateResult.exercise?.evaluationPlan?.requiredCapabilities).toContain("network");

      expect(candidateResult.validation.ok).toBe(true);
      expect(candidateResult.contract).toBeDefined();
      if (candidateResult.contract) {
        const contract = candidateResult.contract;

        // Evidence WITH an ip command: passes verification!
        const passOutcome = contract.verify(new Map(), {
          commands: ["ip addr", "ss -tuln"],
          usedLoop: false,
          operations: 0,
          invocations: 1,
        });
        expect(passOutcome.objectives[0]?.met).toBe(true);
        expect(passOutcome.skillDemonstrated).toBe(true);

        // Evidence WITHOUT a network command: fails verification!
        const failOutcome = contract.verify(new Map(), {
          commands: ["whoami"],
          usedLoop: false,
          operations: 0,
          invocations: 1,
        });
        expect(failOutcome.objectives[0]?.met).toBe(false);
        expect(failOutcome.skillDemonstrated).toBe(false);
      }
    });
  });

  /* ------------------------------------------------------------------ */
  /* 4. Concept Readiness & Setup Planning                              */
  /* ------------------------------------------------------------------ */

  describe("4. Concept Readiness & Setup Planning", () => {
    it("returns SETUP_REQUIRED when target concept has unmet skill prerequisites", () => {
      // Learner with 0 mastery on filesystem attempting permissions
      const noviceSkills: SkillMemoryView[] = [
        {
          skillId: "filesystem",
          mastery: 0,
          attempts: 0,
          successfulAttempts: 0,
          recentScore: 0,
          recentMistakes: [],
          confidence: 20,
          hintDependency: 0,
          lastPracticed: null,
          nextReview: null,
        },
      ];

      const readiness = evaluateConceptReadiness({
        targetSkill: "permissions", // Requires filesystem!
        skills: noviceSkills,
        environment: baseEnvironment,
      });

      expect(readiness.ready).toBe(false);
      expect(readiness.status).toBe("SETUP_REQUIRED");
      expect(readiness.missingPrerequisites).toContain("filesystem");
      expect(readiness.setupPlan).toBeDefined();
    });

    it("returns UNSUPPORTED_CAPABILITY when environment cannot execute required actions", () => {
      const restrictedEnv: CanonicalEnvironmentModel = {
        ...baseEnvironment,
        runtime: {
          ...baseEnvironment.runtime!,
          capabilities: {
            ...baseEnvironment.runtime!.capabilities,
            processes: false, // Explicitly disabled
          },
        },
      };

      const readiness = evaluateConceptReadiness({
        targetSkill: "processes",
        skills: mockSkills,
        environment: restrictedEnv,
      });

      expect(readiness.ready).toBe(false);
      expect(readiness.status).toBe("UNSUPPORTED_CAPABILITY");
      expect(readiness.missingCapabilities).toContain("processes");
    });

    it("returns READY when all prerequisites and capabilities are satisfied", () => {
      const readiness = evaluateConceptReadiness({
        targetSkill: "permissions",
        skills: mockSkills, // filesystem mastery is 85!
        environment: baseEnvironment,
      });

      expect(readiness.ready).toBe(true);
      expect(readiness.status).toBe("READY");
      expect(readiness.missingPrerequisites).toEqual([]);
      expect(readiness.missingCapabilities).toEqual([]);
    });
  });
});
