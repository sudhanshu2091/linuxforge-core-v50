import type { ObserverInput } from "@/lib/forge/observer.server";
import { readProviderConfig } from "./provider-gateway.server";
import {
  aiDiagnosisService,
  aiTutorService,
  aiMissionGenerationService,
} from "./ai-service.server";
import type { DiagnosisRequest, TutorRequest } from "./ai-contracts";

export type AiMessage = { role: "system" | "user" | "assistant"; content: string };

export type AiConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export function readAiConfig(): AiConfig | null {
  const config = readProviderConfig();
  if (!config) return null;
  return { apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model };
}

export async function evaluateAttempt(input: ObserverInput) {
  const request: DiagnosisRequest = {
    contract: {
      id: input.contract.id,
      title: input.contract.title,
      objective: input.contract.objective,
      requiredSkills: input.contract.requiredSkills,
      allowedApproaches: input.contract.allowedApproaches,
      bannedShortcuts: input.contract.bannedShortcuts,
    },
    rawCommand: input.raw,
    execution: {
      exitCode: input.execution.exitCode,
      lines: input.execution.lines,
      mutationCount: input.execution.mutationCount,
      blockedReason: input.execution.blocked?.reason ?? null,
    },
    verification: {
      status: input.verification.status,
      score: input.verification.score,
      objectives: input.verification.objectives,
    },
    history: input.history,
    hintsUsed: input.hintsUsed,
    language: input.language,
  };

  const { response } = await aiDiagnosisService(request);
  return response;
}

function localTutorFallback(input: {
  message: string;
  language: string;
  depth: string;
  context?: unknown;
}): string {
  const q = input.message.toLowerCase();
  const context = (input.context ?? {}) as {
    progression?: { level?: number };
    skills?: Array<{ skill_id?: string; mastery?: number; recent_mistakes?: string[] }>;
    recentCommands?: Array<{ input?: string; stderr?: string; exit_code?: number }>;
  };
  const weak = (context.skills ?? []).filter((s) => (s.mastery ?? 100) < 55).slice(0, 2);
  const last = context.recentCommands?.[0];
  const prefix = input.language === "Hinglish" || input.language === "Mix (auto)" ? "Bhai, " : "";
  if (/chmod|permission|owner|group/.test(q))
    return `${prefix}chmod permissions control karta hai: owner/group/others ke liye read=4, write=2, execute=1. Example: chmod 640 file.txt. Your current learner model shows ${weak.length ? `extra practice on ${weak.map((s) => s.skill_id).join(" and ")}` : "no major weak skill yet"}.`;
  if (/mkdir|directory|folder/.test(q))
    return `${prefix}mkdir directory banata hai. Existing parent ke andar banana ho to mkdir parent/child, aur missing parents bhi chahiye to mkdir -p parent/child. ${last?.stderr ? `Last command error: ${last.stderr}` : "Try it in the lab and I can reason from the result."}`;
  if (/loop|for /.test(q))
    return `${prefix}bash loop ka basic shape hai: for i in 1 2 3; do command "$i"; done. LinuxForge task me loop tabhi credit karega jab loop actually use hua ho, sirf final files dekh kar nahi.`;
  if (/rm|delete|remove/.test(q))
    return `${prefix}rm files/directories remove karta hai. Training lab me destructive recursive commands ko sirf isolated lab boundary ke andar allow karna chahiye. Agar rm -rf kisi lab object ko delete kare, evaluator actual state aur command result dono check karega.`;
  return `${prefix}I can help with that. Your current Forge learner level is ${context.progression?.level ?? 1}. Ask me about the concept, paste the command/error, or run it in the lab and I will use the observed result rather than guessing.`;
}

export async function tutorReply(input: {
  message: string;
  language: string;
  depth: string;
  context?: unknown;
}): Promise<string> {
  const lang: "English" | "Hinglish" | "Mix both" =
    input.language === "Hinglish" || input.language === "Mix (auto)" || input.language === "Mix both"
      ? "Hinglish"
      : "English";
  const depth: "nudge" | "hint" | "explain" | "walkthrough" =
    input.depth === "nudge" || input.depth === "hint" || input.depth === "walkthrough"
      ? input.depth
      : "explain";

  const request: TutorRequest = {
    message: input.message,
    language: lang,
    depth,
    context: input.context as TutorRequest["context"],
  };

  const { response } = await aiTutorService(request);
  return response.text;
}

import { QUESTION_SOURCES, QUESTION_TOPICS } from "./question-bank";
import type { AdaptiveExercise, SkillId } from "@/lib/forge/types";
import type { MissionBlueprint } from "./mission-generator";
import type { TrainingDecision } from "./adaptive-training";
import { isMeaningfullyDifferent, validateGeneratedExercise } from "./exercise-generation.server";

function adaptiveFallback(input: {
  level: number;
  weakSkills: string[];
  recentMistakes: string[];
  blueprint?: MissionBlueprint;
  kind?: "question" | "task" | "mission" | "mock_exam";
  requestedTopic?: string;
}): AdaptiveExercise {
  const requested = input.requestedTopic?.toLowerCase();
  const preferred =
    (requested
      ? QUESTION_TOPICS.find((t) => t.topic.toLowerCase().includes(requested) || requested.includes(t.topic.toLowerCase()))
      : undefined) ??
    QUESTION_TOPICS.find((t) =>
      input.weakSkills.some((s) => t.topic.toLowerCase().includes(s.toLowerCase())),
    ) ?? QUESTION_TOPICS[0]!;
  const source =
    QUESTION_SOURCES.find((s) =>
      /linux|shell|security|blue/i.test(`${s.scope} ${preferred.domain}`),
    ) ?? QUESTION_SOURCES[0]!;
  const difficulty =
    input.blueprint?.difficulty ??
    Math.max(1, Math.min(5, input.level + (input.recentMistakes.length ? 0 : 1)));
  const kind = input.kind ?? (difficulty >= 4 ? "mission" : "task");
  const executable = kind === "task" || kind === "mission";
  const slug = preferred.topic
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
  return {
    id: `adaptive-${preferred.domain === "shell" ? "shell-scripting" : "filesystem"}-${difficulty}`,
    kind,
    title: `${preferred.topic.replace(/\b\w/g, (c) => c.toUpperCase())} field drill`,
    scenario: `A practical lab exercise focused on ${preferred.topic}.`,
    objective: executable
      ? `Create a ${slug}-practice directory and demonstrate the ${preferred.topic} skill in the training lab.`
      : `Explain and reason about ${preferred.topic} using the Linux/cybersecurity concepts you have learned.`,
    skills: (input.blueprint
      ? [input.blueprint.primarySkill, ...input.blueprint.supportingSkills]
      : [preferred.domain === "shell" ? "shell-scripting" : "filesystem"]) as SkillId[],
    difficulty,
    estimatedMinutes: difficulty * 5,
    sourceRefs: [{ id: source.id, name: source.name, url: source.url }],
    evaluationFocus: ["intent", "method", "errors", "final state", "valid alternatives"],
    learnerReason:
      input.blueprint?.rationale ??
      (input.weakSkills.length
        ? `Selected to reinforce ${input.weakSkills.slice(0, 2).join(" and ")}.`
        : "Selected to broaden practical coverage."),
    allowedApproaches: [
      "Use any valid supported Linux command sequence that satisfies the objective.",
    ],
    bannedShortcuts: [
      "Do not rely on host-system access or unsafe commands outside the training lab.",
    ],
    hints: [
      `Think about the purpose of ${preferred.topic} before choosing a command.`,
      "Inspect the current lab state before changing it.",
      "Use the modelled commands shown by help and verify your end state.",
    ],
    successStory:
      "The generated drill is complete and your method demonstrated the requested skill.",
    failureStory:
      "The generated drill is not complete yet. Use the objective and observed terminal state to close the gap.",
    remediation: [
      "Inspect the current lab state with pwd/ls and correct one requirement at a time.",
    ],
    ...(executable
      ? {
          evaluationPlan: {
            objectives: [
              {
                label: `practice directory for ${preferred.topic} exists`,
                path: `${slug}-practice`,
                objectType: "directory" as const,
              },
            ],
            requiredCommandKinds: ["mkdir"],
            minimumMutations: 1,
          },
        }
      : {}),
  };
}

export async function generateAdaptiveExercise(input: {
  level: number;
  weakSkills: string[];
  strongSkills: string[];
  recentMistakes: string[];
  recentTopics?: string[];
  blueprint?: MissionBlueprint;
  kind?: "question" | "task" | "mission" | "mock_exam";
  requestedTopic?: string;
}): Promise<AdaptiveExercise> {
  const config = readProviderConfig();
  if (!config) {
    const fallback = adaptiveFallback(input);
    return validateGeneratedExercise(fallback, input.blueprint).normalized ?? fallback;
  }

  const primarySkill = (input.blueprint?.primarySkill ??
    (input.weakSkills[0] as SkillId) ??
    "filesystem") as SkillId;
  const supportingSkills = (input.blueprint?.supportingSkills ?? []) as SkillId[];

  const blueprint: MissionBlueprint = input.blueprint ?? {
    version: "v32",
    archetype: input.level >= 4 ? "TRANSFER" : "PROGRESSION",
    primarySkill,
    supportingSkills,
    difficulty: Math.max(1, Math.min(5, input.level || 1)),
    prerequisites: [],
    objectiveShape: input.requestedTopic ? `Practice ${input.requestedTopic}` : "Practical lab exercise",
    storyContinuity: "Field drill",
    evidenceFocus: ["intent", "method", "result"],
    knowledgeIds: [],
    mistakeFocus: null,
    rationale: input.weakSkills.length
      ? `Selected to reinforce ${input.weakSkills.slice(0, 2).join(" and ")}.`
      : "Selected to broaden practical coverage.",
  };

  const trainingDecision: TrainingDecision = {
    version: "v37",
    mode: "GUIDED_PRACTICE",
    primarySkill: blueprint.primarySkill,
    supportingSkills: blueprint.supportingSkills,
    difficulty: blueprint.difficulty,
    constraints: [],
    sourceStrategy: "targeted-patterns",
    masteryGate: "PRACTICE",
    journeyPhase: "ACTIVE_TRAINING",
    journeyNextSkills: [],
    focusMistakes: [],
    evidence: [],
    reason: blueprint.rationale,
  };

  const { response, fallbackUsed } = await aiMissionGenerationService(
    {
      trainingDecision,
      blueprint,
      skills: [blueprint.primarySkill, ...blueprint.supportingSkills].map((s) => ({
        skillId: s,
        mastery: 50,
        attempts: 1,
        successfulAttempts: 1,
        recentScore: 80,
        recentMistakes: [],
        hintDependency: 0,
        confidence: 50,
        lastPracticed: new Date().toISOString(),
        nextReview: new Date().toISOString(),
      })),
      recentMistakes: input.recentMistakes,
      recentTopics: input.recentTopics,
      difficulty: blueprint.difficulty,
    },
    config,
  );

  const candidate = fallbackUsed ? adaptiveFallback(input) : response.exercise;
  const validation = validateGeneratedExercise(candidate, input.blueprint);
  if (validation.valid && isMeaningfullyDifferent(candidate, input.recentTopics ?? [])) {
    return validation.normalized ?? candidate;
  }
  const fallback = adaptiveFallback(input);
  const fallbackValidation = validateGeneratedExercise(fallback, input.blueprint);
  return fallbackValidation.normalized ?? fallback;
}
