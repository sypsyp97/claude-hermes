import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
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
        timer = setTimeout(() => reject(new Error("Permission fixture did not settle")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Mutations stay in this worker. Every case owns a real detached POSIX child;
// only its negative PID receives EPERM. Cleanup uses the saved native APIs.
const WORKER = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runProcess } from ${JSON.stringify(new URL("../../src/runtime/process.ts", import.meta.url).href)};
import { ProcessTreeCleanupError } from ${JSON.stringify(new URL("../../src/runtime/process-tree.ts", import.meta.url).href)};
const [role, point, snapshot, interruption, dir] = process.argv.slice(2);
const file = name => join(dir, name);
const nativeKill = process.kill.bind(process);
const nativeSnapshot = Bun.spawnSync.bind(Bun);
${running.toString()}
${bounded.toString()}
async function waitFor(check, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
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
    if (role === "owned" && point !== "SIGKILL" && ["absent", "zombie"].includes(snapshot)) process.exit(0);
  });
  writeFileSync(file(role + "-ready"), "ready");
  if (role === "unrelated") {
    await waitFor(() => existsSync(file("unrelated-release")), "unrelated release", 15_000);
    writeFileSync(file("unrelated-completed"), "complete");
    process.exit(0);
  }
  setInterval(() => {}, 1000);
} else {
  const deadOutcome = ["absent", "zombie"].includes(snapshot);
  const abort = new AbortController();
  const unrelated = Bun.spawn([process.execPath, process.argv[1], "unrelated", point, snapshot, interruption, dir], {
    detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  let owned;
  let injected = 0;
  let nativeInspections = 0;
  const groupSignals = [];
  const permission = () => Object.assign(new Error("Injected owned-group permission denial"), { code: "EPERM" });
  const deadBarrier = () => {
    const deadline = Date.now() + 3000;
    while (running(owned)) {
      if (Date.now() >= deadline) throw new Error("Owned child did not die before EPERM injection");
      Bun.sleepSync(5);
    }
  };
  const work = runProcess([process.execPath, process.argv[1], "owned", point, snapshot, interruption, dir], {
    timeoutMs: interruption === "timeout" ? 1500 : 15_000, signal: abort.signal,
  }).then(
    result => ({ rejected: false, cleanupError: false, ...result }),
    error => ({ rejected: true, cleanupError: error instanceof ProcessTreeCleanupError, code: error.code })
  );
  try {
    await waitFor(() => existsSync(file("owned-ready")) && existsSync(file("unrelated-ready")), "both detached children");
    owned = Number(readFileSync(file("owned.pid"), "utf8"));
    const group = pid => Number(nativeSnapshot(["/bin/ps", "-o", "pgid=", "-p", String(pid)]).stdout.toString().trim());
    if (!running(owned) || !running(unrelated.pid) || group(owned) !== owned || group(unrelated.pid) !== unrelated.pid) {
      throw new Error("Fixture did not create distinct live owned and unrelated groups");
    }
    process.kill = (pid, signal) => {
      if (pid >= 0) return nativeKill(pid, signal);
      groupSignals.push({ pid, signal });
      if (pid !== -owned) throw new Error("Runtime attempted to signal an unowned group");
      if ((point === "probe" && signal === 0) || signal === point) {
        if (deadOutcome) {
          if (signal !== 0) nativeKill(pid, signal);
          deadBarrier();
        }
        injected++;
        throw permission();
      }
      if (!deadOutcome && signal === "SIGKILL") throw permission();
      return nativeKill(pid, signal);
    };
    Bun.spawnSync = (args, options) => {
      if (args[1] !== "-axo") return nativeSnapshot(args, options);
      if (args[0] === "/bin/ps") {
        nativeInspections++;
        if (snapshot === "failed") return { exitCode: 71, stdout: Buffer.from(""), stderr: Buffer.from("denied") };
        if (snapshot === "empty") return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
        if (snapshot === "malformed") return { exitCode: 0, stdout: Buffer.from("invalid pgid state\\n"), stderr: Buffer.from("") };
        if (snapshot === "zombie" && injected > 0) {
          // The actual owned child has crossed deadBarrier. Retain its zombie
          // row plus an unrelated live row to exercise strict group matching.
          return { exitCode: 0, stdout: Buffer.from(owned + " Z+\\n" + unrelated.pid + " S\\n"), stderr: Buffer.from("") };
        }
      }
      return nativeSnapshot(args, options);
    };
    if (interruption === "cancel") abort.abort();
    const result = await bounded(work);
    const atReturn = {
      ownedRunning: running(owned), unrelatedRunning: running(unrelated.pid),
      unrelatedTerm: existsSync(file("unrelated-term")),
    };
    writeFileSync(file("unrelated-release"), "go");
    await bounded(unrelated.exited, 2000);
    writeFileSync(file("result.json"), JSON.stringify({
      ...result, ...atReturn, injected, nativeInspections,
      foreignGroupSignals: groupSignals.filter(call => call.pid !== -owned),
      unrelatedCompleted: existsSync(file("unrelated-completed")),
    }));
  } finally {
    process.kill = nativeKill;
    Bun.spawnSync = nativeSnapshot;
    abort.abort();
    if (owned === undefined && existsSync(file("owned.pid"))) owned = Number(readFileSync(file("owned.pid"), "utf8"));
    for (const pid of [owned, unrelated.pid]) {
      if (pid === undefined) continue;
      try { nativeKill(-pid, "SIGKILL"); } catch {}
    }
    await waitFor(() => [owned, unrelated.pid].every(pid => pid === undefined || !running(pid)), "fixture cleanup");
    await bounded(Promise.all([work, unrelated.exited]), 2000);
  }
}
`;

const cases = [
  { point: "probe", snapshot: "absent", interruption: "cancel" },
  { point: "probe", snapshot: "zombie", interruption: "timeout" },
  { point: "SIGTERM", snapshot: "absent", interruption: "timeout" },
  { point: "SIGTERM", snapshot: "zombie", interruption: "cancel" },
  { point: "SIGKILL", snapshot: "absent", interruption: "cancel" },
  { point: "SIGKILL", snapshot: "zombie", interruption: "timeout" },
  { point: "SIGTERM", snapshot: "live", interruption: "cancel" },
  { point: "probe", snapshot: "live", interruption: "cancel" },
  { point: "probe", snapshot: "failed", interruption: "cancel" },
  { point: "probe", snapshot: "empty", interruption: "cancel" },
  { point: "probe", snapshot: "malformed", interruption: "cancel" },
] as const;

const posixTest = process.platform === "win32" ? test.skip : test;
for (const { point, snapshot, interruption } of cases) {
  posixTest(
    `${point} EPERM with ${snapshot} native snapshot preserves ${interruption} cleanup semantics`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), "hermes-group-permission-"));
      const script = join(root, "worker.js");
      let worker: ReturnType<typeof Bun.spawn> | undefined;
      try {
        await writeFile(script, WORKER);
        const launched = Bun.spawn(
          [process.execPath, script, "worker", point, snapshot, interruption, root],
          {
            detached: true,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          }
        );
        worker = launched;
        const [exitCode, stderr] = await bounded(
          Promise.all([launched.exited, new Response(launched.stderr).text()]),
          16_000
        );
        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
        const result = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
        expect(result.injected).toBeGreaterThan(0);
        expect(result).toMatchObject({
          unrelatedRunning: true,
          unrelatedTerm: false,
          unrelatedCompleted: true,
          foreignGroupSignals: [],
        });
        if (snapshot === "absent" || snapshot === "zombie") {
          expect(result).toMatchObject({
            rejected: false,
            cleanupError: false,
            exitCode: interruption === "cancel" ? 130 : 124,
            ownedRunning: false,
          });
        } else {
          expect(result).toMatchObject({ rejected: true, cleanupError: true, ownedRunning: true });
        }
        expect(result.nativeInspections).toBeGreaterThan(0);
      } finally {
        const pids = ["owned", "unrelated"].flatMap((role) => {
          const file = join(root, `${role}.pid`);
          return existsSync(file) ? [Number(readFileSync(file, "utf8"))] : [];
        });
        for (const pid of [...pids, ...(worker ? [worker.pid] : [])]) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {}
        }
        if (worker) await bounded(worker.exited, 2000);
        const deadline = Date.now() + 2000;
        while (pids.some(running) && Date.now() < deadline) await Bun.sleep(10);
        expect(pids.some(running)).toBe(false);
        await rm(root, { recursive: true, force: true });
      }
    },
    20_000
  );
}
