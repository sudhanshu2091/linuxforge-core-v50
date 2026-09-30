import type { MissionState, SkillMemoryView, ObservationCategory } from "@/lib/forge/types";
import { redactText } from "@/lib/security-redaction";
import { retrieveKnowledge } from "./knowledge-base";
import { decideTeachingStrategy } from "./teaching-engine";
import { analyzeLearner } from "./learner-intelligence";

/**
 * Bounded, learner-safe context for the mission tutor.
 *
 * This deliberately excludes internal contracts, verification rules, raw
 * database rows and provider details. Transcript text is redacted before it
 * can cross the AI provider boundary.
 */
export type MissionTutorContext = {
  mission: {
    id: string;
    title: string;
    objective: string;
    requiredSkills: string[];
    difficulty: number;
  };
  learner: {
    level: number;
    focusSkills: string[];
    mastery: Record<string, number>;
    readiness: number;
    confidence: number;
    independence: number;
    hintDependency: number;
    signals: string[];
    difficultyAdjustment: -1 | 0 | 1;
  };
  run: {
    cwd: string;
    verification: MissionState["lastVerification"];
    observation: MissionState["lastObservation"];
    recentTerminal: string[];
    previousHints: { level: number; stage?: string; teachingNote?: string }[];
  };
  teaching: {
    strategy: string;
    nextAction: string;
    conceptGap: string | null;
    grounding: {
      id: string;
      title: string;
      summary: string;
      diagnostic: string;
      sourceRefs: { id: string; name: string; url: string }[];
    }[];
  };
};

const bounded = (text: string, max: number) => text.slice(0, max);

export function buildMissionTutorContext(state: MissionState): MissionTutorContext {
  const mastery = Object.fromEntries(
    state.skills.map((skill: SkillMemoryView) => [skill.skillId, skill.mastery]),
  );

  const recentTerminal = state.transcript
    .slice(-12)
    .map((line) => bounded(redactText(line.text).text, 600))
    .filter(Boolean);
  const latestMistake = state.lastObservation?.category ?? null;
  const recentMistakes = state.skills
    .flatMap((skill) => skill.recentMistakes)
    .slice(-12) as ObservationCategory[];
  const intelligence = analyzeLearner(state.skills, recentMistakes);
  const grounding = retrieveKnowledge({
    query: `${state.challenge.objective} ${recentTerminal.join(" ")}`,
    skills: state.challenge.requiredSkills,
    mistake: latestMistake,
    limit: 3,
  });
  const decision = decideTeachingStrategy({
    learnerLevel: state.progression.level,
    desiredDifficulty: state.context.desired_difficulty,
    mastery,
    focusSkills: state.context.weak_skills.slice(0, 4),
    recentMistakes: recentMistakes.slice(-8),
    latestMistake,
    failedCommands: state.transcript.filter((line) => line.kind === "error").length,
    attempts: state.attempt.attempts,
    hintsUsed: state.hints.length,
    previousHintStages: state.hints.map((hint) => hint.stage ?? ""),
    objective: state.challenge.objective,
    currentTerminalState: recentTerminal.join(" "),
  });

  return {
    mission: {
      id: state.challenge.id,
      title: bounded(state.challenge.title, 200),
      objective: bounded(state.challenge.objective, 1200),
      requiredSkills: [...state.challenge.requiredSkills],
      difficulty: state.challenge.difficulty,
    },
    learner: {
      level: state.progression.level,
      focusSkills: intelligence.focusSkills.length
        ? intelligence.focusSkills
        : state.context.weak_skills.slice(0, 4),
      mastery,
      readiness: intelligence.readiness,
      confidence: intelligence.confidence,
      independence: intelligence.independence,
      hintDependency: intelligence.hintDependency,
      signals: intelligence.signals,
      difficultyAdjustment: intelligence.difficultyAdjustment,
    },
    run: {
      cwd: bounded(state.cwd, 512),
      verification: state.lastVerification,
      observation: state.lastObservation
        ? {
            ...state.lastObservation,
            coaching: bounded(state.lastObservation.coaching, 1000),
            approach: bounded(state.lastObservation.approach, 600),
            intent: bounded(state.lastObservation.intent, 600),
          }
        : null,
      recentTerminal,
      previousHints: state.hints.map((hint) => ({
        level: hint.level,
        ...(hint.stage ? { stage: hint.stage } : {}),
        ...(hint.teachingNote ? { teachingNote: bounded(hint.teachingNote, 400) } : {}),
      })),
    },
    teaching: {
      strategy: decision.strategy,
      nextAction: bounded(decision.nextAction, 600),
      conceptGap: decision.conceptGap ? bounded(decision.conceptGap, 200) : null,
      grounding: grounding.map((card) => ({
        id: card.id,
        title: bounded(card.title, 200),
        summary: bounded(card.summary, 700),
        diagnostic: bounded(card.diagnostic, 500),
        sourceRefs: card.sourceRefs,
      })),
    },
  };
}
