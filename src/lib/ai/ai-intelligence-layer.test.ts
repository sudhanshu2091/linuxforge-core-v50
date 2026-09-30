import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  validateTutorResponse,
  validateDiagnosisResponse,
  validateHintResponse,
  validateMissionGenerationResponse,
  validateAdaptiveReasoningResponse,
  type TutorRequest,
  type DiagnosisRequest,
  type HintRequest,
  type MissionGenerationRequest,
  type AdaptiveReasoningRequest,
} from "./ai-contracts";
import {
  aiTutorService,
  aiDiagnosisService,
  aiHintService,
  aiMissionGenerationService,
  aiAdaptiveReasoningService,
  deterministicTutorFallback,
  deterministicDiagnosisFallback,
  deterministicHintFallback,
  deterministicMissionGenerationFallback,
  deterministicAdaptiveReasoningFallback,
} from "./ai-service.server";
import {
  getAiTelemetryEvents,
  getLatestAiTelemetry,
  clearAiTelemetry,
} from "./ai-telemetry.server";
import type { AiProviderConfig } from "./provider-gateway.server";
import { validateAndPublishMissionV2 } from "./mission-generation-v2.server";

// Mock configuration pointing to a mock server
const testConfig: AiProviderConfig = {
  kind: "openai-compatible",
  baseUrl: "https://mock-ai.internal/v1",
  apiKey: "test-secret-key-12345678901234567890",
  model: "mock-model-v1",
  timeoutMs: 500,
  maxRetries: 1,
  temperature: 0.2,
};

describe("LinuxForge AI Intelligence Layer — Contracts & Schema Validation", () => {
  describe("validateTutorResponse", () => {
    it("accepts a valid tutor response", () => {
      const valid = {
        text: "Try using mkdir -p to create nested directories safely.",
        stage: "CONCEPT",
        coachingNotes: "Guided discovery",
        suggestedAction: "mkdir -p workspace/demo",
      };
      const result = validateTutorResponse(valid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.text).toBe(valid.text);
        expect(result.data.stage).toBe("CONCEPT");
      }
    });

    it("rejects non-object or empty text", () => {
      expect(validateTutorResponse(null).ok).toBe(false);
      expect(validateTutorResponse("string").ok).toBe(false);
      expect(validateTutorResponse({ text: "   " }).ok).toBe(false);
    });

    it("rejects unrecognized tutor hint stage", () => {
      const result = validateTutorResponse({ text: "Hello", stage: "INVALID_STAGE" });
      expect(result.ok).toBe(false);
    });
  });

  describe("validateDiagnosisResponse", () => {
    it("accepts a valid diagnosis response", () => {
      const valid = {
        intent: "Create target directory",
        approach: "Direct shell mkdir",
        category: "TYPO",
        conceptUnderstanding: "partial",
        skillDemonstrated: false,
        coaching: "Check the spelling of the command.",
        evidence: ["Command mkdr not found"],
      };
      const result = validateDiagnosisResponse(valid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.category).toBe("TYPO");
        expect(result.data.skillDemonstrated).toBe(false);
      }
    });

    it("rejects invalid category or invalid understanding", () => {
      const invalidCat = {
        intent: "Test",
        approach: "Test",
        category: "NOT_A_CATEGORY",
        conceptUnderstanding: "solid",
        skillDemonstrated: true,
        coaching: "Test coaching",
        evidence: [],
      };
      expect(validateDiagnosisResponse(invalidCat).ok).toBe(false);

      const invalidUnder = {
        intent: "Test",
        approach: "Test",
        category: "TYPO",
        conceptUnderstanding: "super_solid",
        skillDemonstrated: true,
        coaching: "Test coaching",
        evidence: [],
      };
      expect(validateDiagnosisResponse(invalidUnder).ok).toBe(false);
    });
  });

  describe("validateHintResponse", () => {
    it("validates a proper hint response", () => {
      const valid = {
        text: "Inspect the permissions on workspace with ls -ld.",
        stage: "DIRECTION",
        teachingNote: "Focus on permissions observation.",
      };
      const result = validateHintResponse(valid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stage).toBe("DIRECTION");
      }
    });

    it("rejects empty hint text", () => {
      expect(validateHintResponse({ text: "" }).ok).toBe(false);
    });
  });

  describe("validateMissionGenerationResponse", () => {
    it("validates an executable mission candidate with evaluationPlan", () => {
      const candidate = {
        exercise: {
          id: "mission-test-1",
          kind: "mission",
          title: "Filesystem Audit",
          scenario: "Perform a defensive filesystem audit",
          objective: "Create directory audit with target.txt",
          skills: ["filesystem"],
          difficulty: 2,
          evaluationPlan: {
            objectives: [
              {
                label: "audit directory exists",
                path: "audit",
                objectType: "directory",
              },
            ],
            requiredCommandKinds: ["mkdir"],
            minimumMutations: 1,
          },
        },
        pedagogicalRationale: "Reinforces directory hierarchy concepts.",
      };
      const result = validateMissionGenerationResponse(candidate);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.exercise.skills).toContain("filesystem");
        expect(result.data.exercise.difficulty).toBe(2);
      }
    });

    it("rejects mission missing title, objective, skills, or evaluationPlan", () => {
      expect(
        validateMissionGenerationResponse({
          exercise: { title: "", objective: "obj", skills: ["filesystem"] },
        }).ok,
      ).toBe(false);

      expect(
        validateMissionGenerationResponse({
          exercise: { title: "title", objective: "", skills: ["filesystem"] },
        }).ok,
      ).toBe(false);

      expect(
        validateMissionGenerationResponse({
          exercise: { title: "title", objective: "obj", skills: [] },
        }).ok,
      ).toBe(false);

      expect(
        validateMissionGenerationResponse({
          exercise: {
            title: "title",
            objective: "obj",
            skills: ["filesystem"],
            evaluationPlan: null,
          },
        }).ok,
      ).toBe(false);
    });
  });

  describe("validateAdaptiveReasoningResponse", () => {
    it("validates a proper adaptive reasoning recommendation", () => {
      const valid = {
        recommendedMode: "REMEDIATION",
        primarySkill: "permissions",
        supportingSkills: ["filesystem"],
        difficulty: 3,
        pedagogicalRationale: "Address fragile permissions mastery.",
        focusMistakes: ["UNSAFE_APPROACH"],
      };
      const result = validateAdaptiveReasoningResponse(valid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.recommendedMode).toBe("REMEDIATION");
        expect(result.data.primarySkill).toBe("permissions");
        expect(result.data.supportingSkills).toContain("filesystem");
      }
    });

    it("rejects unrecognized mode, unrecognized skill, or invalid difficulty", () => {
      const invalidMode = {
        recommendedMode: "UNKNOWN_MODE",
        primarySkill: "filesystem",
        supportingSkills: [],
        difficulty: 2,
        pedagogicalRationale: "Reason",
      };
      expect(validateAdaptiveReasoningResponse(invalidMode).ok).toBe(false);

      const invalidSkill = {
        recommendedMode: "GUIDED_PRACTICE",
        primarySkill: "hacking",
        supportingSkills: [],
        difficulty: 2,
        pedagogicalRationale: "Reason",
      };
      expect(validateAdaptiveReasoningResponse(invalidSkill).ok).toBe(false);

      const invalidDiff = {
        recommendedMode: "GUIDED_PRACTICE",
        primarySkill: "filesystem",
        supportingSkills: [],
        difficulty: 10,
        pedagogicalRationale: "Reason",
      };
      expect(validateAdaptiveReasoningResponse(invalidDiff).ok).toBe(false);
    });
  });
});

describe("LinuxForge AI Services — Offline Fallbacks & Graceful Resilience", () => {
  beforeEach(() => {
    clearAiTelemetry();
    vi.restoreAllMocks();
  });

  it("triggers deterministic fallback when AI is unconfigured (no API key)", async () => {
    const tutorReq: TutorRequest = {
      message: "How do I change permissions?",
      language: "English",
      depth: "explain",
    };

    const result = await aiTutorService(tutorReq, null);
    expect(result.fallbackUsed).toBe(true);
    expect(result.response.text).toContain("chmod");

    const telemetry = getLatestAiTelemetry("tutor");
    expect(telemetry).not.toBeNull();
    expect(telemetry?.fallbackUsed).toBe(true);
    expect(telemetry?.error).toContain("not configured");
  });

  it("triggers deterministic fallback and records telemetry when HTTP fails", async () => {
    // Mock global fetch to return 500 error
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Internal Server Error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );

    const tutorReq: TutorRequest = {
      message: "How do I make a directory?",
      language: "Hinglish",
      depth: "hint",
    };

    const result = await aiTutorService(tutorReq, testConfig);
    expect(result.fallbackUsed).toBe(true);
    expect(result.response.text).toContain("mkdir");

    const telemetry = getLatestAiTelemetry("tutor");
    expect(telemetry?.fallbackUsed).toBe(true);
    expect(telemetry?.success).toBe(false);
  });

  it("triggers fallback when provider returns malformed JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Sorry, I am unable to format as JSON: { broken" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const hintReq: HintRequest = {
      objective: "Set permissions to 750",
      requiredSkills: ["permissions"],
      level: 1,
      totalLevels: 3,
      stage: "CONCEPT",
      baseHint: "Think about user, group, other",
    };

    const result = await aiHintService(hintReq, testConfig);
    expect(result.fallbackUsed).toBe(true);
    expect(result.response.stage).toBe("CONCEPT");

    const telemetry = getLatestAiTelemetry("hint");
    expect(telemetry?.fallbackUsed).toBe(true);
    expect(telemetry?.schemaValid).toBe(false);
  });

  it("triggers fallback when provider returns schema-invalid JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  // Missing required text
                  stage: "CONCEPT",
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const tutorReq: TutorRequest = {
      message: "help",
      language: "English",
      depth: "explain",
    };

    const result = await aiTutorService(tutorReq, testConfig);
    expect(result.fallbackUsed).toBe(true);
    const telemetry = getLatestAiTelemetry("tutor");
    expect(telemetry?.schemaValid).toBe(false);
  });
});

describe("LinuxForge AI Security Invariants & Redaction", () => {
  beforeEach(() => {
    clearAiTelemetry();
    vi.restoreAllMocks();
  });

  it("redacts credentials from request before sending to AI provider", async () => {
    let capturedBody = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      capturedBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  text: "Redacted received safely",
                  stage: "CONCEPT",
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const tutorReq: TutorRequest = {
      message: "Here is my secret token: ghp_123456789012345678901234567890 and password=SuperSecretPassword123",
      language: "English",
      depth: "explain",
    };

    await aiTutorService(tutorReq, testConfig);

    // Verify token was redacted in HTTP payload
    expect(capturedBody).not.toContain("ghp_123456789012345678901234567890");
    expect(capturedBody).not.toContain("SuperSecretPassword123");
    expect(capturedBody).toContain("[redacted]");
  });

  it("hard guardrail: failed or blocked command execution CANNOT demonstrate skill", async () => {
    // Model erroneously returns skillDemonstrated: true for an errored command
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  intent: "Remove root files",
                  approach: "Unsafe",
                  category: "UNSAFE_APPROACH",
                  conceptUnderstanding: "solid",
                  skillDemonstrated: true, // Malicious or hallucinated claim
                  coaching: "Good job",
                  evidence: [],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const diagnosisReq: DiagnosisRequest = {
      contract: {
        id: "test-c1",
        title: "Test Contract",
        objective: "Configure files",
        requiredSkills: ["filesystem"],
      },
      rawCommand: "rm -rf /",
      execution: {
        exitCode: 1, // Non-zero exit code
        lines: [{ kind: "error", text: "Permission denied" }],
        mutationCount: 0,
        blockedReason: "Action outside sandbox safety policy",
      },
      verification: {
        status: "FAILED",
        score: 0,
        objectives: [],
      },
      history: ["rm -rf /"],
      hintsUsed: 0,
      language: "English",
    };

    const { response } = await aiDiagnosisService(diagnosisReq, testConfig);

    // Guardrail strictly forces skillDemonstrated to false and conceptUnderstanding away from solid
    expect(response.skillDemonstrated).toBe(false);
    expect(response.conceptUnderstanding).not.toBe("solid");
  });

  it("hard guardrail: tutor stage clamp prevents SOLUTION reveal during CONCEPT stage", async () => {
    // Model returns stage: SOLUTION when request asked for CONCEPT
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  text: "Run chmod 750 workspace immediately!",
                  stage: "SOLUTION",
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const tutorReq: TutorRequest = {
      message: "What is chmod?",
      language: "English",
      depth: "explain",
      context: {
        allowedStage: "CONCEPT",
      },
    };

    const { response } = await aiTutorService(tutorReq, testConfig);
    expect(response.stage).toBe("CONCEPT");
  });

  it("telemetry never leaks API keys or secrets", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ text: "Safe response", stage: "CONCEPT" }) } }],
          usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const tutorReq: TutorRequest = {
      message: "Hello",
      language: "English",
      depth: "explain",
    };

    await aiTutorService(tutorReq, testConfig);

    const events = getAiTelemetryEvents();
    expect(events.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(testConfig.apiKey);
  });
});

describe("LinuxForge AI Mission Generation & Deterministic V2 Validation Pipeline", () => {
  beforeEach(() => {
    clearAiTelemetry();
    vi.restoreAllMocks();
  });

  it("submits AI proposed exercise candidate through deterministic Mission V2 validation", async () => {
    const blueprint = {
      version: "v32" as const,
      archetype: "PROGRESSION" as const,
      primarySkill: "permissions" as const,
      supportingSkills: ["filesystem" as const],
      difficulty: 2,
      objectiveShape: "Audit permissions on workspace directory",
      storyContinuity: "Continuing system hardening",
      evidenceFocus: ["chmod execution", "directory permissions"],
      knowledgeIds: [],
      mistakeFocus: null,
      prerequisites: ["filesystem" as const],
      rationale: "Reinforce safe permissions assignment.",
    };

    const validCandidate = {
      exercise: {
        id: "adaptive-ai-permissions-2",
        kind: "mission" as const,
        title: "Adaptive Permissions Drill",
        scenario: "Secure the workspace",
        objective: "Set directory permissions on workspace to 750",
        skills: ["permissions", "filesystem"] as const,
        difficulty: 2,
        estimatedMinutes: 10,
        sourceRefs: [{ id: "kali-training", name: "Kali Training", url: "https://kali.training/" }],
        evaluationFocus: ["directory permissions"],
        learnerReason: "Practice permissions",
        allowedApproaches: ["chmod 750 workspace"],
        bannedShortcuts: ["chmod 777"],
        hints: ["Use chmod 750"],
        successStory: "Workspace secured",
        failureStory: "Permissions not set",
        remediation: ["Review chmod"],
        evaluationPlan: {
          objectives: [
            {
              label: "workspace directory has 750 permissions",
              path: "workspace",
              objectType: "directory" as const,
              permissions: "750",
            },
          ],
          requiredCommandKinds: ["chmod"],
          minimumMutations: 1,
        },
      },
      pedagogicalRationale: "Practice permissions",
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(validCandidate) } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const { response, fallbackUsed } = await aiMissionGenerationService(
      {
        trainingDecision: {
          version: "v37",
          mode: "GUIDED_PRACTICE",
          primarySkill: "permissions",
          supportingSkills: ["filesystem"],
          difficulty: 2,
          constraints: [],
          sourceStrategy: "targeted-patterns",
          masteryGate: "PRACTICE",
          journeyPhase: "ACTIVE_TRAINING",
          journeyNextSkills: [],
          focusMistakes: [],
          evidence: [],
          reason: "Practice",
        },
        blueprint,
        skills: [
          {
            skillId: "permissions",
            mastery: 50,
            attempts: 1,
            successfulAttempts: 1,
            recentScore: 70,
            recentMistakes: [],
            hintDependency: 0,
            confidence: 50,
            lastPracticed: new Date().toISOString(),
            nextReview: new Date().toISOString(),
          },
        ],
        difficulty: 2,
      },
      testConfig,
    );

    expect(fallbackUsed).toBe(false);
    expect(response.exercise.title).toBe("Adaptive Permissions Drill");

    // Pass the AI exercise to deterministic Mission V2 validation
    const v2Validation = validateAndPublishMissionV2(response.exercise, { blueprint });
    expect(v2Validation.ok).toBe(true);
    if (v2Validation.ok && v2Validation.contract) {
      expect(v2Validation.contract).toBeDefined();
      expect(v2Validation.contract.id).toBe("adaptive-ai-permissions-2");
      expect(v2Validation.contract.requiredSkills).toContain("permissions");
    }
  });

  it("deterministic fallbacks produce valid and complete structures for all 5 services", () => {
    // 1. Tutor
    const tutorFallback = deterministicTutorFallback({
      message: "chmod 600",
      language: "English",
      depth: "explain",
    });
    expect(tutorFallback.text).toContain("chmod");
    expect(tutorFallback.stage).toBe("CONCEPT");

    // 2. Diagnosis
    const diagFallback = deterministicDiagnosisFallback({
      contract: {
        id: "c1",
        title: "T",
        objective: "Obj",
        requiredSkills: ["filesystem"],
      },
      rawCommand: "mkdir test",
      execution: {
        exitCode: 0,
        lines: [],
        mutationCount: 1,
      },
      verification: {
        status: "COMPLETE",
        score: 100,
        objectives: [{ label: "test exists", met: true }],
      },
      history: ["mkdir test"],
      hintsUsed: 0,
      language: "English",
    });
    expect(diagFallback.skillDemonstrated).toBe(true);

    // 3. Hint
    const hintFallback = deterministicHintFallback({
      objective: "Create directory test",
      requiredSkills: ["filesystem"],
      level: 1,
      totalLevels: 3,
      stage: "CONCEPT",
      baseHint: "Use mkdir",
    });
    expect(hintFallback.text).toBeDefined();
    expect(hintFallback.stage).toBe("CONCEPT");

    // 4. Mission generation
    const missionFallback = deterministicMissionGenerationFallback({
      trainingDecision: {
        version: "v37",
        mode: "GUIDED_PRACTICE",
        primarySkill: "filesystem",
        supportingSkills: [],
        difficulty: 1,
        constraints: [],
        sourceStrategy: "targeted-patterns",
        masteryGate: "PRACTICE",
        journeyPhase: "ACTIVE_TRAINING",
        journeyNextSkills: [],
        focusMistakes: [],
        evidence: [],
        reason: "r",
      },
      blueprint: {
        version: "v32",
        archetype: "PROGRESSION",
        primarySkill: "filesystem",
        supportingSkills: [],
        difficulty: 1,
        objectiveShape: "Build directory",
        storyContinuity: "Initial drill",
        evidenceFocus: ["mkdir"],
        knowledgeIds: [],
        mistakeFocus: null,
        prerequisites: [],
        rationale: "test rationale",
      },
      skills: [],
      difficulty: 1,
    });
    expect(missionFallback.exercise.id).toContain("adaptive-filesystem");
    expect(missionFallback.exercise.evaluationPlan).toBeDefined();

    // 5. Adaptive reasoning
    const reasoningFallback = deterministicAdaptiveReasoningFallback({
      skills: [],
      recentMistakes: [],
      currentDifficulty: 1,
    });
    expect(reasoningFallback.recommendedMode).toBeDefined();
    expect(reasoningFallback.primarySkill).toBeDefined();
  });
});

describe("Integration & Architectural Boundary Invariants", () => {
    beforeEach(() => {
      clearAiTelemetry();
      vi.restoreAllMocks();
    });

    it("B. diagnosis guardrail rejects skill demonstration across all failure types (exit code, blocked, verification fail, zero mutation)", async () => {
      // Mock provider falsely claiming skill demonstrated
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    intent: "Setup files",
                    approach: "Commands",
                    category: "TYPO",
                    conceptUnderstanding: "solid",
                    skillDemonstrated: true,
                    coaching: "Good try",
                    evidence: ["evidence"],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      // Case 1: Non-zero exit code
      const diagExitCode = await aiDiagnosisService(
        {
          contract: { id: "c1", title: "T", objective: "Obj", requiredSkills: ["filesystem"] },
          rawCommand: "mkdir /root/secret",
          execution: { exitCode: 1, lines: [{ kind: "error", text: "Permission denied" }], mutationCount: 0 },
          verification: { status: "INCOMPLETE", score: 0, objectives: [] },
          history: [],
          hintsUsed: 0,
          language: "English",
        },
        testConfig,
      );
      expect(diagExitCode.response.skillDemonstrated).toBe(false);

      // Case 2: Blocked by safety policy
      const diagBlocked = await aiDiagnosisService(
        {
          contract: { id: "c1", title: "T", objective: "Obj", requiredSkills: ["filesystem"] },
          rawCommand: "rm -rf /",
          execution: { exitCode: 1, lines: [], mutationCount: 0, blockedReason: "Blocked by lab safety policy" },
          verification: { status: "BLOCKED_BY_SAFETY_POLICY", score: 0, objectives: [] },
          history: [],
          hintsUsed: 0,
          language: "English",
        },
        testConfig,
      );
      expect(diagBlocked.response.skillDemonstrated).toBe(false);
      expect(diagBlocked.response.category).toBe("UNSAFE_APPROACH");

      // Case 3: Verification failure (RESULT_CORRECT_SKILL_NOT_DEMONSTRATED)
      const diagVerifyFail = await aiDiagnosisService(
        {
          contract: { id: "c1", title: "T", objective: "Obj", requiredSkills: ["iteration"] },
          rawCommand: "touch a b c",
          execution: { exitCode: 0, lines: [], mutationCount: 3 },
          verification: { status: "RESULT_CORRECT_SKILL_NOT_DEMONSTRATED", score: 0, objectives: [] },
          history: [],
          hintsUsed: 0,
          language: "English",
        },
        testConfig,
      );
      expect(diagVerifyFail.response.skillDemonstrated).toBe(false);

      // Case 4: Zero mutation with score 0
      const diagZeroMutation = await aiDiagnosisService(
        {
          contract: { id: "c1", title: "T", objective: "Obj", requiredSkills: ["filesystem"] },
          rawCommand: "ls -la",
          execution: { exitCode: 0, lines: [], mutationCount: 0 },
          verification: { status: "INCOMPLETE", score: 0, objectives: [] },
          history: [],
          hintsUsed: 0,
          language: "English",
        },
        testConfig,
      );
      expect(diagZeroMutation.response.skillDemonstrated).toBe(false);
    });

    it("C. hint service clamps premature stage to requested level", async () => {
      // Model attempts to return SOLUTION when stage is CONCEPT
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    text: "Run chmod 750 workspace",
                    stage: "SOLUTION",
                    teachingNote: "Direct answer",
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      const hintReq: HintRequest = {
        objective: "Configure directory permissions",
        requiredSkills: ["permissions"],
        level: 1,
        totalLevels: 4,
        stage: "CONCEPT",
        baseHint: "Consider numeric octals",
      };

      const { response } = await aiHintService(hintReq, testConfig);
      expect(response.stage).toBe("CONCEPT");
    });

    it("E. adaptive reasoning integrates with TrainingDecision requirements", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    recommendedMode: "REMEDIATION",
                    primarySkill: "permissions",
                    supportingSkills: ["filesystem"],
                    difficulty: 2,
                    pedagogicalRationale: "Address recurring permission misconfiguration",
                    focusMistakes: ["UNSAFE_APPROACH"],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      const reasoningReq: AdaptiveReasoningRequest = {
        skills: [
          {
            skillId: "permissions",
            mastery: 30,
            attempts: 4,
            successfulAttempts: 1,
            recentScore: 40,
            recentMistakes: ["UNSAFE_APPROACH"],
            hintDependency: 40,
            confidence: 30,
            lastPracticed: null,
            nextReview: null,
          },
        ],
        recentMistakes: ["UNSAFE_APPROACH"],
        currentDifficulty: 2,
      };

      const { response, fallbackUsed } = await aiAdaptiveReasoningService(reasoningReq, testConfig);
      expect(fallbackUsed).toBe(false);
      expect(response.recommendedMode).toBe("REMEDIATION");
      expect(response.primarySkill).toBe("permissions");
      expect(response.supportingSkills).toContain("filesystem");
      expect(response.difficulty).toBe(2);
    });

    it("I. AI responses cannot manufacture authoritative grades, XP, mastery, or verification verdicts", () => {
      // Regardless of what AI emits, AI contracts only return advisory responses
      const tutorResult = validateTutorResponse({
        text: "Tutor text",
        stage: "CONCEPT",
        grade: 100, // Forbidden attempt to inject grade
        xp: 500, // Forbidden attempt to award XP
        status: "COMPLETE", // Forbidden attempt to decide verification
      });
      expect(tutorResult.ok).toBe(true);
      if (tutorResult.ok) {
        expect((tutorResult.data as any).grade).toBeUndefined();
        expect((tutorResult.data as any).xp).toBeUndefined();
        expect((tutorResult.data as any).status).toBeUndefined();
      }

      const diagnosisResult = validateDiagnosisResponse({
        intent: "Test intent",
        approach: "Test approach",
        category: "TYPO",
        conceptUnderstanding: "partial",
        skillDemonstrated: false,
        coaching: "Try again",
        evidence: ["error"],
        xpEarned: 100,
        grade: 100,
      });
      expect(diagnosisResult.ok).toBe(true);
      if (diagnosisResult.ok) {
        expect((diagnosisResult.data as any).xpEarned).toBeUndefined();
        expect((diagnosisResult.data as any).grade).toBeUndefined();
      }
    });

    it("J. repeated validation of the same mission candidate produces identical deterministic mission ID", () => {
      const candidateWithoutId = {
        exercise: {
          title: "Hardening SSH Configuration",
          objective: "Ensure sshd_config has PermitRootLogin no",
          skills: ["hardening"],
          difficulty: 3,
          evaluationPlan: {
            objectives: [
              {
                label: "PermitRootLogin is disabled",
                path: "etc/ssh/sshd_config",
                objectType: "file",
              },
            ],
            requiredCommandKinds: ["chmod"],
            minimumMutations: 1,
          },
        },
        pedagogicalRationale: "Security hardening drill",
      };

      const result1 = validateMissionGenerationResponse(candidateWithoutId);
      const result2 = validateMissionGenerationResponse(candidateWithoutId);

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      if (result1.ok && result2.ok) {
        expect(result1.data.exercise.id).toBe(result2.data.exercise.id);
        expect(result1.data.exercise.id).toContain("adaptive-hardening-3");
      }
    });
  });
