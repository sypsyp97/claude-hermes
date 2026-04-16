#!/usr/bin/env bun
/**
 * `bun run verify` — single harness entry-point the autonomous loop uses.
 *
 * Runs the full pipeline (typecheck → lint → unit → smoke → integration) or a
 * fast subset (typecheck → unit) and emits machine-readable JSON on stdout so
 * callers never have to parse test-runner chatter.
 *
 *   bun run verify           # full
 *   bun run verify --fast    # pre-commit / inner loop
 *   bun run verify --json    # JSON to stdout, no human lines
 *   bun run verify --only=typecheck,unit  # pick steps
 *
 * Exit code is 0 only if every selected step passed.
 */

import { spawn } from "node:child_process";

type StepName = "typecheck" | "lint" | "unit" | "smoke" | "integration";

interface StepResult {
  name: StepName;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  skipped?: boolean;
}

interface StepDef {
  name: StepName;
  command: string;
  args: string[];
}

const STEPS: StepDef[] = [
  { name: "typecheck", command: "bun", args: ["x", "tsc", "--noEmit"] },
  { name: "lint", command: "bun", args: ["x", "@biomejs/biome", "check", "src", "tests", "scripts"] },
  { name: "unit", command: "bun", args: ["test", "src"] },
  { name: "smoke", command: "bun", args: ["test", "tests/smoke"] },
  { name: "integration", command: "bun", args: ["test", "tests/integration"] },
];

const FAST_STEPS: StepName[] = ["typecheck", "unit"];

function parseArgs(argv: string[]): {
  fast: boolean;
  jsonOnly: boolean;
  only: StepName[] | null;
} {
  let fast = false;
  let jsonOnly = false;
  let only: StepName[] | null = null;
  for (const a of argv) {
    if (a === "--fast") fast = true;
    else if (a === "--json") jsonOnly = true;
    else if (a.startsWith("--only=")) {
      only = a.slice("--only=".length).split(",").filter(Boolean) as StepName[];
    }
  }
  return { fast, jsonOnly, only };
}

function runStep(step: StepDef): Promise<StepResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(step.command, step.args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: process.env,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on("data", (d) => stdoutChunks.push(Buffer.from(d)));
    child.stderr?.on("data", (d) => stderrChunks.push(Buffer.from(d)));
    child.on("error", (err) => {
      resolve({
        name: step.name,
        ok: false,
        exitCode: 127,
        durationMs: Date.now() - started,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: `spawn error: ${err.message}\n${Buffer.concat(stderrChunks).toString("utf8")}`,
      });
    });
    child.on("close", (code) => {
      const exit = code ?? 1;
      resolve({
        name: step.name,
        ok: exit === 0,
        exitCode: exit,
        durationMs: Date.now() - started,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

function selectSteps(args: ReturnType<typeof parseArgs>): StepDef[] {
  if (args.only && args.only.length > 0) {
    return STEPS.filter((s) => args.only!.includes(s.name));
  }
  if (args.fast) {
    return STEPS.filter((s) => FAST_STEPS.includes(s.name));
  }
  return STEPS;
}

function human(result: StepResult): string {
  const status = result.skipped ? "SKIP" : result.ok ? "PASS" : "FAIL";
  return `[${status}] ${result.name.padEnd(12)} ${result.durationMs}ms${result.ok ? "" : ` (exit ${result.exitCode})`}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const steps = selectSteps(args);
  const results: StepResult[] = [];
  let allOk = true;

  for (const step of steps) {
    if (!args.jsonOnly) process.stderr.write(`> ${step.name}...\n`);
    const result = await runStep(step);
    results.push(result);
    if (!args.jsonOnly) process.stderr.write(human(result) + "\n");
    if (!result.ok) allOk = false;
  }

  const summary = {
    ok: allOk,
    startedAt: new Date().toISOString(),
    results: results.map((r) => ({
      name: r.name,
      ok: r.ok,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      stdoutTail: r.stdout.split("\n").slice(-20).join("\n"),
      stderrTail: r.stderr.split("\n").slice(-20).join("\n"),
    })),
  };

  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`verify failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
