import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat[stat.lastIndexOf(")") + 2] !== "Z";
    }
    const state = Bun.spawnSync(["/bin/ps", "-o", "stat=", "-p", String(pid)])
      .stdout.toString()
      .trim();
    return state.length > 0 && !state.startsWith("Z");
  } catch {
    return false;
  }
}

async function bounded<T>(work: Promise<T>, timeoutMs = 12_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Inspection fixture did not settle")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// A separate worker owns the altered PATH. The fake CLI and its tool run through
// the real wrappers; the tool inherits the detached leader's group and pipes.
const WORKER = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runProcess } from ${JSON.stringify(new URL("../../src/runtime/process.ts", import.meta.url).href)};
import { runClaudeStreaming } from ${JSON.stringify(new URL("../../src/runtime/claude-stream.ts", import.meta.url).href)};
import { ProcessTreeCleanupError } from ${JSON.stringify(new URL("../../src/runtime/process-tree.ts", import.meta.url).href)};
import { createFakeSink } from ${JSON.stringify(new URL("../../src/status/sink.ts", import.meta.url).href)};
const [role, runtime, dir] = process.argv.slice(2);
const file = name => join(dir, name);
const pid = role => Number(readFileSync(file(role + ".pid"), "utf8"));
${running.toString()}
${bounded.toString()}
async function waitFor(check, label) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Fixture readiness failed: " + label);
    await Bun.sleep(10);
  }
}
if (role !== "worker") {
  setTimeout(() => process.exit(99), 20_000);
  writeFileSync(file(role + ".pid"), String(process.pid));
  process.on("SIGTERM", () => {
    writeFileSync(file(role + "-term"), "received");
    if (role === "leader") process.exit(0);
  });
  if (role === "leader") {
    const tool = Bun.spawn([process.execPath, process.argv[1], "tool", runtime, dir], {
      stdin: "ignore", stdout: "inherit", stderr: "inherit",
    });
    writeFileSync(file("tool.pid"), String(tool.pid));
    tool.unref();
    await waitFor(() => existsSync(file("tool-ready")), "tool");
  }
  writeFileSync(file(role + "-ready"), "ready");
  setInterval(() => {}, 1000);
} else {
  const abort = new AbortController();
  const sink = createFakeSink();
  let toolRunningAtClose;
  const close = sink.close;
  sink.close = async result => {
    toolRunningAtClose = running(pid("tool"));
    await close(result);
  };
  const work = (runtime === "buffered"
    ? runProcess([process.execPath, process.argv[1], "leader", runtime, dir], {
        timeoutMs: 15_000, signal: abort.signal,
      })
    : runClaudeStreaming({
        claudeBin: process.execPath,
        args: [process.argv[1], "leader", runtime, dir],
        cwd: dir, signal: abort.signal, timeoutMs: 15_000,
        killEscalationMs: 100, sink, taskId: "inspection", label: "inspection",
      })
  ).then(
    result => ({ rejected: false, cleanupError: false, ...result }),
    error => ({ rejected: true, cleanupError: error instanceof ProcessTreeCleanupError })
  );
  try {
    await waitFor(() => existsSync(file("leader-ready")), "leader and tool");
    const leader = pid("leader");
    const tool = pid("tool");
    const group = child => Number(Bun.spawnSync(["/bin/ps", "-o", "pgid=", "-p", String(child)]).stdout.toString().trim());
    if (!running(leader) || !running(tool) || group(leader) !== leader || group(tool) !== leader) {
      throw new Error("Fixture did not create a live detached owned group");
    }
    abort.abort();
    const result = await bounded(work, 9000);
    writeFileSync(file("result.json"), JSON.stringify({
      ...result,
      inspectionAttempted: existsSync(file("ps-called")),
      leaderTerm: existsSync(file("leader-term")),
      toolTerm: existsSync(file("tool-term")),
      leaderRunning: running(leader),
      toolRunning: running(tool),
      ...(runtime === "streaming" ? {
        toolRunningAtClose,
        sinkFailure: sink.calls.some(call => call.kind === "close" && !call.result.ok && !!call.result.errorShort),
      } : {}),
    }));
  } finally {
    abort.abort();
    for (const role of ["leader", "tool"]) {
      if (!existsSync(file(role + ".pid"))) continue;
      const child = pid(role);
      if (role === "leader") {
        try { process.kill(-child, "SIGKILL"); } catch {}
      }
      try { process.kill(child, "SIGKILL"); } catch {}
    }
    await waitFor(() => ["leader", "tool"].every(role => !existsSync(file(role + ".pid")) || !running(pid(role))), "cleanup");
    await bounded(work, 2000);
  }
}
`;

const posixTest = process.platform === "win32" ? test.skip : test;
for (const runtime of ["buffered", "streaming"] as const) {
  for (const inspection of ["empty", "malformed"] as const) {
    posixTest(
      `${runtime} rejects ${inspection} successful ps output and kills the owned tool`,
      async () => {
        const root = await mkdtemp(join(tmpdir(), "hermes-inspection-"));
        const bin = join(root, "bin");
        const script = join(root, "worker.js");
        let worker: ReturnType<typeof Bun.spawn> | undefined;
        try {
          await mkdir(bin);
          await writeFile(script, WORKER);
          // Wait for both TERM handlers so the leader has exited and the stubborn
          // tool is proven to have received TERM before returning the bad snapshot.
          await writeFile(
            join(bin, "ps"),
            `#!/bin/sh
printf 'called\\n' >> "$HERMES_INSPECTION_ROOT/ps-called"
i=0
while [ ! -f "$HERMES_INSPECTION_ROOT/leader-term" ] || [ ! -f "$HERMES_INSPECTION_ROOT/tool-term" ]; do
  i=$((i + 1))
  [ "$i" -lt 300 ] || exit 71
  /bin/sleep 0.01
done
${inspection === "malformed" ? "printf 'not-a-pgid invalid-state\\n'" : ""}
exit 0
`
          );
          await chmod(join(bin, "ps"), 0o755);
          const launched = Bun.spawn([process.execPath, script, "worker", runtime, root], {
            env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, HERMES_INSPECTION_ROOT: root },
            detached: true,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          });
          worker = launched;
          const [exitCode, stderr] = await bounded(
            Promise.all([launched.exited, new Response(launched.stderr).text()])
          );
          expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
          const result = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
          expect(result).toMatchObject({
            inspectionAttempted: true,
            leaderTerm: true,
            toolTerm: true,
            leaderRunning: false,
            toolRunning: false,
            ...(runtime === "buffered"
              ? { rejected: true, cleanupError: true }
              : { rejected: false, ok: false, exitCode: -1, toolRunningAtClose: false, sinkFailure: true }),
          });
          if (runtime === "streaming") expect(result.stderr.length).toBeGreaterThan(0);
        } finally {
          const pids: number[] = [];
          for (const role of ["leader", "tool"]) {
            const file = join(root, `${role}.pid`);
            if (!existsSync(file)) continue;
            const pid = Number(readFileSync(file, "utf8"));
            pids.push(pid);
            if (role === "leader") {
              try {
                process.kill(-pid, "SIGKILL");
              } catch {}
            }
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }
          if (worker) {
            try {
              process.kill(-worker.pid, "SIGKILL");
            } catch {}
            worker.kill("SIGKILL");
          }
          const deadline = Date.now() + 2000;
          while (pids.some(running) && Date.now() < deadline) await Bun.sleep(10);
          expect(pids.some(running)).toBe(false);
          if (worker) await bounded(worker.exited, 2000);
          await rm(root, { recursive: true, force: true });
        }
      },
      20_000
    );
  }
}
