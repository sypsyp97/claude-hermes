/**
 * Real-git integration test for the evolve loop. Spins up an isolated git
 * worktree in a tmp dir, drops a pending task, runs `evolveOnce` with REAL
 * git (no `runGit` injection — `defaultGit` spawns the actual `git` binary),
 * and asserts:
 *
 *   - GREEN verify → a new commit lands on HEAD with the executor's edit.
 *   - RED verify → the executor's edit is wiped and HEAD is unchanged.
 *
 * Only the verify gate and the exec step are stubbed; everything to do with
 * git (status, add, commit, restore, clean -fd, rev-parse) goes through the
 * real binary. This is the only test in the suite that proves the
 * commit/revert cycle works against an actual repo.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evolveOnce } from "../../src/evolve/loop";
import { applyMigrations, closeDb, type Database, openDb } from "../../src/state";
import { listEvents } from "../../src/state/repos/events";

let tmpRepo: string;
let db: Database;

function runGitSync(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function gitMustSucceed(cwd: string, args: string[]): string {
  const r = runGitSync(cwd, args);
  if (!r.ok) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

beforeAll(async () => {
  tmpRepo = mkdtempSync(join(tmpdir(), "hermes-evolve-realgit-"));
  // Initialise repo with deterministic main branch + identity so commits
  // don't pick up the host's git config (some CI machines have no user set).
  gitMustSucceed(tmpRepo, ["init", "-q", "-b", "main"]);
  gitMustSucceed(tmpRepo, ["config", "user.email", "evolve-test@hermes.local"]);
  gitMustSucceed(tmpRepo, ["config", "user.name", "Evolve Test"]);
  // Disable any global commit hooks / signing so the test never blocks on
  // missing keys or husky-style guards.
  gitMustSucceed(tmpRepo, ["config", "commit.gpgsign", "false"]);
  // Pin line endings so `git restore .` doesn't introduce CRLF on Windows.
  gitMustSucceed(tmpRepo, ["config", "core.autocrlf", "false"]);
  gitMustSucceed(tmpRepo, ["config", "core.eol", "lf"]);

  await writeFile(join(tmpRepo, "README.md"), "# evolve target\n", "utf8");
  // Mirror production: `.claude/` is gitignored, so inbox files survive
  // `git clean -fd` during a verify-failed revert.
  await writeFile(join(tmpRepo, ".gitignore"), ".claude/\n", "utf8");
  gitMustSucceed(tmpRepo, ["add", "README.md", ".gitignore"]);
  gitMustSucceed(tmpRepo, ["commit", "-q", "-m", "initial"]);

  // Drop a pending task into the local evolve inbox.
  mkdirSync(join(tmpRepo, ".claude", "hermes", "inbox", "evolve"), { recursive: true });
  await writeFile(
    join(tmpRepo, ".claude", "hermes", "inbox", "evolve", "tweak-readme.md"),
    [
      "---",
      "votes: 7",
      "source: local",
      "createdAt: 2026-04-16T10:00:00Z",
      "---",
      "",
      "# Tweak README",
      "",
      "Make the README more verbose.",
      "",
    ].join("\n"),
    "utf8"
  );

  db = openDb({ path: ":memory:" });
  await applyMigrations(db);
});

afterAll(() => {
  closeDb(db);
  rmSync(tmpRepo, { recursive: true, force: true });
});

describe("evolve loop with real git", () => {
  test("GREEN verify: real git commit lands on HEAD with the executor's edit", async () => {
    const headBefore = gitMustSucceed(tmpRepo, ["rev-parse", "HEAD"]);

    const result = await evolveOnce(db, tmpRepo, {
      // Executor actually edits a file in the repo.
      async runExec({ cwd }) {
        await writeFile(
          join(cwd, "README.md"),
          "# evolve target\n\nNow with more lines.\nAnd another.\n",
          "utf8"
        );
        return { ok: true, exitCode: 0, durationMs: 1, stdout: "", stderr: "" };
      },
      // Gate: verify passes. We only inject verify; the git side runs for real.
      gate: {
        async runVerify() {
          return { ok: true, exitCode: 0, durationMs: 1, stdout: "", stderr: "" };
        },
      },
    });

    expect(result.outcome).toBe("committed");
    expect(result.task?.id).toBe("tweak-readme");
    expect(result.sha).toBeDefined();
    expect(result.sha?.length).toBeGreaterThan(20);

    const headAfter = gitMustSucceed(tmpRepo, ["rev-parse", "HEAD"]);
    expect(headAfter).not.toBe(headBefore);
    expect(headAfter).toBe(result.sha as string);

    // The committed README should contain our new content.
    const readme = await readFile(join(tmpRepo, "README.md"), "utf8");
    expect(readme).toContain("Now with more lines.");

    // Working tree should be clean — no leftover modifications.
    const status = gitMustSucceed(tmpRepo, ["status", "--porcelain"]);
    expect(status).toBe("");

    // Journal should record the commit event.
    const events = listEvents(db, { kindPrefix: "evolve.commit" });
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  test("RED verify: real git wipes the executor's changes and HEAD doesn't move", async () => {
    // Reset the inbox so a fresh task is available — the previous test's
    // task has been "consumed" only in the sense that the file is still
    // there (planner re-picks it). To keep this test independent we add a
    // distinct second task and remove the first to make ordering
    // deterministic.
    rmSync(join(tmpRepo, ".claude", "hermes", "inbox", "evolve", "tweak-readme.md"), {
      force: true,
    });
    await writeFile(
      join(tmpRepo, ".claude", "hermes", "inbox", "evolve", "broken-edit.md"),
      [
        "---",
        "votes: 9",
        "source: local",
        "createdAt: 2026-04-16T11:00:00Z",
        "---",
        "",
        "# Apply broken edit",
        "",
        "Whatever the agent writes, verify will reject it.",
        "",
      ].join("\n"),
      "utf8"
    );

    const headBefore = gitMustSucceed(tmpRepo, ["rev-parse", "HEAD"]);
    const readmeBefore = await readFile(join(tmpRepo, "README.md"), "utf8");

    const result = await evolveOnce(db, tmpRepo, {
      async runExec({ cwd }) {
        // Make a destructive-looking change.
        await writeFile(join(cwd, "README.md"), "BROKEN\n", "utf8");
        // Also create a brand-new untracked file — `git restore` won't help
        // here; only `clean -fd` removes it. revertAll runs both.
        await writeFile(join(cwd, "garbage.txt"), "junk\n", "utf8");
        return { ok: true, exitCode: 0, durationMs: 1, stdout: "", stderr: "" };
      },
      gate: {
        async runVerify() {
          return {
            ok: false,
            exitCode: 1,
            durationMs: 1,
            stdout: "",
            stderr: "verify said no",
          };
        },
      },
    });

    expect(result.outcome).toBe("verify-failed");
    expect(result.verify?.ok).toBe(false);

    const headAfter = gitMustSucceed(tmpRepo, ["rev-parse", "HEAD"]);
    expect(headAfter).toBe(headBefore); // no new commit

    const readmeAfter = await readFile(join(tmpRepo, "README.md"), "utf8");
    expect(readmeAfter).toBe(readmeBefore); // restored

    // Untracked garbage.txt was removed by `git clean -fd`.
    const status = gitMustSucceed(tmpRepo, ["status", "--porcelain"]);
    expect(status).toBe("");

    // Journal should record the revert event.
    const events = listEvents(db, { kindPrefix: "evolve.revert" });
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  test("no tasks: outcome is 'no-tasks' and no journal commit/revert event fires", async () => {
    // Empty the inbox.
    rmSync(join(tmpRepo, ".claude", "hermes", "inbox", "evolve", "broken-edit.md"), {
      force: true,
    });

    const beforeCommit = listEvents(db, { kindPrefix: "evolve.commit" }).length;
    const beforeRevert = listEvents(db, { kindPrefix: "evolve.revert" }).length;

    const result = await evolveOnce(db, tmpRepo, {
      async runExec() {
        throw new Error("runExec must not be called when there are no tasks");
      },
    });

    expect(result.outcome).toBe("no-tasks");
    expect(result.task).toBeUndefined();

    const afterCommit = listEvents(db, { kindPrefix: "evolve.commit" }).length;
    const afterRevert = listEvents(db, { kindPrefix: "evolve.revert" }).length;
    expect(afterCommit).toBe(beforeCommit);
    expect(afterRevert).toBe(beforeRevert);

    // But a skip event WAS recorded.
    const skipEvents = listEvents(db, { kindPrefix: "evolve.skip" });
    expect(skipEvents.length).toBeGreaterThanOrEqual(1);
  });

  test("exec failure: real git wipes changes, no commit, no verify run", async () => {
    // Add a task so planner has something to work on.
    await writeFile(
      join(tmpRepo, ".claude", "hermes", "inbox", "evolve", "exec-blows-up.md"),
      [
        "---",
        "votes: 5",
        "source: local",
        "createdAt: 2026-04-16T12:00:00Z",
        "---",
        "",
        "# Exec will fail",
        "",
        "Subagent crashes.",
        "",
      ].join("\n"),
      "utf8"
    );

    const headBefore = gitMustSucceed(tmpRepo, ["rev-parse", "HEAD"]);
    let verifyWasCalled = false;

    const result = await evolveOnce(db, tmpRepo, {
      async runExec({ cwd }) {
        // Subagent left some changes on disk before crashing.
        await writeFile(join(cwd, "README.md"), "PARTIAL EDIT\n", "utf8");
        await writeFile(join(cwd, "untracked-side-file.txt"), "x\n", "utf8");
        return {
          ok: false,
          exitCode: 7,
          durationMs: 1,
          stdout: "",
          stderr: "boom",
        };
      },
      gate: {
        async runVerify() {
          verifyWasCalled = true;
          return { ok: true, exitCode: 0, durationMs: 1, stdout: "", stderr: "" };
        },
      },
    });

    expect(result.outcome).toBe("exec-failed");
    expect(result.exec?.exitCode).toBe(7);
    expect(verifyWasCalled).toBe(false); // gate must short-circuit when exec fails

    const headAfter = gitMustSucceed(tmpRepo, ["rev-parse", "HEAD"]);
    expect(headAfter).toBe(headBefore);

    const status = gitMustSucceed(tmpRepo, ["status", "--porcelain"]);
    expect(status).toBe(""); // clean

    // cleanup
    rmSync(join(tmpRepo, ".claude", "hermes", "inbox", "evolve", "exec-blows-up.md"), {
      force: true,
    });
  });
});
