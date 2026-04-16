/**
 * Top-level evolve driver. One call = one iteration:
 *
 *   1. Aggregate pending tasks (local + optional GitHub).
 *   2. Planner picks the next one (or returns null).
 *   3. Executor spawns a Claude subagent to implement it.
 *   4. Gate runs `bun run verify`.
 *   5. Green → commit. Red → revert. Either way, journal.
 *
 * Callers schedule this behind a cron trigger (`.github/workflows/evolve.yml`
 * or a local cron job file). Tests use the runner hooks to inject fakes.
 */

import type { Database } from "../state/db";
import { readLocalEvolveInbox, type PendingTask } from "./input";
import { pickNext } from "./planner";
import { executeSelfEdit, type ExecuteOptions, type ExecuteResult } from "./executor";
import { commitChanges, revertAll, runVerify, type GateRunners, type VerifyResult } from "./gate";
import { recordEvent } from "./journal";

export type Outcome = "no-tasks" | "exec-failed" | "verify-failed" | "committed";

export interface EvolveIterationResult {
  outcome: Outcome;
  task?: PendingTask;
  sha?: string | null;
  verify?: VerifyResult;
  exec?: ExecuteResult;
}

export interface LoopHooks {
  gate?: GateRunners;
  runExec?(opts: ExecuteOptions): Promise<ExecuteResult>;
  readTasks?(cwd: string): Promise<PendingTask[]>;
  buildPrompt?(task: PendingTask): string;
  commitMessage?(task: PendingTask): string;
}

export async function evolveOnce(
  db: Database,
  cwd: string = process.cwd(),
  hooks: LoopHooks = {},
): Promise<EvolveIterationResult> {
  const tasks = await (hooks.readTasks ?? readLocalEvolveInbox)(cwd);
  const task = pickNext(tasks);
  if (!task) {
    await recordEvent(db, { kind: "evolve.skip", slot: "idle", summary: "no pending tasks" }, cwd);
    return { outcome: "no-tasks" };
  }

  await recordEvent(
    db,
    { kind: "evolve.plan", slot: task.id, summary: task.title, details: { votes: task.votes } },
    cwd,
  );

  const prompt = (hooks.buildPrompt ?? defaultPrompt)(task);
  const exec = await (hooks.runExec ?? executeSelfEdit)({ prompt, cwd });

  await recordEvent(
    db,
    {
      kind: "evolve.exec.done",
      slot: task.id,
      summary: exec.ok ? "subagent finished green" : "subagent exited non-zero",
      details: { exitCode: exec.exitCode, durationMs: exec.durationMs },
    },
    cwd,
  );

  if (!exec.ok) {
    await revertAll(cwd, hooks.gate);
    return { outcome: "exec-failed", task, exec };
  }

  const verify = await runVerify(cwd, hooks.gate);
  if (!verify.ok) {
    await revertAll(cwd, hooks.gate);
    await recordEvent(
      db,
      {
        kind: "evolve.revert",
        slot: task.id,
        summary: `verify failed (exit ${verify.exitCode})`,
        details: { stderrTail: verify.stderr.slice(-1024) },
      },
      cwd,
    );
    return { outcome: "verify-failed", task, verify, exec };
  }

  const message = (hooks.commitMessage ?? defaultCommitMessage)(task);
  const sha = await commitChanges(cwd, message, hooks.gate);
  await recordEvent(
    db,
    {
      kind: "evolve.commit",
      slot: task.id,
      summary: sha ? `committed as ${sha.slice(0, 10)}` : "no changes to commit",
      details: { sha, durationMs: verify.durationMs },
    },
    cwd,
  );
  return { outcome: "committed", task, sha, verify, exec };
}

function defaultPrompt(task: PendingTask): string {
  return [
    "You are Claude Hermes running inside its own repository.",
    "Pick up the following pending task and implement it.",
    "Rules: minimal diff, no unrelated refactors, keep `bun run verify` green.",
    "",
    `# Task ${task.id}`,
    `title: ${task.title}`,
    `votes: ${task.votes}`,
    "",
    task.body,
  ].join("\n");
}

function defaultCommitMessage(task: PendingTask): string {
  return `evolve: ${task.title}\n\nSource: ${task.source} (${task.id}, votes=${task.votes})`;
}
