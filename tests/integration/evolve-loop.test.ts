import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, closeDb, eventsRepo, openDb, type Database } from "../../src/state";
import { evolveOnce, type EvolveTask } from "../../src/evolve";

let tempRoot: string;
let db: Database;

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(join(tmpdir(), "hermes-evolve-"));
  db = openDb({ path: ":memory:" });
  await applyMigrations(db);
});

afterAll(async () => {
  closeDb(db);
  await fs.rm(tempRoot, { recursive: true, force: true });
});

function task(overrides: Partial<EvolveTask> = {}): EvolveTask {
  return {
    id: "t-1",
    title: "demo task",
    body: "do something small",
    ...overrides,
  };
}

describe("evolveOnce — fake executor", () => {
  test("commits when exec + verify are green", async () => {
    let committed = false;
    let statusCalls = 0;
    const result = await evolveOnce(db, task({ id: "green-task", title: "green task" }), tempRoot, {
      runExec: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
      gate: {
        runVerify: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
        runGit: async (_cwd, args) => {
          if (args[0] === "status") {
            statusCalls++;
            return statusCalls === 1
              ? { ok: true, stdout: "", stderr: "" }
              : { ok: true, stdout: " M src/foo.ts\0", stderr: "" };
          }
          if (args[0] === "add") return { ok: true, stdout: "", stderr: "" };
          if (args[0] === "diff") return { ok: true, stdout: "src/foo.ts\n", stderr: "" };
          if (args[0] === "commit") {
            committed = true;
            return { ok: true, stdout: "", stderr: "" };
          }
          if (args[0] === "rev-parse") return { ok: true, stdout: "deadbeefcafe\n", stderr: "" };
          return { ok: true, stdout: "", stderr: "" };
        },
      },
    });

    expect(result.outcome).toBe("committed");
    expect(result.task.id).toBe("green-task");
    expect(committed).toBe(true);
    expect(result.sha).toBe("deadbeefcafe");
  });

  test("reverts only the exec-touched paths when verify is red", async () => {
    const restoreCalls: string[][] = [];
    let statusCalls = 0;

    const result = await evolveOnce(db, task({ id: "red-task", title: "red task" }), tempRoot, {
      runExec: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
      gate: {
        runVerify: async () => ({
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: "typecheck failed",
          durationMs: 2,
        }),
        runGit: async (_cwd, args) => {
          if (args[0] === "status") {
            statusCalls++;
            // A clean baseline is required before execution.
            if (statusCalls === 1) return { ok: true, stdout: "", stderr: "" };
            // After exec: only the executor's edit is dirty.
            return {
              ok: true,
              stdout: " M src/evolve-edit.ts\0",
              stderr: "",
            };
          }
          if (args[0] === "restore" || args[0] === "clean") restoreCalls.push(args);
          return { ok: true, stdout: "", stderr: "" };
        },
      },
    });

    expect(result.outcome).toBe("verify-failed");
    // Every revert command must be pathspec-scoped, and must NOT touch the user's WIP file.
    expect(restoreCalls.length).toBeGreaterThan(0);
    for (const call of restoreCalls) {
      expect(call).toContain("--");
      expect(call).toContain("src/evolve-edit.ts");
      expect(call).not.toContain("user-wip.txt");
    }

    const revertEvents = eventsRepo.listEvents(db, { kindPrefix: "evolve.revert" });
    expect(revertEvents.length).toBeGreaterThanOrEqual(1);
  });

  test("exec failure reverts only exec-touched paths and skips verify", async () => {
    let verifyCalled = false;
    const restoreCalls: string[][] = [];
    let statusCalls = 0;

    const result = await evolveOnce(db, task({ id: "exec-blows", title: "exec blows up" }), tempRoot, {
      runExec: async () => ({ ok: false, exitCode: 7, stdout: "", stderr: "boom", durationMs: 1 }),
      gate: {
        runVerify: async () => {
          verifyCalled = true;
          return { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
        },
        runGit: async (_cwd, args) => {
          if (args[0] === "status") {
            statusCalls++;
            if (statusCalls === 1) return { ok: true, stdout: "", stderr: "" };
            return { ok: true, stdout: "?? half-applied.ts\0", stderr: "" };
          }
          if (args[0] === "restore" || args[0] === "clean") restoreCalls.push(args);
          return { ok: true, stdout: "", stderr: "" };
        },
      },
    });

    expect(result.outcome).toBe("exec-failed");
    expect(verifyCalled).toBe(false);
    expect(restoreCalls.length).toBeGreaterThan(0);
    for (const call of restoreCalls) {
      expect(call).toContain("--");
      expect(call).toContain("half-applied.ts");
    }
  });

  test("does not revert anything when nothing was touched (clean exec failure)", async () => {
    const restoreCalls: string[][] = [];

    await evolveOnce(db, task({ id: "clean-fail", title: "clean fail" }), tempRoot, {
      runExec: async () => ({ ok: false, exitCode: 1, stdout: "", stderr: "", durationMs: 1 }),
      gate: {
        runVerify: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
        runGit: async (_cwd, args) => {
          if (args[0] === "status") return { ok: true, stdout: "", stderr: "" };
          if (args[0] === "restore" || args[0] === "clean") restoreCalls.push(args);
          return { ok: true, stdout: "", stderr: "" };
        },
      },
    });

    expect(restoreCalls).toEqual([]);
  });

  test("already-dirty work is preserved without starting the executor", async () => {
    let executed = false;
    const gitCalls: string[][] = [];
    const result = await evolveOnce(db, task({ id: "preserve-wip", title: "preserve wip" }), tempRoot, {
      runExec: async () => {
        executed = true;
        return { ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
      },
      gate: {
        runGit: async (_cwd, args) => {
          gitCalls.push(args);
          return { ok: true, stdout: " M user-wip.txt\0?? new-notes.txt\0", stderr: "" };
        },
      },
    });
    expect(result.outcome).toBe("dirty-worktree");
    expect(result.dirtyPaths).toEqual(["new-notes.txt", "user-wip.txt"]);
    expect(result.reason).toContain("Commit or stash");
    expect(executed).toBe(false);
    expect(gitCalls).toHaveLength(1);
  });
});
