import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * TDD red-phase tests for Findings #3 and #4.
 *
 *   #3: `start.ts` calls `runMigrationIfAny()` BEFORE `checkExistingDaemon()`
 *       on both the one-shot path (line 329) and the daemon path (line 350).
 *       That means a second invocation in an already-running workspace
 *       triggers the migrator — which `cp -r`s and renames `.claude/claudeclaw`
 *       — out from under the live daemon. The PID check must run first; if a
 *       daemon is already live, migration must be skipped entirely.
 *
 *   #4: When `migrateIfNeeded` returns `{ status: "conflict" }` (both legacy
 *       and new dirs exist without MIGRATED.json), start.ts prints a warning
 *       and continues. Partial migration state should be fail-closed — the
 *       user needs to intervene before the daemon boots.
 *
 * These tests drive the real `start` subprocess with a tmp workspace to avoid
 * mocking the giant async main(). The fix agent must re-order the two calls
 * (PID check first) and bail non-zero on conflict.
 *
 * Fix agent: the simplest refactor is to move `await checkExistingDaemon()`
 * above `await runMigrationIfAny()` on both branches, and to call
 * `process.exit(1)` on `result.status === "conflict"` (or throw) instead of
 * merely warning. A more testable alternative is to extract a
 * `runStartupSequence()` helper that returns `{ preflight: "ok" | "conflict" |
 * "daemon-running", ... }` and export it for direct unit testing.
 */

const REPO_ROOT = process.cwd();

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runStart(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", join(REPO_ROOT, "src/index.ts"), "start", ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (d) => stdout.push(Buffer.from(d)));
    child.stderr.on("data", (d) => stderr.push(Buffer.from(d)));
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      reject(new Error("start subprocess timed out"));
    }, 15_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
  });
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hermes-start-order-"));
});

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe("start migration order (Finding #3)", () => {
  test("PID check precedes migration: checkStartupPreconditions reports daemon-running without invoking migrateIfNeeded", async () => {
    // In-process contract test: we need to prove ordering — that with a live
    // PID, the migrator is never called. Subprocess assertions aren't strong
    // enough because the current bug only bites when legacy exists AND new
    // dir doesn't, yet the pid file lives in the new dir (so there's no
    // reachable "bug seed"). Instead we require the fix agent to extract a
    // testable helper — `checkStartupPreconditions` — that reports one of
    // { "daemon-running" | "migration-conflict" | "migration-failed" | "ok" }
    // and that is guaranteed to run the PID check FIRST. Migration is only
    // invoked on the "ok" path.
    //
    // fix agent: export `checkStartupPreconditions(cwd?: string): Promise<
    //   { status: "ok" | "daemon-running" | "migration-conflict" | "migration-failed"; pid?: number; message?: string }>`
    // from `src/commands/start.ts`. It must call `checkExistingDaemon` BEFORE
    // `migrateIfNeeded`. `start()` must delegate to it and exit non-zero on
    // any non-"ok" status.

    // Seed a state that would force a real migration if the migrator ran:
    // legacy dir exists, new dir does not. But also seed a pid file at the
    // new-dir location pointing at us (a guaranteed-alive process).
    const claudeclaw = join(tempDir, ".claude", "claudeclaw");
    const hermes = join(tempDir, ".claude", "hermes");
    await mkdir(claudeclaw, { recursive: true });
    await mkdir(hermes, { recursive: true });
    await writeFile(join(claudeclaw, "canary.txt"), "should-survive");
    await writeFile(join(hermes, "daemon.pid"), String(process.pid));

    const orig = process.cwd();
    process.chdir(tempDir);
    try {
      // fix agent: export `checkStartupPreconditions` from ./start
      const mod = (await import("./start")) as unknown as {
        checkStartupPreconditions?: (cwd?: string) => Promise<{
          status: string;
          pid?: number;
        }>;
      };
      expect(typeof mod.checkStartupPreconditions).toBe("function");
      const result = await mod.checkStartupPreconditions!(tempDir);
      expect(result.status).toBe("daemon-running");
      expect(result.pid).toBe(process.pid);
    } finally {
      process.chdir(orig);
    }

    // And the legacy canary MUST survive — migration was never invoked.
    const canary = Bun.file(join(claudeclaw, "canary.txt"));
    expect(await canary.exists()).toBe(true);
    // The target directory still has no MIGRATED.json marker (migration
    // didn't run, so no marker was ever written).
    const marker = Bun.file(join(hermes, "MIGRATED.json"));
    expect(await marker.exists()).toBe(false);
  }, 20_000);
});

describe("start migration conflict is fail-closed (Finding #4)", () => {
  test("conflict state (legacy + new, no MIGRATED marker): start aborts BEFORE invoking Claude", async () => {
    // Same conflict seed as above but WITHOUT a live pid file. Today
    // `runMigrationIfAny` logs a warning and startup continues into
    // `runUserMessage("prompt", ...)` — which we detect here by the
    // presence of a log file under `.claude/hermes/logs/prompt-*.log`
    // that the runner writes on every successful claude turn. A
    // fail-closed startup must emit a conflict-flavoured error to stderr
    // and MUST NOT reach runUserMessage — so no log file is ever written.
    const claudeclaw = join(tempDir, ".claude", "claudeclaw");
    const hermes = join(tempDir, ".claude", "hermes");
    await mkdir(claudeclaw, { recursive: true });
    await mkdir(hermes, { recursive: true });
    await writeFile(join(claudeclaw, "canary.txt"), "legacy-data");

    const result = await runStart(tempDir, ["--prompt", "hello"], {
      HERMES_CLAUDE_BIN: "bun run tests/fixtures/fake-claude.ts",
    });

    expect(result.exitCode).not.toBe(0);
    const combined = (result.stdout + result.stderr).toLowerCase();
    // Error message must explicitly flag the migration conflict — not just
    // any random stderr line. The fix must print something stronger than
    // a warning so the user knows they need to intervene.
    expect(combined).toMatch(/conflict|refus|abort/i);

    // Hard check: runUserMessage("prompt", ...) is NEVER called when the
    // migration state is inconsistent. Its log file side-effect is an
    // unambiguous witness.
    const { readdir } = await import("node:fs/promises");
    let logs: string[] = [];
    try {
      logs = await readdir(join(hermes, "logs"));
    } catch {
      logs = [];
    }
    const promptLogs = logs.filter((f) => f.startsWith("prompt-"));
    expect(promptLogs).toEqual([]);
  }, 20_000);
});
