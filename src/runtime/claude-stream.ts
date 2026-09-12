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
import { bridgeSignal } from "./bridge-context";
import { withExecutionSlot } from "./execution-budget";
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
  signal?: AbortSignal;
  onEvent?: (event: StatusEvent) => void;
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
  const signal = opts.signal ?? bridgeSignal();
  return withExecutionSlot(async () => {
    const started = Date.now();
    try {
      return await stream({ ...opts, signal });
    } catch (error) {
      const stderr = signal?.aborted ? "Claude session cancelled" : String(error);
      // Once admitted, an abort or synchronous spawn failure must finish an
      // opened sink, including its heartbeat, even if no child was created.
      try {
        await opts.sink.close({ ok: false, errorShort: stderr });
      } catch {
        /* best-effort status */
      }
      return {
        ok: false,
        exitCode: signal?.aborted ? 130 : -1,
        stdout: "",
        stderr,
        durationMs: Date.now() - started,
      };
    }
  }, signal);
}

async function stream(opts: StreamingOptions): Promise<StreamingResult> {
  const signal = opts.signal ?? bridgeSignal();
  signal?.throwIfAborted();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const killEscalationMs = opts.killEscalationMs ?? DEFAULT_KILL_ESCALATION_MS;
  const [bin, ...prefix] = claudeArgv({ override: opts.claudeBin, env: opts.env });
  const args = [
    ...prefix,
    ...opts.args,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];

  try {
    await opts.sink.open(opts.taskId, opts.label);
  } catch {
    /* Best-effort status. */
  }

  const started = Date.now();
  signal?.throwIfAborted();
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
    let interruptedCode: number | undefined;
    let exited = false;
    const closeInterruptedPipes = () => {
      if (!exited || interruptedCode === undefined) return;
      // Descendants may inherit these pipes after the direct CLI child exits.
      // Cancellation must not wait for those unrelated handles to close.
      proc.stdout?.destroy();
      proc.stderr?.destroy();
    };
    const interrupt = (code: number, message: string) => {
      if (interruptedCode !== undefined) return;
      interruptedCode = code;
      stderr += message;
      closeInterruptedPipes();
      try {
        proc.kill("SIGTERM");
      } catch {}
      killTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }, killEscalationMs);
      if (typeof killTimer.unref === "function") killTimer.unref();
    };
    const timer = setTimeout(
      () => interrupt(124, `Claude session timed out after ${timeoutMs / 1000}s`),
      timeoutMs
    );
    const onAbort = () => interrupt(130, "Claude session cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

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
          opts.onEvent?.(event);
          await opts.sink.update(event);
        } catch {
          // sink failures must never kill the Claude process
        }
      }
    }

    let pendingEvents = Promise.resolve();
    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", (text: string) => {
      stdout += text;
      const events = parser.push(text);
      pendingEvents = pendingEvents.then(() => handleEvents(events));
    });
    proc.stderr?.on("data", (text: string) => {
      stderr += text;
    });

    let finalized = false;
    async function finalize(processExitCode: number, processOk: boolean): Promise<void> {
      if (finalized) return;
      finalized = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (killTimer) clearTimeout(killTimer);
      await pendingEvents;
      await handleEvents(parser.flush());
      const ok = processOk && !errorShort && interruptedCode === undefined;
      const exitCode = interruptedCode ?? (errorShort ? processExitCode || 1 : processExitCode);
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

    proc.on("exit", () => {
      exited = true;
      closeInterruptedPipes();
    });
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
