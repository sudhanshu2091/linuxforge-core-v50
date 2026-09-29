/**
 * AI Observer layer (server-only).
 *
 * The observer OBSERVES. It classifies what the learner appeared to do and
 * writes friendly coaching, but it never decides the mission status — that is
 * the deterministic verifier's job alone.
 *
 * INTENT-AWARE EVALUATION (Phase 3):
 * Evaluates learner actions from:
 * 1. learner input / command
 * 2. execution result & exitCode
 * 3. actual observed world state
 * 4. deterministic verification result
 * 5. method evidence
 * 6. mission objective
 * 7. required skills
 * 8. allowed approaches
 * 9. banned shortcuts
 * 10. hints used
 */

import type { Contract } from "./contracts.server";
import type { ExecutionResult } from "./executor.server";
import type { Observation, Verification } from "./types";
import { evaluateAttempt } from "@/lib/ai/provider.server";

export type ObserverInput = {
  contract: Contract;
  raw: string;
  /** Provider-neutral slice of the execution observation (never provider logic). */
  execution: Pick<ExecutionResult, "lines" | "blocked" | "evidence"> & {
    exitCode: number;
    mutationCount: number;
  };
  verification: Verification;
  /** Commands recorded across this attempt, oldest first. */
  history: string[];
  hintsUsed: number;
  language: "English" | "Hinglish" | "Mix both";
};

export type ObserverAdapter = {
  id: string;
  observe: (input: ObserverInput) => Observation | Promise<Observation>;
};

const KNOWN = [
  "mkdir",
  "touch",
  "chmod",
  "ls",
  "cd",
  "cat",
  "echo",
  "pwd",
  "stat",
  "tree",
  "help",
  "clear",
  "for",
  "rm",
  "grep",
  "find",
  "ps",
  "kill",
  "head",
  "tail",
  "less",
];

function nearestKnown(word: string): string | null {
  const distance = (a: string, b: string) => {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [
      i,
      ...Array(b.length).fill(0),
    ]) as number[][];
    for (let j = 0; j <= b.length; j++) (dp[0] as number[])[j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        (dp[i] as number[])[j] = Math.min(
          (dp[i - 1] as number[])[j]! + 1,
          (dp[i] as number[])[j - 1]! + 1,
          (dp[i - 1] as number[])[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
    return (dp[a.length] as number[])[b.length]!;
  };

  let best: string | null = null;
  let bestD = 99;
  for (const k of KNOWN) {
    const d = distance(word, k);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return bestD > 0 && bestD <= 2 ? best : null;
}

function line(language: ObserverInput["language"], english: string, hinglish: string): string {
  if (language === "English") return english;
  if (language === "Hinglish") return hinglish;
  return `${english} ${hinglish}`;
}

export const aiObserver: ObserverAdapter = {
  id: "forge-ai-observer-v1",
  async observe(input) {
    // Hard guardrail: a failed/blocked command must never receive a success
    // observation from a language model, even if the model hallucinates one.
    const failed =
      input.execution.blocked || input.execution.lines.some((line) => line.kind === "error");
    if (failed) return deterministicObserver.observe(input);

    try {
      const value = (await evaluateAttempt(input)) as Record<string, unknown>;
      const categories = new Set([
        "TYPO",
        "WRONG_COMMAND",
        "WRONG_ARGUMENT",
        "WRONG_PATH",
        "WRONG_FILENAME",
        "MISREAD_QUESTION",
        "CONCEPT_CONFUSION",
        "PARTIAL_UNDERSTANDING",
        "UNSAFE_APPROACH",
        "RANDOM_TRIAL_AND_ERROR",
        "SKILL_BYPASS",
        "VALID_ALTERNATIVE",
        "INDEPENDENT_SOLUTION",
      ]);
      const category =
        typeof value["category"] === "string" && categories.has(value["category"])
          ? (value["category"] as Observation["category"])
          : null;
      const understanding =
        value["conceptUnderstanding"] === "solid" || value["conceptUnderstanding"] === "partial"
          ? value["conceptUnderstanding"]
          : "unclear";

      return {
        intent:
          typeof value["intent"] === "string" && value["intent"].length
            ? value["intent"]
            : input.contract.objective,
        approach:
          typeof value["approach"] === "string" && value["approach"].length
            ? value["approach"]
            : input.raw.trim(),
        skillTarget: input.contract.requiredSkills,
        category,
        conceptUnderstanding: understanding,
        skillDemonstrated: value["skillDemonstrated"] === true,
        coaching:
          typeof value["coaching"] === "string" && value["coaching"].length
            ? value["coaching"]
            : "Review the terminal output and try the next step.",
        evidence: Array.isArray(value["evidence"]) ? (value["evidence"] as string[]) : [],
      };
    } catch {
      return deterministicObserver.observe(input);
    }
  },
};

export type DeterministicObserver = {
  id: string;
  observe: (input: ObserverInput) => Observation;
};

export const deterministicObserver: DeterministicObserver = {
  id: "forge-deterministic-observer-v1",
  observe({ contract, raw, execution, verification, history, hintsUsed, language }): Observation {
    const trimmedRaw = raw.trim();
    const first = trimmedRaw.split(/\s+/)[0] ?? "";
    const errored = execution.lines.some((l) => l.kind === "error");
    const skillTarget = contract.requiredSkills;
    const base = { intent: contract.objective, skillTarget };

    // 1. UNSAFE APPROACH: Blocked by security / sandbox policy
    if (execution.blocked) {
      return {
        ...base,
        approach: "Tried an action outside the sandbox safety policy",
        category: "UNSAFE_APPROACH",
        conceptUnderstanding: "partial",
        skillDemonstrated: false,
        coaching: line(
          language,
          "Let's stay inside the training lab — that one is off limits here. Same goal, safer route.",
          "Yeh command sandbox ke bahar hai, isliye block ho gayi. Wahi kaam safe tarike se kar lete hain.",
        ),
        evidence: ["Command execution blocked by sandbox safety policy", `Input: ${trimmedRaw}`],
      };
    }

    // 2. ERRORED EXECUTION (Typo, Wrong Path, Wrong Filename, Wrong Argument, Wrong Command)
    if (errored || execution.exitCode !== 0) {
      const typoOf = nearestKnown(first);
      if (typoOf) {
        return {
          ...base,
          approach: `Typed ${first}`,
          category: "TYPO",
          conceptUnderstanding: "partial",
          skillDemonstrated: false,
          coaching: line(
            language,
            `That command failed, but the intent looks close. ${first} looks like a typo of ${typoOf}.`,
            `Command fail hui, par intent close hai. ${first}, ${typoOf} ki typo lag rahi hai.`,
          ),
          evidence: [`Typo detected: '${first}' is close to '${typoOf}'`, `Exit code: ${execution.exitCode}`],
        };
      }

      const missingPath = execution.lines.some((l) =>
        /No such file|cannot access|Not a directory/i.test(l.text),
      );
      const isWrongFilename = execution.lines.some((l) =>
        /cannot open|File exists|invalid filename/i.test(l.text),
      );

      let errorCategory: Observation["category"] = "WRONG_COMMAND";
      if (missingPath) errorCategory = "WRONG_PATH";
      else if (isWrongFilename) errorCategory = "WRONG_FILENAME";
      else if (KNOWN.includes(first)) errorCategory = "WRONG_ARGUMENT";

      return {
        ...base,
        approach: trimmedRaw,
        category: errorCategory,
        conceptUnderstanding: "partial",
        skillDemonstrated: false,
        coaching: line(
          language,
          missingPath
            ? "The command failed because the target path or file is wrong. Use pwd/ls to inspect the real state before trying again."
            : `The command failed, so I won't call this successful just because the lab may already contain the target. Read the error and adjust the command.`,
          missingPath
            ? "Command fail hua kyunki target path/file galat hai. pwd/ls se actual state dekho, phir retry karo."
            : "Command fail hui hai, isliye sirf final state dekh kar success nahi maanenge. Error padho aur command adjust karo.",
        ),
        evidence: [
          `Command exited with code ${execution.exitCode}`,
          `Category derived from terminal error: ${errorCategory}`,
        ],
      };
    }

    // 3. COMPLETE VERIFICATION STATUS
    if (verification.status === "COMPLETE") {
      const verificationOnly = /^(ls|pwd|stat|tree|cat|help|clear)(\s|$)/.test(trimmedRaw);
      if (execution.mutationCount === 0 && !verificationOnly) {
        return {
          ...base,
          approach: trimmedRaw,
          category: "PARTIAL_UNDERSTANDING",
          conceptUnderstanding: "partial",
          skillDemonstrated: false,
          coaching: line(
            language,
            "The lab is already in the required end state, but this command did not demonstrate the requested skill. I won't give credit just for an already-correct state.",
            "Lab ka end state already sahi hai, lekin is command ne requested skill demonstrate nahi ki. Sirf purane correct state ke liye credit nahi milega.",
          ),
          evidence: [
            "Final state is complete, but zero mutations occurred and command was non-verifying",
          ],
        };
      }

      if (verificationOnly) {
        return {
          ...base,
          approach: `Verified the lab with ${first}`,
          category: "VALID_ALTERNATIVE",
          conceptUnderstanding: "solid",
          skillDemonstrated: false,
          coaching: line(
            language,
            "That is a useful verification step. The mission state is already complete; this command itself is evidence-checking, not the skill task.",
            "Yeh useful verification step hai. Mission already complete hai; yeh command skill task nahi, state check kar raha hai.",
          ),
          evidence: [`Verification command '${first}' executed on already completed state`],
        };
      }

      const matchesAllowedExact = contract.allowedApproaches.some((a) =>
        trimmedRaw === a.trim() || trimmedRaw.startsWith(a.trim() + " "),
      );
      const alternative = !matchesAllowedExact;
      const independent = hintsUsed === 0 && !alternative;

      return {
        ...base,
        approach: trimmedRaw,
        category: alternative
          ? "VALID_ALTERNATIVE"
          : independent
            ? "INDEPENDENT_SOLUTION"
            : null,
        conceptUnderstanding: "solid",
        skillDemonstrated: true,
        coaching: line(
          language,
          independent
            ? "Clean work — you reasoned that out yourself and the end state proves it."
            : "That works, and it counts: the skill showed up in what you actually did.",
          independent
            ? "Solid! Bilkul khud se nikala, aur result bhi verify ho gaya."
            : "Ho gaya — tareeqa valid hai, skill dikh gayi.",
        ),
        evidence: [
          `Deterministic verification complete`,
          independent ? "Demonstrated with 0 hints (independent solution)" : "Demonstrated with guidance/alternative approach",
        ],
      };
    }

    // 4. RESULT CORRECT SKILL NOT DEMONSTRATED (e.g. bypassing loop or technique)
    if (verification.status === "RESULT_CORRECT_SKILL_NOT_DEMONSTRATED") {
      return {
        ...base,
        approach: `${history.length} separate commands, no required technique construct`,
        category: "SKILL_BYPASS",
        conceptUnderstanding: "partial",
        skillDemonstrated: false,
        coaching: line(
          language,
          "The files are all there — but this mission is about demonstrating the required technique. Try expressing it using the requested skill construct.",
          "Files sab ban gaye, par mission ka point required technique hai. Usi skill construct se karo.",
        ),
        evidence: [
          "State requirements met, but required method/technique was bypassed or unobserved",
        ],
      };
    }

    // 5. RESULT INCORRECT SKILL DEMONSTRATED (correct technique applied to wrong target)
    if (verification.status === "RESULT_INCORRECT_SKILL_DEMONSTRATED") {
      return {
        ...base,
        approach: trimmedRaw,
        category: /log|error|wrong/i.test(trimmedRaw) ? "WRONG_PATH" : "WRONG_ARGUMENT",
        conceptUnderstanding: "partial",
        skillDemonstrated: true,
        coaching: line(
          language,
          "Technique is right, target is off. Re-read the exact path or filename in the brief and point the same command at it.",
          "Technique sahi hai, target galat. Brief me diya exact path/filename dekho aur wahi command wahan chala do.",
        ),
        evidence: [
          "Required skill technique was demonstrated, but end state target was incorrect",
        ],
      };
    }

    // 6. RANDOM TRIAL AND ERROR
    const repeated = history.length >= 4 && new Set(history.slice(-4)).size <= 2;
    if (repeated) {
      return {
        ...base,
        approach: "Repeating similar commands without changing the outcome",
        category: "RANDOM_TRIAL_AND_ERROR",
        conceptUnderstanding: "unclear",
        skillDemonstrated: false,
        coaching: line(
          language,
          "Pause the typing for a second. Say out loud what end state you need, then pick one command that changes it.",
          "Ek second ruk jao. Pehle bolo final state kya chahiye, phir ek hi command chuno jo wo change kare.",
        ),
        evidence: [
          `Repeated similar commands ${history.length} times without state mutation`,
        ],
      };
    }

    // 7. PARTIAL UNDERSTANDING vs CONCEPT CONFUSION
    const partial = verification.objectives.some((o) => o.met);
    return {
      ...base,
      approach: trimmedRaw,
      category: partial ? "PARTIAL_UNDERSTANDING" : "CONCEPT_CONFUSION",
      conceptUnderstanding: partial ? "partial" : "unclear",
      skillDemonstrated: false,
      coaching: line(
        language,
        partial
          ? "Part of it is done. Compare the objective list against what the lab actually shows and close the gap."
          : "Let's rebuild the idea first, then the command. Ask me for a nudge and we will do it step by step.",
        partial
          ? "Aadha ho gaya. Objective list aur lab ki current state compare karo aur baaki gap fill karo."
          : "Pehle concept clear kar lete hain, phir command chalayenge. Nudge mango, step by step karte hain.",
      ),
      evidence: [
        partial
          ? "Some objectives met in deterministic verification, but others incomplete"
          : "Zero objectives met and unobserved skill construct",
      ],
    };
  },
};
