#!/usr/bin/env bun
/**
 * Autonomous-loop driver skeleton.
 *
 * Phase 0 ships the scaffolding; later phases (especially the learned-skill
 * pipeline in Phase 6) plug real task sources and rollback strategies into it.
 *
 * Contract:
 *   - A `Task` is (id, description, prompt-for-agent, acceptance criterion).
 *   - `runVerify()` is the single source of truth for green/red.
 *   - Loop: pick task -> agent edits code -> runVerify -> commit or rollback.
 *
 * For now this file exposes the public types + an in-memory queue and uses
 * `scripts/verify.ts` under the hood. Claude Code subagents that want to drive
 * the loop call `runVerify()` after each edit and decide whether to keep or
 * discard the changes.
 */

import { spawn } from "node:child_process";

export interface VerifySummary {
  ok: boolean;
  startedAt: string;
  results: Array<{
    name: string;
    ok: boolean;
    exitCode: number;
    durationMs: number;
    stdoutTail: string;
    stderrTail: string;
  }>;
}

export function runVerify(args: string[] = []): Promise<VerifySummary> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", "scripts/verify.ts", "--json", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: process.env,
    });
    const chunks: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d) => chunks.push(Buffer.from(d)));
    child.stderr.on("data", (d) => err.push(Buffer.from(d)));
    child.on("error", reject);
    child.on("close", () => {
      const body = Buffer.concat(chunks).toString("utf8").trim();
      try {
        const lastJsonStart = body.lastIndexOf("{");
        const json = body.slice(lastJsonStart);
        resolve(JSON.parse(json) as VerifySummary);
      } catch (parseErr) {
        reject(
          new Error(
            `verify output not parseable: ${parseErr instanceof Error ? parseErr.message : parseErr}\nstdout tail: ${body.slice(-400)}\nstderr tail: ${Buffer.concat(err).toString("utf8").slice(-400)}`
          )
        );
      }
    });
  });
}

export interface Task {
  id: string;
  description: string;
  metadata?: Record<string, unknown>;
}

export class TaskQueue {
  private readonly tasks: Task[] = [];
  private readonly done: Task[] = [];
  push(t: Task) {
    this.tasks.push(t);
  }
  pull(): Task | null {
    return this.tasks.shift() ?? null;
  }
  complete(t: Task) {
    this.done.push(t);
  }
  pending() {
    return this.tasks.length;
  }
}

async function demo() {
  const summary = await runVerify(["--fast"]);
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  process.exit(summary.ok ? 0 : 1);
}

if (import.meta.main) {
  demo().catch((err) => {
    process.stderr.write(`iterate error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
