import { expect, test } from "bun:test";
import { enqueueBridge, prepareBridgeTransfer } from "../src/runtime/bridge-queue";
import { withExecutionSlot } from "../src/runtime/execution-budget";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nudgeAndPersist, resetExtractor, setExtractor } from "../src/memory/nudge";
import { crossSessionMemoryFile } from "../src/paths";
import { runProcess } from "../src/runtime/process";
import { taskProcessArgs } from "../src/runtime/process-tree";
import { leaseGeneration, registerLeaseProcess, releaseLeaseProcess, withSessionLease } from "../src/runtime/session-lease";
import { sessionAccess, type SessionTarget } from "../src/runtime/session-target";
import { insertMemory } from "../src/state/repos/memory";
import { appendMessage, listForSession } from "../src/state/repos/messages";
import { getByKey, resetByKey, sessionGeneration, upsertSession } from "../src/state/repos/sessions";
import { getSharedDb, resetSharedDbCache } from "../src/state/shared-db";

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

test("formal trace: abort between admission and continuation never starts work", async () => {
  const controller = new AbortController();
  let ran = false;
  const task = withExecutionSlot(async () => { ran = true; }, controller.signal);
  controller.abort(new Error("trace abort"));
  await expect(task).rejects.toThrow("trace abort");
  expect(ran).toBe(false);
  expect(await withExecutionSlot(async () => "slot recovered")).toBe("slot recovered");
});

test("formal trace: middle waiter cancellation preserves FIFO and capacity", async () => {
  const gates = Array.from({ length: 4 }, deferred);
  const tailGate = deferred();
  let active = 0;
  let highWater = 0;
  const holders = gates.map((gate) => withExecutionSlot(async () => {
    highWater = Math.max(highWater, ++active);
    try { await gate.promise; } finally { active--; }
  }));
  await flush();
  expect(active).toBe(4);
  const events: number[] = [];
  const controller = new AbortController();
  const waiters = [0, 1, 2].map((index) => withExecutionSlot(async () => {
    highWater = Math.max(highWater, ++active);
    events.push(index);
    try { await tailGate.promise; } finally { active--; }
  }, index === 1 ? controller.signal : undefined));
  const cancelled = waiters[1].then(() => "ran", () => "cancelled");
  try {
    controller.abort();
    expect(await cancelled).toBe("cancelled");
    expect(events).toEqual([]);
    gates[0].resolve();
    await flush();
    expect(events).toEqual([0]);
    gates[1].resolve();
    await flush();
    expect(events).toEqual([0, 2]);
    expect(highWater).toBe(4);
  } finally {
    for (const gate of gates) gate.resolve();
    tailGate.resolve();
    await Promise.allSettled([...holders, ...waiters]);
  }
  expect(active).toBe(0);
});

test("formal trace: old failed lane cleanup cannot erase a newer active tail", async () => {
  const firstGate = deferred();
  const secondGate = deferred();
  const events: number[] = [];
  const first = enqueueBridge("formal-replay", "stale-tail", async () => {
    await firstGate.promise;
    throw new Error("first failed");
  });
  const observedFirst = first.catch(() => {});
  const second = enqueueBridge("formal-replay", "stale-tail", async () => {
    events.push(2);
    await secondGate.promise;
  });
  let third: Promise<void> | undefined;
  try {
    firstGate.resolve();
    await observedFirst;
    await flush();
    expect(events).toEqual([2]);
    third = enqueueBridge("formal-replay", "stale-tail", async () => { events.push(3); });
    await flush();
    expect(events).toEqual([2]);
  } finally {
    firstGate.resolve();
    secondGate.resolve();
    await Promise.allSettled([observedFirst, second, ...(third ? [third] : [])]);
  }
  expect(events).toEqual([2, 3]);
});

test("formal trace: first resolution chooses one destination before later controls", async () => {
  const events: string[] = [];
  const transfer = prepareBridgeTransfer<string>("formal-transfer", async (value) => { events.push(value); });
  transfer.reserve("a");
  transfer.reserve("b");
  const aControl = enqueueBridge("formal-transfer", "a", async () => { events.push("control-a"); });
  const bControl = enqueueBridge("formal-transfer", "b", async () => { events.push("control-b"); });
  const a = transfer.complete("a", "first-a");
  const b = transfer.complete("b", "first-b");
  transfer.cancel();
  await Promise.all([a, b, aControl, bControl]);
  expect(events.filter((event) => event.startsWith("first-"))).toEqual(["first-a"]);
  expect(events.indexOf("first-a")).toBeLessThan(events.indexOf("control-a"));
});

test("formal trace: cancellation wins over later completion and releases reservations", async () => {
  let runs = 0;
  const transfer = prepareBridgeTransfer<string>("formal-cancel", async () => { runs++; });
  transfer.reserve("a");
  transfer.reserve("b");
  transfer.cancel();
  await Promise.all([transfer.complete("a", "ignored"), transfer.complete("b", "ignored")]);
  expect(await enqueueBridge("formal-cancel", "a", async () => "released-a")).toBe("released-a");
  expect(await enqueueBridge("formal-cancel", "b", async () => "released-b")).toBe("released-b");
  expect(runs).toBe(0);
});

test("formal trace: failed memory writer does not lose a newer tail", async () => {
  const { withMemoryFileLock } = await import("../src/memory/file-lock");
  const firstGate = deferred();
  const secondGate = deferred();
  const events: number[] = [];
  const first = withMemoryFileLock("formal-memory-lane", async () => {
    await firstGate.promise;
    throw new Error("first writer failed");
  });
  const observedFirst = first.catch(() => {});
  const second = withMemoryFileLock("formal-memory-lane", async () => {
    events.push(2);
    await secondGate.promise;
  });
  let third: Promise<void> | undefined;
  try {
    firstGate.resolve();
    await observedFirst;
    await flush();
    expect(events).toEqual([2]);
    third = withMemoryFileLock("formal-memory-lane", async () => { events.push(3); });
    await flush();
    expect(events).toEqual([2]);
    expect(await withMemoryFileLock("formal-other-memory-lane", async () => "independent")).toBe("independent");
  } finally {
    firstGate.resolve();
    secondGate.resolve();
    await Promise.allSettled([observedFirst, second, ...(third ? [third] : [])]);
  }
  expect(events).toEqual([2, 3]);
});

async function withTemporarySession(work: (target: SessionTarget) => Promise<void>): Promise<void> {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "hermes-formal-session-")));
  try {
    await work({ key: "user:formal:replay", scope: "per-user", source: "cli", workspace,
      user: "formal-replay", memoryScope: "user" });
  } finally {
    resetExtractor();
    await resetSharedDbCache();
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

test("formal trace: first-turn clear keeps its lease and rejects a stale guarded registration", async () => {
  await withTemporarySession(async (target) => {
    const db = await getSharedDb(target.workspace);
    await withSessionLease(target, async () => {
      const before = db.query("SELECT lease_token, owner_pid, child_pid FROM session_runtime WHERE key = ?").get(target.key);
      const captured = leaseGeneration();
      expect(getByKey(db, target.key)).toBeNull();
      await sessionAccess(target).reset();
      expect(sessionGeneration(db, target.key)).toBe(captured! + 1);
      expect(leaseGeneration()).toBe(captured);
      expect(db.query("SELECT lease_token, owner_pid, child_pid FROM session_runtime WHERE key = ?").get(target.key)).toEqual(before);
      const result = await runProcess([process.execPath, "-e", 'console.log("useful-work")'], {
        cwd: target.workspace, timeoutMs: 5_000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(getByKey(db, target.key)).toBeNull();
    });
    expect(db.query<{ lease_token: string | null }, [string]>("SELECT lease_token FROM session_runtime WHERE key = ?").get(target.key)?.lease_token).toBeNull();
  });
}, 20_000);

test("formal trace: clear after durable registration permits work while retaining the generation fence", async () => {
  await withTemporarySession(async (target) => {
    const db = await getSharedDb(target.workspace);
    await withSessionLease(target, async () => {
      const captured = leaseGeneration()!;
      const invocation = taskProcessArgs([process.execPath, "-e", 'console.log("guard-permitted")']);
      expect(invocation.leased).toBe(true);
      const child = Bun.spawn(invocation.args, { stdin: "pipe", stdout: "pipe", stderr: "pipe",
        cwd: target.workspace, detached: process.platform !== "win32", windowsHide: true });
      const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      try {
        await registerLeaseProcess(child.pid);
        const registered = db.query("SELECT lease_token, owner_pid, child_pid FROM session_runtime WHERE key = ?").get(target.key);
        await sessionAccess(target).reset();
        expect(sessionGeneration(db, target.key)).toBe(captured + 1);
        expect(leaseGeneration()).toBe(captured);
        expect(db.query("SELECT lease_token, owner_pid, child_pid FROM session_runtime WHERE key = ?").get(target.key)).toEqual(registered);
        child.stdin.write("run\n");
        child.stdin.end();
        expect(await child.exited).toBe(0);
        const [stdout, stderr] = await output;
        expect(stdout.trim()).toBe("guard-permitted");
        expect(stderr).toBe("");
        await releaseLeaseProcess(child.pid);
      } finally {
        child.stdin.end();
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
        await output;
      }
    });
  });
}, 20_000);

test("formal trace: explicit old turn generation stays stale when extraction begins after reset", async () => {
  await withTemporarySession(async (target) => {
    const db = await getSharedDb(target.workspace);
    const source = upsertSession(db, { ...target, claudeSessionId: "before-reset" });
    appendMessage(db, { sessionId: source.id, role: "user", content: "retained history" });
    insertMemory(db, { sourceSessionId: source.id, scope: "user", key: "prior", value: "retained fact" });
    const captured = sessionGeneration(db, target.key);
    const shared = "retained shared notes\n";
    await mkdir(join(target.workspace, "memory"));
    await writeFile(crossSessionMemoryFile(target.workspace), shared);
    resetByKey(db, target.key);
    expect(getByKey(db, target.key)?.id).toBe(source.id);
    expect(listForSession(db, source.id).map((message) => message.content)).toEqual(["retained history"]);
    const fact = { scope: "user" as const, key: "fresh", value: "attributed fact" };
    let extractions = 0;
    setExtractor(async () => { extractions++; return [fact]; });
    const options = { cwd: target.workspace, sourceSessionId: source.id, sourceSessionKey: target.key,
      memoryScope: "user" as const, generation: captured };
    expect(await nudgeAndPersist([{ role: "user", content: "remember this" }], options)).toEqual([]);
    expect(db.query("SELECT value, source_session_id FROM memory_entries ORDER BY id").all()).toEqual([
      { value: "retained fact", source_session_id: source.id },
    ]);
    expect(await nudgeAndPersist([{ role: "user", content: "remember this" }], {
      ...options, generation: sessionGeneration(db, target.key),
    })).toEqual([fact]);
    expect(db.query("SELECT source_session_id FROM memory_entries WHERE key = ?").all(fact.key)).toEqual([
      { source_session_id: source.id },
    ]);
    expect(await nudgeAndPersist([], { ...options, sourceSessionId: source.id + 100 })).toEqual([]);
    expect(extractions).toBe(2);
    expect(await readFile(crossSessionMemoryFile(target.workspace), "utf8")).toBe(shared);
  });
});

test("formal reused coverage: real cross-process ownership and extraction integration traces", async () => {
  // Separate Bun process isolates the existing suites' cwd and global extractor.
  const child = Bun.spawn([process.execPath, "test", "tests/integration/session-ownership.test.ts",
    "tests/integration/memory-generation.test.ts"], {
    cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
    env: { ...process.env, HERMES_SKIP_PREFLIGHT: "1" }, windowsHide: true,
  });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited,
    new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
}, 120_000);
