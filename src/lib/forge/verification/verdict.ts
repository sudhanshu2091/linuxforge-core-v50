import type { CompletionQuality, CompletionQualityInput, VerificationVerdict } from "./types";

export function classifyCompletionQuality(input: CompletionQualityInput): CompletionQuality {
  if (input.verdict !== "PASS")
    return {
      mode: null,
      independent: false,
      consumed: false,
      consumedReason: null,
    };
  const assistance = input.hintsUsed + (input.tutorInterventionCount ?? 0);
  if (input.solutionRevealed)
    return {
      mode: "SOLUTION_REVEALED",
      independent: false,
      consumed: false,
      consumedReason: "NONE",
    };
  if (input.skillDemonstrated === false || input.bypassed === true)
    return {
      mode: "ASSISTED",
      independent: false,
      consumed: false,
      consumedReason: "BYPASS",
    };
  if (assistance === 0)
    return {
      mode: "DIRECT",
      independent: true,
      consumed: true,
      consumedReason: "DIRECT_COMPLETION",
    };
  if (assistance <= 2)
    return {
      mode: "ASSISTED",
      independent: false,
      consumed: false,
      consumedReason: "ASSISTED",
    };
  return {
    mode: "HEAVILY_ASSISTED",
    independent: false,
    consumed: false,
    consumedReason: "ASSISTED",
  };
}

export function isFinalVerdict(verdict: VerificationVerdict): boolean {
  return (
    verdict === "PASS" ||
    verdict === "PARTIAL" ||
    verdict === "FAIL" ||
    verdict === "BLOCKED" ||
    verdict === "INVALID"
  );
}
