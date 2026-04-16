/**
 * Executor — spawns a Claude CLI subagent with a self-edit prompt, waits
 * for it to finish, returns stdout/stderr. The CLI path routes through
 * `src/runtime/claude-cli.ts::claudeArgv()` so tests can inject a fake via
 * `HERMES_CLAUDE_BIN`.
 */

import { spawn } from "node:child_process";
import { claudeArgv } from "../runtime/claude-cli";

export interface ExecuteOptions {
  prompt: string;
  systemPrompt?: string;
  cwd: string;
  timeoutMs?: number;
  claudeBin?: string;
}

export interface ExecuteResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export async function executeSelfEdit(opts: ExecuteOptions): Promise<ExecuteResult> {
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const [bin, ...prefix] = claudeArgv({ override: opts.claudeBin });
  const args = [...prefix, "-p", opts.prompt, "--output-format", "text"];
  if (opts.systemPrompt) {
    args.push("--append-system-prompt", opts.systemPrompt);
  }

  const started = Date.now();
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => proc.kill("SIGTERM"), timeoutMs);

    proc.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        exitCode: code ?? -1,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: -1,
        stdout,
        stderr: stderr + String(err),
        durationMs: Date.now() - started,
      });
    });
  });
}
