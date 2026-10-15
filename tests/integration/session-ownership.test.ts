import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalWorkspace } from "../../src/paths";
import { workspaceKey } from "../../src/router/session-key";
import { sessionAccess, type SessionTarget } from "../../src/runtime/session-target";
import { backupSession, createSession, resetSession } from "../../src/sessions";
import { buildRuntimeMemoryDigest } from "../../src/memory/runtime-digest";
import { insertMemory } from "../../src/state/repos/memory";
import { appendMessage } from "../../src/state/repos/messages";
import { getByKey } from "../../src/state/repos/sessions";
import { getSharedDb, resetSharedDbCache } from "../../src/state/shared-db";
import { rmWithRetry } from "../helpers/rm-with-retry";

const repo = resolve(import.meta.dir, "../..");
const originalCwd = process.cwd();
let cwd: string;
let fixture: string;
let worker: string;
const tasks: Task[] = [];
const retainedFact = "CLI_OWNERSHIP_SENTINEL_8123";

interface Invocation {
  pid: number;
  resume: string | null;
  appendSystemPrompt: string;
  time: number;
  overlappedPrevious: boolean;
}

interface Task {
  prefix: string;
  process: ReturnType<typeof Bun.spawn>;
  done: Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

// Kept inside the test slice: the shared fake CLI has no file-barrier protocol.
const fakeCli = String.raw`
import { existsSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
const prefix = process.env.HERMES_OWNERSHIP_TASK!;
const previous = process.env.HERMES_OWNERSHIP_PREVIOUS;
const args = process.argv.slice(2);
const value = (flag: string) => {
  const i = args.indexOf(flag);
  return i < 0 ? null : args[i + 1] ?? null;
};
await writeFile(prefix + ".started.tmp", JSON.stringify({
  pid: process.pid, resume: value("--resume"),
  appendSystemPrompt: value("--append-system-prompt") ?? "", time: Date.now(),
  overlappedPrevious: !!previous && !existsSync(previous + ".ended"),
}));
await rename(prefix + ".started.tmp", prefix + ".started");
if (process.env.HERMES_OWNERSHIP_BLOCK === "1") {
  while (!existsSync(prefix + ".release")) await Bun.sleep(10);
}
await writeFile(prefix + ".ended", JSON.stringify({ time: Date.now() }));
const session_id = process.env.HERMES_OWNERSHIP_SESSION!;
const result = process.env.HERMES_OWNERSHIP_ECHO === "1"
  ? value("--append-system-prompt") ?? "" : "complete";
if (value("--output-format") === "json") {
  console.log(JSON.stringify([{ type: "result", subtype: "success", session_id, result }]));
} else {
  console.log(result);
}
`;

const runnerWorker = String.raw`
import { existsSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const repo = process.env.HERMES_OWNERSHIP_REPO!;
const load = (path: string) => import(pathToFileURL(repo + "/src/" + path).href);
const { reloadSettings } = await load("config.ts");
const { getSharedDb } = await load("state/shared-db.ts");
const runner = await load("runner.ts");
const { withBridgeSignal } = await load("runtime/bridge-context.ts");
await reloadSettings();
await getSharedDb();
const prefix = process.env.HERMES_OWNERSHIP_TASK!;
const saveResult = async (result: unknown) => {
  await writeFile(prefix + ".result.tmp", JSON.stringify(result));
  await rename(prefix + ".result.tmp", prefix + ".result");
};
const target = process.env.HERMES_OWNERSHIP_TARGET
  ? JSON.parse(process.env.HERMES_OWNERSHIP_TARGET) : undefined;
const controller = new AbortController();
const timer = setInterval(() => {
  if (existsSync(prefix + ".cancel")) controller.abort(new Error("test cancellation"));
}, 10);
await writeFile(prefix + ".entered", "ready");
try {
  const result = await withBridgeSignal(controller.signal, async () => {
    switch (process.argv[2]) {
      case "bootstrap": await runner.bootstrap(); return { exitCode: 0 };
      case "compact": {
        const compact = await runner.compactCurrentSession({ target });
        return { exitCode: compact.success ? 0 : 1, ...compact };
      }
      case "run": return runner.run("ownership", "ordinary task", target);
      default: return runner.runUserMessage(
        "ownership", process.env.HERMES_OWNERSHIP_PROMPT ?? "ordinary task", target
      );
    }
  });
  await saveResult(result);
} catch (error) {
  await saveResult({
    cancelled: controller.signal.aborted, error: String(error),
  });
} finally {
  clearInterval(timer);
}
`;

beforeEach(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), "hermes-ownership-")));
  await mkdir(join(cwd, ".claude/hermes"), { recursive: true });
  await writeFile(
    join(cwd, ".claude/hermes/settings.json"),
    JSON.stringify({
      agentic: { enabled: false },
      learning: { captureCandidateSkills: false },
      sessionTimeoutMs: 15_000,
    })
  );
  fixture = join(cwd, "fake-claude.ts");
  worker = join(cwd, "runner-worker.ts");
  await writeFile(fixture, fakeCli);
  await writeFile(worker, runnerWorker);
  process.chdir(cwd);
  // Finish migrations before independent processes open the same database.
  await getSharedDb(cwd);
});

afterEach(async () => {
  // Always release barriers before stopping processes, including failed assertions.
  for (const task of tasks) await release(task);
  for (const task of tasks) {
    if (task.process.exitCode === null) task.process.kill("SIGKILL");
    await task.done;
    if (existsSync(task.prefix + ".started") && !existsSync(task.prefix + ".ended")) {
      const invocation = await readJson<Invocation>(task.prefix + ".started");
      try {
        process.kill(invocation.pid, "SIGKILL");
      } catch {}
    }
  }
  tasks.length = 0;
  await resetSharedDbCache();
  process.chdir(originalCwd);
  await rmWithRetry(cwd);
});

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function waitFor(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`fixture barrier timed out: ${path}`);
    await Bun.sleep(10);
  }
}

async function appeared(path: string, timeoutMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(10);
  return existsSync(path);
}

function spawnTask(
  name: string,
  mode: "run" | "user" | "bootstrap" | "compact" | "send" | "clear",
  options: {
    target?: SessionTarget;
    blocked?: boolean;
    prompt?: string;
    echo?: boolean;
    at?: string;
    previous?: Task;
  } = {}
): Task {
  const prefix = join(cwd, name);
  const args = [
    process.execPath,
    "run",
    mode === "send" || mode === "clear" ? join(repo, "src/index.ts") : worker,
  ];
  args.push(mode === "clear" ? "--clear" : mode);
  if (mode === "send") args.push(options.prompt ?? "ordinary task");
  const child = Bun.spawn(args, {
    cwd: options.at ?? cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HERMES_SKIP_PREFLIGHT: "1",
      HERMES_CLAUDE_BIN: `${process.execPath} run ${fixture}`,
      HERMES_OWNERSHIP_REPO: repo,
      HERMES_OWNERSHIP_TASK: prefix,
      HERMES_OWNERSHIP_BLOCK: options.blocked ? "1" : "0",
      HERMES_OWNERSHIP_ECHO: options.echo ? "1" : "0",
      HERMES_OWNERSHIP_SESSION: `${name}-session`,
      HERMES_OWNERSHIP_PREVIOUS: options.previous?.prefix,
      HERMES_OWNERSHIP_PROMPT: options.prompt ?? "ordinary task",
      HERMES_OWNERSHIP_TARGET: options.target ? JSON.stringify(options.target) : undefined,
    },
  });
  const task: Task = {
    prefix,
    process: child,
    done: Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr })),
  };
  tasks.push(task);
  return task;
}

async function release(task: Task): Promise<void> {
  await writeFile(task.prefix + ".release", "continue");
}

async function complete(task: Task): Promise<void> {
  await waitFor(task.prefix + ".result");
  const result = await task.done;
  expect(result, `worker failed: ${result.stderr}`).toMatchObject({ exitCode: 0 });
  expect(await readJson(task.prefix + ".result")).toMatchObject({ exitCode: 0 });
}

function target(source: "cli" | "telegram" | "discord" = "cli", key = workspaceKey(cwd)): SessionTarget {
  return {
    key,
    scope: source === "cli" ? "workspace" : "dm",
    source,
    workspace: canonicalWorkspace(cwd),
    memoryScope: source === "cli" ? "workspace" : "channel",
    ...(source === "cli" ? {} : { user: "unrelated-user" }),
  };
}

async function seedCli() {
  await createSession("old-cli-session");
  const db = await getSharedDb(cwd);
  const row = getByKey(db, workspaceKey(cwd))!;
  insertMemory(db, { scope: "workspace", key: "retained", value: retainedFact, sourceSessionId: row.id });
  appendMessage(db, { sessionId: row.id, role: "user", content: retainedFact });
  return { db, row };
}

function assertRecallIsolation(db: Awaited<ReturnType<typeof getSharedDb>>) {
  for (const source of ["telegram", "discord"] as const) {
    expect(
      buildRuntimeMemoryDigest(db, {
        target: target(source, `dm:${source}:unrelated-user`),
        query: retainedFact,
      })
    ).not.toContain(retainedFact);
  }
  expect(buildRuntimeMemoryDigest(db, { target: target(), query: retainedFact })).toContain(retainedFact);
}

test.each(["reset", "backup", "clear"] as const)(
  "CLI %s preserves durable ownership and keeps bridge recall isolated",
  async (operation) => {
    const { db, row } = await seedCli();
    assertRecallIsolation(db);
    if (operation === "reset") await resetSession();
    else if (operation === "backup") expect(await backupSession()).toBe("session_1.backup");
    else {
      const cleared = await spawnTask("clear", "clear").done;
      expect(cleared, cleared.stderr).toMatchObject({ exitCode: 0 });
    }

    // Check disclosure after reset even when its row-identity assertion is RED.
    for (const source of ["telegram", "discord"] as const) {
      expect(
        buildRuntimeMemoryDigest(db, {
          target: target(source, `dm:${source}:unrelated-user`),
          query: retainedFact,
        })
      ).not.toContain(retainedFact);
    }
    const kept = getByKey(db, row.key);
    expect(kept).toMatchObject({ id: row.id, source: "cli", claude_session_id: null, turn_count: 0 });
    expect(db.query("SELECT source_session_id FROM memory_entries").all()).toEqual([
      { source_session_id: row.id },
    ]);
    assertRecallIsolation(db);

    const next = spawnTask("next", "user", { echo: true });
    await complete(next);
    const invocation = await readJson<Invocation>(next.prefix + ".started");
    expect(invocation.resume).toBeNull();
    expect(invocation.appendSystemPrompt).toContain(retainedFact);
    expect(getByKey(db, row.key)?.id).toBe(row.id);
    assertRecallIsolation(db);
  },
  20_000
);

test.each(["first", "resumed"] as const)(
  "cross-process --clear fences a blocked %s turn before messages and fact extraction",
  async (phase) => {
    const db = await getSharedDb(cwd);
    if (phase === "resumed") await seedCli();
    const active = spawnTask("late", "user", {
      blocked: true,
      prompt: "remember that LATE_CLEAR_FACT_9451 belongs to the cleared turn",
    });
    await waitFor(active.prefix + ".started");
    const original = await readJson<Invocation>(active.prefix + ".started");
    expect(original.resume).toBe(phase === "resumed" ? "old-cli-session" : null);
    const cleared = await spawnTask("clear", "clear").done;
    expect(cleared, cleared.stderr).toMatchObject({ exitCode: 0 });
    const messagesAfterClear = db.query("SELECT id, session_id, content FROM messages ORDER BY id").all();
    const memoryAfterClear = db
      .query("SELECT id, source_session_id, value FROM memory_entries ORDER BY id")
      .all();
    await release(active);
    await active.done;

    // All three side effects are checked together so RED exposes the whole race.
    expect({
      claudeSessionId: getByKey(db, workspaceKey(cwd))?.claude_session_id ?? null,
      messages: db.query("SELECT id, session_id, content FROM messages ORDER BY id").all(),
      memory: db.query("SELECT id, source_session_id, value FROM memory_entries ORDER BY id").all(),
    }).toEqual({ claudeSessionId: null, messages: messagesAfterClear, memory: memoryAfterClear });

    const next = spawnTask("fresh", "user");
    await complete(next);
    expect((await readJson<Invocation>(next.prefix + ".started")).resume).toBeNull();
  },
  20_000
);

test.each(["run", "user", "bootstrap"] as const)(
  "%s and a separate runner serialize one workspace and read the newly persisted Claude id",
  async (mode) => {
    const first = spawnTask("first", mode, { blocked: true });
    await waitFor(first.prefix + ".started");
    const second = spawnTask("second", "user", { previous: first });
    await waitFor(second.prefix + ".entered");
    await appeared(second.prefix + ".started");
    await release(first);
    await Promise.all([complete(first), complete(second)]);
    const start = await readJson<Invocation>(second.prefix + ".started");
    expect({ overlaps: start.overlappedPrevious, resume: start.resume }).toEqual({
      overlaps: false,
      resume: "first-session",
    });
  },
  20_000
);

test.each(["send", "compact"] as const)(
  "actual %s and a separate runner share the CLI workspace lane",
  async (mode) => {
    await seedCli();
    const first = spawnTask("first", "user", { blocked: true, target: target() });
    await waitFor(first.prefix + ".started");
    const second = spawnTask("second", mode, { previous: first });
    await appeared(second.prefix + ".started");
    await release(first);
    await complete(first);
    if (mode === "send") expect(await second.done).toMatchObject({ exitCode: 0 });
    else await complete(second);
    const start = await readJson<Invocation>(second.prefix + ".started");
    expect(start.overlappedPrevious).toBe(false);
    expect(start.resume).toBe("old-cli-session");
  },
  20_000
);

test("independent keys in the same workspace may run while another key is blocked", async () => {
  const first = spawnTask("first", "user", { blocked: true, target: target("telegram", "dm:telegram:one") });
  await waitFor(first.prefix + ".started");
  const second = spawnTask("second", "user", { target: target("discord", "dm:discord:two") });
  await complete(second);
  expect(existsSync(first.prefix + ".ended")).toBe(false);
  await release(first);
  await complete(first);
}, 20_000);

test("physical workspace aliases with the same key share one cross-process lane", async () => {
  const alias = join(cwd, "workspace-alias");
  await symlink(cwd, alias, process.platform === "win32" ? "junction" : "dir");
  const first = spawnTask("first", "user", { blocked: true, target: target() });
  await waitFor(first.prefix + ".started");
  const second = spawnTask("second", "user", {
    target: { ...target(), workspace: alias },
    at: alias,
    previous: first,
  });
  await waitFor(second.prefix + ".entered");
  await appeared(second.prefix + ".started");
  await release(first);
  await Promise.all([complete(first), complete(second)]);
  const start = await readJson<Invocation>(second.prefix + ".started");
  expect({ overlaps: start.overlappedPrevious, resume: start.resume }).toEqual({
    overlaps: false,
    resume: "first-session",
  });
}, 20_000);

test("cancelling a lock waiter never starts its Claude child or cancels the owner", async () => {
  const first = spawnTask("first", "user", { blocked: true, target: target() });
  await waitFor(first.prefix + ".started");
  const waiting = spawnTask("waiting", "user", { blocked: true, target: target() });
  await waitFor(waiting.prefix + ".entered");
  await appeared(waiting.prefix + ".started");
  await writeFile(waiting.prefix + ".cancel", "cancel");
  await waitFor(waiting.prefix + ".result");
  expect(await waiting.done).toMatchObject({ exitCode: 0 });
  const result = await readJson<{ cancelled?: boolean; exitCode?: number }>(waiting.prefix + ".result");
  expect(result.cancelled || result.exitCode === 130).toBe(true);
  expect(existsSync(waiting.prefix + ".started")).toBe(false);
  expect(existsSync(first.prefix + ".ended")).toBe(false);
  await release(first);
  await complete(first);
  const next = spawnTask("next", "user", { target: target() });
  await complete(next);
  expect((await readJson<Invocation>(next.prefix + ".started")).resume).toBe("first-session");
}, 20_000);

test("a crashed owner keeps the lane fenced until any surviving Claude child exits, then recovers", async () => {
  const owner = spawnTask("owner", "user", { blocked: true, target: target() });
  await waitFor(owner.prefix + ".started");
  const orphan = await readJson<Invocation>(owner.prefix + ".started");
  owner.process.kill("SIGKILL");
  await owner.process.exited;
  // Windows may terminate the whole process tree; POSIX leaves this child alive.
  let orphanSurvived = true;
  try {
    process.kill(orphan.pid, 0);
  } catch {
    orphanSurvived = false;
  }
  const successor = spawnTask("successor", "user", { target: target() });
  await waitFor(successor.prefix + ".entered");
  const admittedWithOrphanAlive = orphanSurvived && (await appeared(successor.prefix + ".started"));
  await release(owner);
  await complete(successor);
  expect(admittedWithOrphanAlive).toBe(false);
  expect((await readJson<Invocation>(successor.prefix + ".started")).resume).toBeNull();
  expect(getByKey(await getSharedDb(cwd), workspaceKey(cwd))?.claude_session_id).toBe("successor-session");
}, 20_000);
