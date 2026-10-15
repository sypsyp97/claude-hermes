import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { evolveOnce, type LoopHooks } from "../../src/evolve/loop";
import { applyMigrations, closeDb, openDb, type Database } from "../../src/state";

const source = resolve(import.meta.dir, "../..");
const execResult = { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
const verifyResult = { ...execResult };
let root: string;
let workspace: string;
let db: Database;
const workers: Worker[] = [];

interface Worker {
  prefix: string;
  child: ReturnType<typeof Bun.spawn>;
  done: Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

interface WorkerResult {
  outcome: string;
  reason?: string;
  events: number;
  gitCalls: string[][];
  verified: boolean;
}

// File barriers and databases live outside the Git worktree. Each process
// imports the real evolve driver; only execution and verification are fake.
const workerSource = String.raw`
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const load = path => import(pathToFileURL(process.env.EVOLVE_SOURCE + "/src/" + path).href);
const { evolveOnce } = await load("evolve/loop.ts");
const { openDb, applyMigrations, closeDb } = await load("state/index.ts");
const prefix = process.env.EVOLVE_PREFIX;
const cwd = process.env.EVOLVE_WORKSPACE;
const mode = process.env.EVOLVE_MODE;
const db = openDb({ path: ":memory:" });
await applyMigrations(db);
const gitCalls = [];
let verified = false;
const save = async (suffix, value) => {
  await writeFile(prefix + suffix + ".tmp", JSON.stringify(value));
  await rename(prefix + suffix + ".tmp", prefix + suffix);
};
try {
  const result = await evolveOnce(db, { id: mode, title: mode, body: "fixture only" }, cwd, {
    runExec: async () => {
      if (mode === "contender") await writeFile(join(cwd, "README.md"), "SECOND EXECUTOR EDIT\n");
      await save(".entered", { pid: process.pid });
      if (mode !== "probe") {
        while (!existsSync(prefix + ".release")) await Bun.sleep(5);
      }
      return { ok: false, exitCode: 7, stdout: "", stderr: "fixture failure", durationMs: 1 };
    },
    gate: {
      runVerify: async () => {
        verified = true;
        return { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
      },
      runGit: async (at, args) => {
        gitCalls.push(args);
        const result = spawnSync("git", ["--literal-pathspecs", ...args], { cwd: at, encoding: "utf8" });
        return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      },
    },
  });
  await save(".result", {
    ...result, events: db.query("SELECT COUNT(*) AS n FROM learn_events").get().n, gitCalls, verified,
  });
} catch (error) {
  await save(".error", String(error));
  process.exitCode = 1;
} finally {
  closeDb(db);
}
`;

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", ["--literal-pathspecs", ...args], { cwd, encoding: "utf8" });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function gitOk(cwd: string, args: string[]): string {
  const result = git(cwd, args);
  if (!result.ok) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

async function seedWorkspace(name: string): Promise<string> {
  const cwd = join(root, name);
  await mkdir(cwd);
  gitOk(cwd, ["init", "-q", "-b", "main"]);
  await writeFile(join(cwd, ".gitignore"), ".claude/\nmemory/\n");
  await writeFile(join(cwd, "README.md"), "ORIGINAL\n");
  gitOk(cwd, ["add", "--", ".gitignore", "README.md"]);
  gitOk(cwd, [
    "-c",
    "user.name=Evolve Lock Test",
    "-c",
    "user.email=evolve-lock@hermes.local",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "fixture seed",
  ]);
  return cwd;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "hermes-evolve-lock-")));
  workspace = await seedWorkspace("workspace");
  await writeFile(join(root, "worker.ts"), workerSource);
  db = openDb({ path: ":memory:" });
  await applyMigrations(db);
});

afterEach(async () => {
  for (const worker of workers) await writeFile(worker.prefix + ".release", "continue");
  for (const worker of workers) {
    if (worker.child.exitCode === null) worker.child.kill("SIGKILL");
    await worker.done;
  }
  workers.length = 0;
  closeDb(db);
  await rm(root, { recursive: true, force: true });
});

function spawnWorker(name: string, mode: "owner" | "contender" | "probe", cwd = workspace): Worker {
  const prefix = join(root, name);
  const child = Bun.spawn([process.execPath, "run", join(root, "worker.ts")], {
    cwd,
    env: {
      ...process.env,
      EVOLVE_SOURCE: source,
      EVOLVE_PREFIX: prefix,
      EVOLVE_WORKSPACE: cwd,
      EVOLVE_MODE: mode,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const worker = {
    prefix,
    child,
    done: Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr })),
  };
  workers.push(worker);
  return worker;
}

async function waitForEither(worker: Worker, suffixes: string[]): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    for (const suffix of [...suffixes, ".error"]) {
      if (existsSync(worker.prefix + suffix)) {
        if (suffix === ".error") throw new Error(await readFile(worker.prefix + suffix, "utf8"));
        return suffix;
      }
    }
    if (Date.now() >= deadline) throw new Error(`fixture barrier timed out: ${worker.prefix} ${suffixes}`);
    if (worker.child.exitCode !== null) throw new Error(JSON.stringify(await worker.done));
    await Bun.sleep(5);
  }
}

async function readResult(worker: Worker): Promise<WorkerResult> {
  await waitForEither(worker, [".result"]);
  expect(await worker.done).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  return JSON.parse(await readFile(worker.prefix + ".result", "utf8"));
}

const lockPath = () => join(workspace, ".claude/hermes/evolve.lock");
const task = (id: string) => ({ id, title: id, body: "fixture only" });

function runOnce(hooks: LoopHooks = {}, at = workspace) {
  return evolveOnce(db, task("local"), at, {
    runExec: async () => execResult,
    gate: { runVerify: async () => verifyResult },
    ...hooks,
  });
}

for (const alias of [false, true]) {
  test(`independent processes ${alias ? "through a physical-workspace alias " : ""}cannot overlap or lose edits to another rollback`, async () => {
    let at = workspace;
    if (alias) {
      at = join(root, "alias");
      await symlink(workspace, at, process.platform === "win32" ? "junction" : "dir");
    }
    const owner = spawnWorker("owner", "owner");
    await waitForEither(owner, [".entered"]);
    const contender = spawnWorker("contender", "contender", at);
    const observed = await waitForEither(contender, [".entered", ".result"]);
    const whileContenderRuns = await readFile(join(workspace, "README.md"), "utf8");
    await writeFile(owner.prefix + ".release", "continue");
    const ownerResult = await readResult(owner);
    const afterRollback = await readFile(join(workspace, "README.md"), "utf8");
    await writeFile(contender.prefix + ".release", "continue");
    const contenderResult = await readResult(contender);

    // On the unsafe baseline: .entered, SECOND EXECUTOR EDIT, then ORIGINAL.
    // Preserve all three observations in the failure rather than timing overlap.
    expect({ observed, whileContenderRuns, afterRollback, outcome: contenderResult.outcome }).toEqual({
      observed: ".result",
      whileContenderRuns: "ORIGINAL\n",
      afterRollback: "ORIGINAL\n",
      outcome: "workspace-busy",
    });
    expect(ownerResult.outcome).toBe("exec-failed");
    expect(contenderResult.events).toBe(0);
    expect(contenderResult.verified).toBe(false);
    expect(contenderResult.gitCalls.every((args) => args[0] === "status")).toBe(true);
    expect(contenderResult.reason).toContain(lockPath());
    expect(contenderResult.reason).toContain(String(owner.child.pid));
    const journalDir = join(workspace, "memory/journal");
    const journal = await readFile(join(journalDir, `${new Date().toISOString().slice(0, 10)}.md`), "utf8");
    expect(journal).not.toContain("— contender");
    expect(existsSync(lockPath())).toBe(false);
  }, 20_000);
}

test("a lock in one physical workspace does not block a different workspace", async () => {
  const owner = spawnWorker("owner", "owner");
  await waitForEither(owner, [".entered"]);
  const other = await seedWorkspace("other");
  const probe = spawnWorker("other", "probe", other);
  expect((await readResult(probe)).outcome).toBe("exec-failed");
  expect(existsSync(owner.prefix + ".release")).toBe(false);
  expect(existsSync(lockPath())).toBe(true);
});

test("a crashed owner leaves a fail-closed lock until a stopped owner's lock is manually removed", async () => {
  const owner = spawnWorker("crashed", "owner");
  await waitForEither(owner, [".entered"]);
  owner.child.kill("SIGKILL");
  await owner.done;
  const retry = spawnWorker("retry", "probe");
  const result = await readResult(retry);
  expect(result.outcome).toBe("workspace-busy");
  expect(result.events).toBe(0);
  expect(result.reason).toContain(lockPath());
  expect(result.reason).toContain(String(owner.child.pid));
  expect(existsSync(retry.prefix + ".entered")).toBe(false);
  expect(existsSync(lockPath())).toBe(true);

  // The fixture has confirmed its only owner stopped before manual removal.
  await rm(lockPath());
  const unlocked = spawnWorker("unlocked", "probe");
  expect((await readResult(unlocked)).outcome).toBe("exec-failed");
  expect(existsSync(lockPath())).toBe(false);
});

test("pre-existing dirty work is rejected without creating lock or journal state", async () => {
  await writeFile(join(workspace, "README.md"), "USER WORK\n");
  let executed = false;
  const result = await runOnce({
    runExec: async () => {
      executed = true;
      return execResult;
    },
  });
  expect(result.outcome).toBe("dirty-worktree");
  expect(executed).toBe(false);
  expect(existsSync(join(workspace, ".claude"))).toBe(false);
  expect(existsSync(join(workspace, "memory"))).toBe(false);
  expect(db.query("SELECT COUNT(*) AS n FROM learn_events").get()).toEqual({ n: 0 });
  expect(await readFile(join(workspace, "README.md"), "utf8")).toBe("USER WORK\n");
});

test("the worktree is checked again under the lock before any executor or journal write", async () => {
  let preflight = true;
  let executed = false;
  const result = await runOnce({
    runExec: async () => {
      executed = true;
      return { ...execResult, ok: false };
    },
    gate: {
      runGit: async (cwd, args) => {
        const result = git(cwd, args);
        if (args[0] === "status" && preflight) {
          preflight = false;
          // Return the clean snapshot after another writer has changed the file.
          await writeFile(join(workspace, "README.md"), "ARRIVED AFTER PREFLIGHT\n");
        }
        return result;
      },
    },
  });
  expect(result.outcome).toBe("dirty-worktree");
  expect(executed).toBe(false);
  expect(db.query("SELECT COUNT(*) AS n FROM learn_events").get()).toEqual({ n: 0 });
  expect(await readFile(join(workspace, "README.md"), "utf8")).toBe("ARRIVED AFTER PREFLIGHT\n");
  expect(existsSync(lockPath())).toBe(false);
});

for (const outcome of ["committed", "exec-failed", "verify-failed"] as const) {
  test(`the lock covers executor, verification, journal and Git ${outcome === "committed" ? "commit" : "rollback"}, then releases after ${outcome}`, async () => {
    const phases: { phase: string; locked: boolean }[] = [];
    const observe = (phase: string) => phases.push({ phase, locked: existsSync(lockPath()) });
    db.prepare = new Proxy(db.prepare, {
      apply(prepare, target, args) {
        if (String(args[0]).startsWith("INSERT INTO learn_events")) observe("journal");
        return Reflect.apply(prepare, target, args);
      },
    });
    const result = await runOnce({
      runExec: async () => {
        observe("exec");
        await writeFile(join(workspace, "README.md"), "EXECUTOR EDIT\n");
        return { ...execResult, ok: outcome !== "exec-failed" };
      },
      gate: {
        runVerify: async () => {
          observe("verify");
          return { ...verifyResult, ok: outcome === "committed" };
        },
        runGit: async (cwd, args) => {
          if (args[0] !== "status") observe(args[0]);
          // The real fixture commit uses an isolated per-command identity.
          return git(
            cwd,
            args[0] === "commit"
              ? [
                  "-c",
                  "user.name=Evolve Lock Test",
                  "-c",
                  "user.email=evolve-lock@hermes.local",
                  "-c",
                  "commit.gpgsign=false",
                  ...args,
                ]
              : args
          );
        },
      },
    });
    expect(result.outcome).toBe(outcome);
    expect(phases.length).toBeGreaterThan(1);
    expect(phases.filter(({ locked }) => !locked)).toEqual([]);
    expect(existsSync(lockPath())).toBe(false);
    expect((await runOnce()).outcome).toBe("committed");
  });
}

for (const phase of ["exec", "verify", "commit", "rollback", "journal"] as const) {
  test(`an exception from ${phase} releases the workspace for the next iteration`, async () => {
    if (phase === "journal") {
      db.exec(
        "CREATE TRIGGER fail_journal BEFORE INSERT ON learn_events BEGIN SELECT RAISE(FAIL, 'fixture journal failure'); END"
      );
    }
    const hooks: LoopHooks = {
      runExec: async () => {
        if (phase === "exec") throw new Error("fixture exec failure");
        await writeFile(join(workspace, "README.md"), "EXECUTOR EDIT\n");
        return { ...execResult, ok: phase !== "rollback" };
      },
      gate: {
        runVerify: async () => {
          if (phase === "verify") throw new Error("fixture verify failure");
          return verifyResult;
        },
        runGit: async (cwd, args) => {
          if (args[0] === "commit" || (phase === "rollback" && args[0] === "restore")) {
            return { ok: false, stdout: "", stderr: `fixture ${phase} failure` };
          }
          return git(cwd, args);
        },
      },
    };
    await expect(runOnce(hooks)).rejects.toThrow(`fixture ${phase} failure`);
    expect(existsSync(lockPath())).toBe(false);
    if (phase === "journal") db.exec("DROP TRIGGER fail_journal");
    // Failed executor/verification hooks can leave edits: clean only this
    // isolated fixture before proving a fresh iteration can acquire the lock.
    gitOk(workspace, ["restore", "--source=HEAD", "--staged", "--worktree", "--", "README.md"]);
    expect((await runOnce()).outcome).toBe("committed");
  });
}
