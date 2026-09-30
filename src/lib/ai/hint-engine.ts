import type { ObservationCategory, Observation, SkillMemoryView } from "@/lib/forge/types";
import { decideTeachingStrategy } from "./teaching-engine";

export type HintSituation = {
  level: number;
  totalLevels: number;
  baseHint: string;
  observation: Pick<Observation, "category" | "conceptUnderstanding" | "skillDemonstrated"> | null;
  failedCommands: number;
  attempts: number;
  learnerLevel?: number;
  desiredDifficulty?: number;
  skills?: SkillMemoryView[];
  mistakeHistory?: ObservationCategory[];
  previousHintStages?: string[];
  objective?: string;
  currentTerminalState?: string;
};

export type GuidedHint = {
  level: number;
  stage: "CONCEPT" | "DIRECTION" | "COMMAND" | "NEAR_SOLUTION" | "SOLUTION";
  strategy: "DISCOVER" | "DIAGNOSE" | "REPAIR" | "EXPLAIN" | "TRANSFER" | "VERIFY";
  teachingNote: string;
  text: string;
  conceptGap: string | null;
  sourceRefs: { id: string; name: string; url: string }[];
};

const categoryNotes: Partial<Record<ObservationCategory, string>> = {
  TYPO: "Command mein typo lag raha hai. Exact spelling ko slow down karke check karo.",
  WRONG_COMMAND:
    "Command ka naam ya purpose mismatch ho sakta hai. Task ko command family se map karo.",
  WRONG_ARGUMENT:
    "Command sahi direction mein hai, lekin argument ko objective ke saath match karo.",
  WRONG_PATH:
    "Path ko break karke verify karo: current directory kya hai, aur target kis location mein hona chahiye?",
  WRONG_FILENAME: "Filename ko objective se character-by-character compare karo.",
  MISREAD_QUESTION:
    "Objective ko small pieces mein padho. Pehle exact target identify karo, phir command choose karo.",
  CONCEPT_CONFUSION:
    "Command ya syntax yaad karne se pehle underlying Linux concept clear karte hain.",
  PARTIAL_UNDERSTANDING:
    "Direction sahi hai. Ab missing step identify karke approach complete karo.",
  UNSAFE_APPROACH:
    "Lab safety boundary ke andar raho. Shortcut ke bajay intended training workflow use karo.",
  RANDOM_TRIAL_AND_ERROR:
    "Random commands try karne ke bajay ek hypothesis banao, phir usse verify karo.",
  SKILL_BYPASS: "Result se zyada important hai required skill ko actually demonstrate karna.",
};

const stageFor = (level: number, total: number): GuidedHint["stage"] => {
  if (level >= total) return "SOLUTION";
  if (level >= 4) return "NEAR_SOLUTION";
  if (level === 3) return "COMMAND";
  if (level === 2) return "DIRECTION";
  return "CONCEPT";
};

export function buildGuidedHint(input: HintSituation): GuidedHint {
  const total = Math.max(1, input.totalLevels);
  const level = Math.max(1, Math.min(input.level, total));
  const stage = stageFor(level, total);
  const latest = input.observation?.category ?? null;
  const skills = input.skills ?? [];
  const mastery = Object.fromEntries(skills.map((s) => [s.skillId, s.mastery]));
  const focusSkills = skills
    .filter((s) => s.mastery < 55)
    .slice(0, 3)
    .map((s) => s.skillId);
  const decision = decideTeachingStrategy({
    learnerLevel: input.learnerLevel ?? 1,
    desiredDifficulty: input.desiredDifficulty ?? 1,
    mastery,
    focusSkills,
    recentMistakes: input.mistakeHistory ?? (latest ? [latest] : []),
    latestMistake: latest,
    failedCommands: input.failedCommands,
    attempts: input.attempts,
    hintsUsed: level - 1,
    previousHintStages: input.previousHintStages ?? [],
    objective: input.objective ?? input.baseHint,
    currentTerminalState: input.currentTerminalState ?? "",
  });

  const targeted = latest ? categoryNotes[latest] : undefined;
  const knowledge = decision.knowledge[0];
  const strategyText =
    decision.strategy === "EXPLAIN"
      ? (knowledge?.summary ??
        "Concept ko ek simple rule mein reduce karo, phir usse task par apply karo.")
      : decision.strategy === "DIAGNOSE"
        ? (knowledge?.diagnostic ?? decision.nextAction)
        : decision.nextAction;
  const safety = latest === "UNSAFE_APPROACH" ? " Safe lab ke bahar kuch execute mat karo." : "";
  const base = input.baseHint.trim();
  const text =
    level >= total
      ? `${strategyText}${base ? ` ${base}` : ""}${safety}`
      : `${targeted ?? strategyText}${base && level <= 2 ? ` ${base}` : ""}${safety}`;

  return {
    level,
    stage,
    strategy: decision.strategy,
    teachingNote:
      targeted ??
      (input.attempts === 0
        ? "Before asking for more help, make one small attempt so Forge can reason from your evidence."
        : decision.reason),
    text,
    conceptGap: decision.conceptGap,
    sourceRefs: knowledge?.sourceRefs ?? [],
  };
}
