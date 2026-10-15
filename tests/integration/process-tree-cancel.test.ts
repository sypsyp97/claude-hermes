import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../../src/runtime/process";
import { runClaudeStreaming } from "../../src/runtime/claude-stream";
import { cancelConversation, withActiveConversation } from "../../src/runtime/conversation-controls";
import type { SessionTarget } from "../../src/runtime/session-target";
import { createFakeSink } from "../../src/status/sink";

// Each fixture publishes its PID before readiness, and has a final watchdog in
// addition to test cleanup. The tool inherits the CLI's process group and pipes.
const FIXTURE = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [role, dir] = process.argv.slice(2);
const file = name => join(dir, name);
setTimeout(() => process.exit(99), 20_000);
writeFileSync(file(role + ".pid"), String(process.pid));
if (role === "tool") {
  if (process.platform !== "win32") {
    process.on("SIGTERM", () => writeFileSync(file("tool-term"), "ignored"));
  }
  writeFileSync(file("tool-ready"), "ready");
  while (!existsSync(file("marker-release"))) await Bun.sleep(10);
  const notBefore = Number(readFileSync(file("marker-release"), "utf8"));
  while (Date.now() < notBefore) await Bun.sleep(10);
  writeFileSync(file("late-marker"), "tool survived interruption");
} else if (role === "parent") {
  if (process.platform !== "win32") process.on("SIGTERM", () => process.exit(0));
  const tool = Bun.spawn([process.execPath, process.argv[1], "tool", dir], {
    stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  writeFileSync(file("tool.pid"), String(tool.pid));
  tool.unref();
  while (!existsSync(file("tool-ready"))) await Bun.sleep(10);
  writeFileSync(file("parent-ready"), "ready");
  process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:"victim"}) + "\\n");
} else {
  writeFileSync(file("companion-ready"), "ready");
  while (!existsSync(file("finish"))) await Bun.sleep(10);
  writeFileSync(file("completed"), "complete");
  process.stdout.write(JSON.stringify({type:"result",subtype:"success",result:"complete"}) + "\\n");
  process.exit(0);
}
`;

type Runtime = "buffered" | "streaming";
type Interruption = "cancel" | "timeout";

async function waitFor(check: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}

async function bounded<T>(work: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // A dead orphan may remain a zombie briefly, especially under WSL's init.
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat[stat.lastIndexOf(")") + 2] !== "Z";
    }
    if (process.platform === "darwin") {
      const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
        .stdout.toString()
        .trim();
      return stat.length > 0 && !stat.startsWith("Z");
    }
    return true;
  } catch {
    return false;
  }
}

function pidIn(dir: string, role: string): number {
  return Number(readFileSync(join(dir, `${role}.pid`), "utf8"));
}

for (const runtime of ["buffered", "streaming"] satisfies Runtime[]) {
  for (const interruption of ["cancel", "timeout"] satisfies Interruption[]) {
    test(`${runtime} ${interruption} waits for its tool tree and preserves other conversations`, async () => {
      const root = await mkdtemp(join(tmpdir(), "hermes-process-tree-"));
      const victim = join(root, "victim");
      const companion = join(root, "companion");
      const unrelated = join(root, "unrelated");
      const script = join(root, "fake-claude.js");
      const dirs = [victim, companion, unrelated];
      const work: Promise<unknown>[] = [];
      const pids = new Set<number>();
      const target = (key: string): SessionTarget => ({
        key,
        workspace: root,
        source: "cli",
        scope: "per-thread",
        memoryScope: "channel",
      });
      const victimTarget = target("victim");
      const companionTarget = target("companion");
      const graceMs = runtime === "buffered" ? 5000 : 100;
      const timeoutMs = interruption === "timeout" ? 2500 : 15_000;
      const sink = createFakeSink();
      let toolRunningAtClose: boolean | undefined;
      const close = sink.close;
      sink.close = async (result) => {
        toolRunningAtClose = running(pidIn(victim, "tool"));
        await close(result);
      };

      function launch(dir: string, role: string, deadlineMs: number) {
        return runtime === "buffered"
          ? runProcess([process.execPath, script, role, dir], { timeoutMs: deadlineMs })
          : runClaudeStreaming({
              args: [script, role, dir],
              claudeBin: process.execPath,
              cwd: root,
              timeoutMs: deadlineMs,
              killEscalationMs: graceMs,
              sink: role === "parent" ? sink : createFakeSink(),
              taskId: role,
              label: role,
            });
      }

      try {
        await Promise.all(dirs.map((dir) => mkdir(dir)));
        await writeFile(script, FIXTURE);
        // Leave the signal implicit here: conversation cancellation must reach
        // the real subprocess through the same bridge context as the runner.
        const victimWork = withActiveConversation(victimTarget, () => launch(victim, "parent", timeoutMs));
        const companionWork = withActiveConversation(companionTarget, () =>
          launch(companion, "companion", 15_000)
        );
        const unrelatedProcess = Bun.spawn([process.execPath, script, "companion", unrelated], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
        pids.add(unrelatedProcess.pid);
        work.push(victimWork, companionWork, unrelatedProcess.exited);
        await waitFor(
          () =>
            existsSync(join(victim, "parent-ready")) &&
            existsSync(join(companion, "companion-ready")) &&
            existsSync(join(unrelated, "companion-ready")),
          "all three processes and the tool to be ready"
        );
        const parentPid = pidIn(victim, "parent");
        const toolPid = pidIn(victim, "tool");
        const companionPid = pidIn(companion, "companion");
        expect(running(parentPid)).toBe(true);
        expect(running(toolPid)).toBe(true);
        if (process.platform !== "win32") {
          process.kill(toolPid, "SIGTERM");
          await waitFor(() => existsSync(join(victim, "tool-term")), "tool to ignore SIGTERM");
          expect(running(toolPid)).toBe(true);
        }

        if (interruption === "cancel") expect(cancelConversation(victimTarget)).toBe(true);
        const result = await bounded(victimWork, "interrupted runtime to settle");
        const atReturn = {
          parentRunning: running(parentPid),
          toolRunning: running(toolPid),
          companionRunning: running(companionPid),
          unrelatedRunning: running(unrelatedProcess.pid),
        };
        // Work during TERM grace is permitted. Open the side-effect barrier
        // only after the runtime reports completion and its tree is inspected.
        const markerAt = Date.now() + 300;
        writeFileSync(join(victim, "marker-release"), String(markerAt));
        // Release unaffected work even on RED, proving it can still finish.
        writeFileSync(join(companion, "finish"), "go");
        writeFileSync(join(unrelated, "finish"), "go");
        const companionResult = await bounded(companionWork, "other conversation to finish");
        const unrelatedExit = await bounded(unrelatedProcess.exited, "unrelated process to finish");
        await waitFor(() => Date.now() >= markerAt + 100, "post-return marker deadline", 9000);

        expect({
          exitCode: result.exitCode,
          ...atReturn,
          lateMarker: existsSync(join(victim, "late-marker")),
          companionExit: companionResult.exitCode,
          companionCompleted: existsSync(join(companion, "completed")),
          unrelatedExit,
          unrelatedCompleted: existsSync(join(unrelated, "completed")),
          ...(runtime === "streaming" ? { toolRunningAtClose } : {}),
        }).toEqual({
          exitCode: interruption === "cancel" ? 130 : 124,
          parentRunning: false,
          toolRunning: false,
          companionRunning: true,
          unrelatedRunning: true,
          lateMarker: false,
          companionExit: 0,
          companionCompleted: true,
          unrelatedExit: 0,
          unrelatedCompleted: true,
          ...(runtime === "streaming" ? { toolRunningAtClose: false } : {}),
        });
      } finally {
        cancelConversation(victimTarget);
        cancelConversation(companionTarget);
        for (const dir of dirs) {
          for (const role of ["parent", "tool", "companion"]) {
            if (existsSync(join(dir, `${role}.pid`))) pids.add(pidIn(dir, role));
          }
        }
        for (const pid of pids) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
        await waitFor(() => [...pids].every((pid) => !running(pid)), "fixture cleanup");
        await bounded(Promise.allSettled(work), "runtime cleanup", 2000);
        await rm(root, { recursive: true, force: true });
      }
    }, 20_000);
  }
}
