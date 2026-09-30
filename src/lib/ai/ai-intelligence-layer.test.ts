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

    it("normalizes unrecognized stage to CONCEPT", () => {
      const result = validateTutorResponse({ text: "Hello", stage: "INVALID_STAGE" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.stage).toBe("CONCEPT");
      }
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

    it("normalizes invalid category to null and invalid understanding to unclear", () => {
      const raw = {
        intent: "Test",
        approach: "Test",
        category: "NOT_A_CATEGORY",
        conceptUnderstanding: "super_solid",
      };
      const result = validateDiagnosisResponse(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.category).toBe(null);
        expect(result.data.conceptUnderstanding).toBe("unclear");
      }
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

    it("normalizes unrecognized mode to GUIDED_PRACTICE and unrecognized skill to filesystem", () => {
      const raw = {
        recommendedMode: "UNKNOWN_MODE",
        primarySkill: "hacking",
        difficulty: 10,
      };
      const result = validateAdaptiveReasoningResponse(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.recommendedMode).toBe("GUIDED_PRACTICE");
        expect(result.data.primarySkill).toBe("filesystem");
        expect(result.data.difficulty).toBe(5); // clamped to 1-5
      }
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
