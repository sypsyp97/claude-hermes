import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, closeDb, eventsRepo, openDb, type Database } from "../../src/state";
import { evolveOnce, pickNext, fromGitHubIssues, type PendingTask } from "../../src/evolve";

let tempRoot: string;
let db: Database;

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(join(tmpdir(), "hermes-evolve-"));
  await fs.mkdir(join(tempRoot, ".claude", "hermes", "inbox", "evolve"), { recursive: true });
  db = openDb({ path: ":memory:" });
  await applyMigrations(db);
});

afterAll(async () => {
  closeDb(db);
  await fs.rm(tempRoot, { recursive: true, force: true });
});

async function writeInboxTask(id: string, body: string): Promise<void> {
  const path = join(tempRoot, ".claude", "hermes", "inbox", "evolve", `${id}.md`);
  await fs.writeFile(path, body, "utf8");
}

describe("planner", () => {
  test("highest votes wins, downvoted tasks skipped", () => {
    const tasks: PendingTask[] = [
      { id: "a", source: "local", title: "a", body: "", votes: 2, createdAt: "2026-04-16T00:00:00Z" },
      { id: "b", source: "local", title: "b", body: "", votes: 5, createdAt: "2026-04-15T00:00:00Z" },
      { id: "c", source: "local", title: "c", body: "", votes: -1, createdAt: "2026-04-14T00:00:00Z" },
    ];
    expect(pickNext(tasks)?.id).toBe("b");
  });
});

describe("github adapter", () => {
  test("filters by label and uses vote math", () => {
    const tasks = fromGitHubIssues(
      [
        {
          id: 1,
          title: "fix X",
          labels: [{ name: "hermes-input" }],
          reactions: { "+1": 10, "-1": 2 },
          created_at: "2026-04-16T00:00:00Z",
        },
        {
          id: 2,
          title: "unrelated",
          labels: [{ name: "bug" }],
          reactions: { "+1": 99 },
          created_at: "2026-04-16T00:00:00Z",
        },
      ],
      "hermes-input"
    );
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.votes).toBe(8);
  });
});

describe("evolveOnce — fake executor", () => {
  test("commits when exec + verify are green", async () => {
    await writeInboxTask("green-task", "---\nvotes: 3\nsource: local\n---\n# green task\nbody here\n");

    let committed = false;
    const result = await evolveOnce(db, tempRoot, {
      runExec: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
      gate: {
        runVerify: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
        runGit: async (_cwd, args) => {
          if (args[0] === "status") return { ok: true, stdout: " M file\n", stderr: "" };
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
    expect(committed).toBe(true);
    expect(result.sha).toBe("deadbeefcafe");
  });

  test("reverts when verify is red", async () => {
    await writeInboxTask("red-task", "---\nvotes: 1\n---\n# red\n");
    let reverted = 0;

    const result = await evolveOnce(db, tempRoot, {
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
          if (args[0] === "restore" || args[0] === "clean") reverted++;
          return { ok: true, stdout: "", stderr: "" };
        },
      },
    });

    expect(result.outcome).toBe("verify-failed");
    expect(reverted).toBeGreaterThan(0);

    const revertEvents = eventsRepo.listEvents(db, { kindPrefix: "evolve.revert" });
    expect(revertEvents.length).toBeGreaterThanOrEqual(1);
  });

  test("no-tasks outcome when inbox is empty", async () => {
    const emptyRoot = await fs.mkdtemp(join(tmpdir(), "hermes-evolve-empty-"));
    try {
      const result = await evolveOnce(db, emptyRoot);
      expect(result.outcome).toBe("no-tasks");
    } finally {
      await fs.rm(emptyRoot, { recursive: true, force: true });
    }
  });
});
