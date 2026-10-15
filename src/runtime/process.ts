import { bridgeSignal } from "./bridge-context";
import { withExecutionSlot } from "./execution-budget";
import { taskProcessArgs, terminateProcessTree } from "./process-tree";
import { registerLeaseProcess, releaseLeaseProcess } from "./session-lease";

export interface ProcessOptions {
  timeoutMs: number;
  env?: Record<string, string | undefined>;
  cwd?: string;
  signal?: AbortSignal;
}

/** Async subprocess with cancellation, a deadline, and escalation before releasing its slot. */
export function runProcess(
  args: string[],
  options: ProcessOptions
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const signal = options.signal ?? bridgeSignal();
  return withExecutionSlot(async () => {
    signal?.throwIfAborted();
    const invocation = taskProcessArgs(args);
    const proc = Bun.spawn(invocation.args, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: invocation.leased ? "pipe" : "ignore",
      env: options.env,
      cwd: options.cwd,
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let timedOut = false;
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("Process cancelled"));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`Process timed out after ${options.timeoutMs / 1000}s`));
      }, options.timeoutMs);
    });
    void interrupted.catch(() => {});
    const output = Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    try {
      if (invocation.leased) {
        await registerLeaseProcess(proc.pid);
        signal?.throwIfAborted();
        if (timedOut) throw new Error("Process deadline elapsed before launch");
        proc.stdin!.write("run\n");
        proc.stdin!.end();
      }
      const [stdout, stderr] = await Promise.race([output, interrupted]);
      return { stdout, stderr, exitCode: proc.exitCode ?? 1 };
    } catch (error) {
      await terminateProcessTree(proc, proc.exited, 5000);
      return {
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: signal?.aborted ? 130 : timedOut ? 124 : 1,
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      if (invocation.leased) await releaseLeaseProcess(proc.pid);
    }
  }, signal);
}
