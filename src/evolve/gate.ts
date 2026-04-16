/**
 * Gate — commits on green verify, reverts on red. Thin wrapper around
 * `bun run verify`, `git commit`, and `git restore` so tests can inject
 * a fake runner.
 */

import { spawn } from "node:child_process";

export interface VerifyResult {
  ok: boolean;
  durationMs: number;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GateRunners {
  runVerify?(cwd: string): Promise<VerifyResult>;
  runGit?(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }>;
}

export async function runVerify(cwd: string, runners: GateRunners = {}): Promise<VerifyResult> {
  if (runners.runVerify) return runners.runVerify(cwd);
  return runProcess("bun", ["run", "verify"], cwd);
}

export async function commitChanges(
  cwd: string,
  message: string,
  runners: GateRunners = {},
): Promise<string | null> {
  const run = runners.runGit ?? defaultGit;
  const status = await run(cwd, ["status", "--porcelain"]);
  if (!status.stdout.trim()) return null;

  await run(cwd, ["add", "-A"]);
  const commit = await run(cwd, ["commit", "-m", message]);
  if (!commit.ok) return null;
  const sha = await run(cwd, ["rev-parse", "HEAD"]);
  return sha.stdout.trim();
}

export async function revertAll(cwd: string, runners: GateRunners = {}): Promise<void> {
  const run = runners.runGit ?? defaultGit;
  await run(cwd, ["restore", "--staged", "."]);
  await run(cwd, ["restore", "."]);
  await run(cwd, ["clean", "-fd"]);
}

async function defaultGit(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const r = await runProcess("git", args, cwd);
  return { ok: r.ok, stdout: r.stdout, stderr: r.stderr };
}

function runProcess(bin: string, args: string[], cwd: string): Promise<VerifyResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const proc = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => {
      resolve({
        ok: code === 0,
        exitCode: code ?? -1,
        durationMs: Date.now() - started,
        stdout,
        stderr,
      });
    });
    proc.on("error", (err) => {
      resolve({
        ok: false,
        exitCode: -1,
        durationMs: Date.now() - started,
        stdout,
        stderr: stderr + String(err),
      });
    });
  });
}
