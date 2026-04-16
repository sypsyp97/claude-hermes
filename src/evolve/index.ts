/**
 * Barrel for the evolve loop. Importers take this surface from here so
 * internal reorganisation (e.g. splitting the planner into multiple policies)
 * doesn't ripple out.
 */

export {
  fromGitHubIssues,
  readLocalEvolveInbox,
  type GitHubIssue,
  type PendingTask,
} from "./input";
export { pickNext, rank } from "./planner";
export { commitChanges, revertAll, runVerify, type GateRunners, type VerifyResult } from "./gate";
export { executeSelfEdit, type ExecuteOptions, type ExecuteResult } from "./executor";
export { recordEvent, journalFile, type EvolveEvent, type EvolveEventKind } from "./journal";
export {
  evolveOnce,
  type EvolveIterationResult,
  type LoopHooks,
  type Outcome,
} from "./loop";
