/**
 * LinuxForge Core — challenge engine shared types (client-safe).
 *
 * These types cross the server-function boundary, so they contain no
 * verification rules, hint text or scoring policy. Those live only in
 * `*.server.ts` modules and are never shipped to the browser.
 */

export type SkillId =
  | "filesystem"
  | "permissions"
  | "iteration"
  | "shell-scripting"
  | "processes"
  | "networking"
  | "hardening";

export const SKILL_LABELS: Record<SkillId, string> = {
  filesystem: "Filesystem",
  permissions: "Permissions",
  iteration: "Iteration & loops",
  "shell-scripting": "Shell scripting",
  processes: "Processes",
  networking: "Networking",
  hardening: "Hardening",
};

/** Final authority verdicts — produced only by the deterministic verifier. */
export type VerificationStatus =
  | "COMPLETE"
  | "RESULT_CORRECT_SKILL_NOT_DEMONSTRATED"
  | "RESULT_INCORRECT_SKILL_DEMONSTRATED"
  | "INCOMPLETE"
  | "BLOCKED_BY_SAFETY_POLICY";

/** Observer classifications — advisory only, never a final status. */
export type ObservationCategory =
  | "TYPO"
  | "WRONG_COMMAND"
  | "WRONG_ARGUMENT"
  | "WRONG_PATH"
  | "WRONG_FILENAME"
  | "MISREAD_QUESTION"
  | "CONCEPT_CONFUSION"
  | "PARTIAL_UNDERSTANDING"
  | "UNSAFE_APPROACH"
  | "RANDOM_TRIAL_AND_ERROR"
  | "SKILL_BYPASS"
  | "VALID_ALTERNATIVE"
  | "INDEPENDENT_SOLUTION";

export type Observation = {
  /** What the learner appeared to be trying to do. */
  intent: string;
  /** How they went about it. */
  approach: string;
  skillTarget: SkillId[];
  category: ObservationCategory | null;
  conceptUnderstanding: "unclear" | "partial" | "solid";
  skillDemonstrated: boolean;
  /** Learner-facing mentor line. Hidden scores/policies are never included. */
  coaching: string;
  /** Concrete execution/method evidence describing why this classification occurred. */
  evidence?: string[];
};

export type ObjectiveResult = {
  label: string;
  met: boolean;
  /** Evidence sentence the learner can verify themselves. */
  evidence: string;
};

export type Verification = {
  status: VerificationStatus;
  objectives: ObjectiveResult[];
  /** 0-100 deterministic grade. */
  score: number;
  message: string;
  remediation: string[];
  wentWell: string[];
};

export type WorldObjectView = {
  objectId: string;
  objectType: "directory" | "file";
  path: string;
  name: string;
  permissions: string;
  createdByChallenge: string | null;
  lastModifiedByChallenge: string | null;
  createdAt: string;
};

export type NarrativeEventView = {
  eventId: string;
  challengeId: string | null;
  eventType: string;
  summary: string;
  importance: number;
  createdAt: string;
  relatedSkillIds: string[];
};

export type MasteryState =
  "NOT_STARTED" | "LEARNING" | "DEVELOPING" | "FUNCTIONAL" | "FRAGILE" | "MASTERED";

export type SkillMasteryView = {
  skillId: SkillId;
  state: MasteryState;
  masteryScore: number;
  successRate: number;
  evidenceCount: number;
  retention: number;
  independence: number;
  confidence: number;
  recentScore: number;
  due: boolean;
  gatesSatisfied: number;
  gatesRequired: number;
  missingGates: string[];
  rationale: string;
};

export type ProgressionAction = "PRACTICE" | "REVIEW" | "CONFIRM_MASTERY" | "ADVANCE" | "REMEDIATE";

export type ProgressionDecisionView = {
  action: ProgressionAction;
  targetSkills: SkillId[];
  masteredSkills: SkillId[];
  fragileSkills: SkillId[];
  eligibleNextSkills: SkillId[];
  mastery: SkillMasteryView[];
  rationale: string;
  gateReasons: string[];
};

export type SkillMemoryView = {
  skillId: SkillId;
  mastery: number;
  attempts: number;
  successfulAttempts: number;
  recentScore: number | null;
  recentMistakes: string[];
  hintDependency: number;
  lastPracticed: string | null;
  nextReview: string | null;
  confidence: number;
  retention?: number;
  independence?: number;
  speedScore?: number;
  consistency?: number;
  difficultyRating?: number;
  evidenceCount?: number;
};

/** Exactly the structured context the engine retrieves per challenge. */
export type LearnerContext = {
  learner_level: number;
  current_mastery: Record<string, number>;
  weak_skills: SkillId[];
  strong_skills: SkillId[];
  recent_mistakes: string[];
  recent_challenges: { challengeId: string; status: VerificationStatus; score: number }[];
  relevant_previous_objects: WorldObjectView[];
  relevant_story_events: NarrativeEventView[];
  current_lab_state: { labTitle: string; cwd: string; objects: WorldObjectView[] };
  prerequisites: { challengeId: string; met: boolean }[];
  desired_difficulty: number;
};

/** Public (learner-facing) part of a challenge contract. */
export type ChallengeBrief = {
  id: string;
  order: number;
  title: string;
  storyIntro: string;
  objective: string;
  requiredSkills: SkillId[];
  allowedApproaches: string[];
  bannedShortcuts: string[];
  difficulty: number;
  prerequisites: string[];
  previousReferences: string[];
  xpReward: number;
  hintLevels: number;
};

export type AttemptView = {
  challengeId: string;
  status: VerificationStatus;
  attempts: number;
  bestScore: number;
  xpAwarded: number;
  completedAt: string | null;
  startedAt: string | null;
};

export type TerminalLine = { kind: "input" | "output" | "error" | "system"; text: string };

export type MissionState = {
  challenge: ChallengeBrief;
  context: LearnerContext;
  attempt: AttemptView;
  catalogue: (ChallengeBrief & { attempt: AttemptView | null; unlocked: boolean })[];
  transcript: TerminalLine[];
  cwd: string;
  hints: {
    level: number;
    text: string;
    stage?: "CONCEPT" | "DIRECTION" | "COMMAND" | "NEAR_SOLUTION" | "SOLUTION";
    teachingNote?: string;
  }[];
  hintsRemaining: number;
  skills: SkillMemoryView[];
  progression: { totalXp: number; level: number; challengesCompleted: number };
  lastVerification: Verification | null;
  lastObservation: Observation | null;
  nextChallengeId: string | null;
  trainingDecision?: {
    version?: string;
    mode: "REMEDIATION" | "GUIDED_PRACTICE" | "SPACED_REVIEW" | "TRANSFER" | "PROGRESSION" | "ASSESSMENT";
    primarySkill: SkillId;
    supportingSkills: SkillId[];
    difficulty: number;
    reason: string;
    evidence: string[];
    focusMistakes?: ObservationCategory[];
    constraints: string[];
    sourceStrategy?:
      | "targeted-patterns"
      | "review-patterns"
      | "transfer-patterns"
      | "progression-patterns"
      | undefined;
    masteryGate?: string;
    journeyPhase?: string;
    journeyNextSkills?: SkillId[];
  } | null;
};

export type AdaptiveExercise = {
  id: string;
  kind: "question" | "task" | "mission" | "mock_exam";
  title: string;
  scenario: string;
  objective: string;
  skills: SkillId[];
  difficulty: number;
  estimatedMinutes: number;
  sourceRefs: { id: string; name: string; url: string }[];
  evaluationFocus: string[];
  learnerReason: string;
  allowedApproaches?: string[];
  bannedShortcuts?: string[];
  hints?: string[];
  successStory?: string;
  failureStory?: string;
  remediation?: string[];
  /** Present when the generated exercise was persisted and can be launched. */
  launchableId?: string;
  /** Machine-verifiable plan for executable generated tasks. Kept out of learner UI. */
  evaluationPlan?: {
    objectives: Array<{
      label: string;
      path: string;
      objectType: "file" | "directory";
      permissions?: string;
      contentEquals?: string;
      contentContains?: string;
      mustNotExist?: boolean;
    }>;
    requiredCommandKinds?: string[];
    requireLoop?: boolean;
    minimumMutations?: number;
    requiredCapabilities?: Array<
      | "interactiveShell"
      | "streaming"
      | "resize"
      | "processes"
      | "services"
      | "environmentVariables"
      | "network"
      | "snapshots"
      | "pauseResume"
      | "packages"
    >;
  };
};

export type MissionAssessment = {
  grade: number;
  status: VerificationStatus;
  objectivesMet: number;
  objectivesTotal: number;
  attempts: number;
  commandCount: number;
  successfulCommands: number;
  failedCommands: number;
  blockedCommands: number;
  mutationOperations: number;
  usedLoop: boolean;
  hintsUsed: number;
  elapsedSeconds: number | null;
  mistakeBreakdown: Array<{ category: ObservationCategory; count: number }>;
  strengths: string[];
  nextActions: string[];
  learningSignal: "mastered" | "progressing" | "needs_practice" | "blocked";
  /** Deterministic evidence quality signals; these never alter verifier grade. */
  evidenceQuality?: {
    methodEvidenceScore: number;
    recoveryCount: number;
    independenceSignal: "high" | "developing" | "low";
    cleanExecution: boolean;
  };
  mastery?: SkillMasteryView[];
  progression?: ProgressionDecisionView;
  adaptivePlan?: {
    action: "RETRY_REMEDIATION" | "REVIEW_WEAK_SKILL" | "ADVANCE" | "MIXED_PRACTICE";
    desiredDifficulty: number;
    focusSkills: SkillId[];
    rationale: string;
    learnerMessage: string;
  };
  trainingDecision?: NonNullable<MissionState["trainingDecision"]>;
};

export type RunResult = {
  transcript: TerminalLine[];
  cwd: string;
  observation: Observation;
  verification: Verification;
  xpAwarded: number;
  state: MissionState;
};
