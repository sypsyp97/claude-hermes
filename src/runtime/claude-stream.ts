/**
 * Streaming Claude CLI wrapper.
 *
 * Spawns `claude ... --output-format stream-json --verbose`, pipes stdout
 * line-by-line through `createStreamParser`, and forwards StatusEvents to the
 * caller-supplied sink. On exit, closes the sink with the final outcome.
 *
 * Separate module (not folded into runner.ts) so callers that don't want live
 * status — the heartbeat path, the compact path, the evolve subagent — keep
 * using the buffered path in runner.ts without paying the parsing cost or
 * losing back-compat.
 */

import { spawn } from "node:child_process";
import { claudeArgv } from "./claude-cli";
import type { StatusSink } from "../status/sink";
import { createStreamParser, type StatusEvent } from "../status/stream";

export interface StreamingOptions {
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  sink: StatusSink;
  taskId: string;
  label: string;
  timeoutMs?: number;
  /**
   * Grace period between SIGTERM and SIGKILL on timeout. Without it, a child
   * that ignores SIGTERM keeps `proc.on("close")` pending forever and the
   * streaming caller hangs indefinitely. Default 5000ms; matches runner.ts.
   */
  killEscalationMs?: number;
  claudeBin?: string;
}

export interface StreamingResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  sessionId?: string;
  finalResult?: string;
}

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_KILL_ESCALATION_MS = 5000;

export async function runClaudeStreaming(opts: StreamingOptions): Promise<StreamingResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const killEscalationMs = opts.killEscalationMs ?? DEFAULT_KILL_ESCALATION_MS;
  const [bin, ...prefix] = claudeArgv({ override: opts.claudeBin, env: opts.env });
  const args = [...prefix, ...opts.args, "--output-format", "stream-json", "--verbose"];

  await opts.sink.open(opts.taskId, opts.label);

  const started = Date.now();
  return new Promise<StreamingResult>((resolveOuter) => {
    const proc = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const parser = createStreamParser();
    let stdout = "";
    let stderr = "";
    let sessionId: string | undefined;
    let finalResult: string | undefined;
    let errorShort: string | undefined;

    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {}
      killTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }, killEscalationMs);
      if (typeof killTimer.unref === "function") killTimer.unref();
    }, timeoutMs);

    async function handleEvents(events: StatusEvent[]): Promise<void> {
      for (const event of events) {
        if (event.kind === "task_start") {
          sessionId = event.sessionId ?? sessionId;
        } else if (event.kind === "task_complete") {
          sessionId = event.sessionId ?? sessionId;
          finalResult = event.result;
        } else if (event.kind === "error") {
          errorShort = event.message;
        }
        try {
          await opts.sink.update(event);
        } catch {
          // sink failures must never kill the Claude process
        }
      }
    }

    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      void handleEvents(parser.push(text));
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    async function finalize(exitCode: number, ok: boolean): Promise<void> {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      await handleEvents(parser.flush());
      const closeErrorShort = ok
        ? undefined
        : (errorShort ?? (stderr ? stderr.trim().slice(-200) : undefined));
      try {
        const closeResult: { ok: boolean; finalText?: string; errorShort?: string } = { ok };
        if (finalResult !== undefined) closeResult.finalText = finalResult;
        if (closeErrorShort !== undefined) closeResult.errorShort = closeErrorShort;
        await opts.sink.close(closeResult);
      } catch {
        // swallow — close failures must not mask the task result
      }
      const outResult: StreamingResult = {
        ok,
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      };
      if (sessionId !== undefined) outResult.sessionId = sessionId;
      if (finalResult !== undefined) outResult.finalResult = finalResult;
      resolveOuter(outResult);
    }

    proc.on("close", (code) => {
      const exitCode = code ?? -1;
      void finalize(exitCode, exitCode === 0);
    });
    proc.on("error", (err) => {
      stderr += String(err);
      void finalize(-1, false);
    });
  });
}
