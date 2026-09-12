import { bridgeSignal } from "./bridge-context";
import { withExecutionSlot } from "./execution-budget";

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
    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: options.env,
      cwd: options.cwd,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("Process cancelled"));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      timer = setTimeout(
        () => reject(new Error(`Process timed out after ${options.timeoutMs / 1000}s`)),
        options.timeoutMs
      );
    });
    try {
      const [stdout, stderr] = await Promise.race([
        Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
        interrupted,
      ]);
      return { stdout, stderr, exitCode: proc.exitCode ?? 1 };
    } catch (error) {
      try {
        proc.kill("SIGTERM");
      } catch {}
      const escalation = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }, 5000);
      await proc.exited;
      clearTimeout(escalation);
      return {
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: signal?.aborted ? 130 : 124,
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }, signal);
}
