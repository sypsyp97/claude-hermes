import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { executeSelfEdit } from "./executor";

const ORIG_CWD = process.cwd();
const REPO_ROOT = process.cwd();
const FAKE_CLAUDE = `bun run ${resolve(REPO_ROOT, "tests/fixtures/fake-claude.ts")}`;

let tempRoot: string;

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "hermes-evolve-executor-"));
});

afterAll(async () => {
  process.chdir(ORIG_CWD);
  // Make sure any fake-claude env leakage is cleaned up so other tests in
  // the same process start clean.
  delete process.env.HERMES_FAKE_REPLY;
  delete process.env.HERMES_FAKE_EXIT;
  delete process.env.HERMES_FAKE_STDERR;
  delete process.env.HERMES_FAKE_RATE_LIMIT;
  delete process.env.HERMES_FAKE_DELAY_MS;
  delete process.env.HERMES_FAKE_ECHO_PROMPT;
  await rm(tempRoot, { recursive: true, force: true });
});

describe("executeSelfEdit — happy path", () => {
  test("returns ok=true and captures fake-claude stdout", async () => {
    process.env.HERMES_FAKE_REPLY = "self-edit complete";
    delete process.env.HERMES_FAKE_EXIT;
    delete process.env.HERMES_FAKE_STDERR;
    delete process.env.HERMES_FAKE_RATE_LIMIT;

    const result = await executeSelfEdit({
      prompt: "plan-a-small-edit",
      cwd: tempRoot,
      claudeBin: FAKE_CLAUDE,
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("self-edit complete");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.stderr).toBe("string");
  }, 20_000);

  test("passes the prompt through to fake-claude via -p (echoed back on request)", async () => {
    delete process.env.HERMES_FAKE_REPLY;
    process.env.HERMES_FAKE_ECHO_PROMPT = "1";

    const result = await executeSelfEdit({
      prompt: "unique-prompt-abc-123",
      cwd: tempRoot,
      claudeBin: FAKE_CLAUDE,
    });

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("unique-prompt-abc-123");

    delete process.env.HERMES_FAKE_ECHO_PROMPT;
  }, 20_000);

  test("forwards systemPrompt via --append-system-prompt without breaking", async () => {
    process.env.HERMES_FAKE_REPLY = "with system prompt";
    const result = await executeSelfEdit({
      prompt: "go",
      systemPrompt: "you are an evolve subagent",
      cwd: tempRoot,
      claudeBin: FAKE_CLAUDE,
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("with system prompt");
    delete process.env.HERMES_FAKE_REPLY;
  }, 20_000);
});

describe("executeSelfEdit — failure paths", () => {
  test("non-zero exit surfaces ok=false and captured stderr", async () => {
    process.env.HERMES_FAKE_EXIT = "3";
    process.env.HERMES_FAKE_STDERR = "boom from fake-claude";
    delete process.env.HERMES_FAKE_REPLY;
    delete process.env.HERMES_FAKE_RATE_LIMIT;

    const result = await executeSelfEdit({
      prompt: "will-fail",
      cwd: tempRoot,
      claudeBin: FAKE_CLAUDE,
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("boom from fake-claude");

    delete process.env.HERMES_FAKE_EXIT;
    delete process.env.HERMES_FAKE_STDERR;
  }, 20_000);

  test("rate-limit scenario lands in stderr with non-zero exit", async () => {
    process.env.HERMES_FAKE_RATE_LIMIT = "1";
    delete process.env.HERMES_FAKE_EXIT;
    delete process.env.HERMES_FAKE_STDERR;

    const result = await executeSelfEdit({
      prompt: "rate-limited",
      cwd: tempRoot,
      claudeBin: FAKE_CLAUDE,
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain("limit");

    delete process.env.HERMES_FAKE_RATE_LIMIT;
  }, 20_000);

  test("proc.on('error') (bin missing) resolves with ok=false and exitCode=-1", async () => {
    const result = await executeSelfEdit({
      prompt: "nope",
      cwd: tempRoot,
      // Point at a binary that does not exist anywhere on PATH.
      claudeBin: "claude-does-not-exist-xyz-404",
    });
    expect(result.ok).toBe(false);
    // On proc.on('error'): exitCode is -1; on immediate spawn close: still non-zero.
    expect(result.exitCode === -1 || result.exitCode > 0).toBe(true);
    expect(typeof result.stderr).toBe("string");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  }, 20_000);
});

describe("executeSelfEdit — timeout", () => {
  test("kills the subprocess and returns a result when the timeout fires", async () => {
    // fake-claude respects HERMES_FAKE_DELAY_MS before writing. Give it a
    // longer delay than the executor's timeout.
    process.env.HERMES_FAKE_DELAY_MS = "5000";
    process.env.HERMES_FAKE_REPLY = "should be killed before writing";

    const result = await executeSelfEdit({
      prompt: "hangs",
      cwd: tempRoot,
      claudeBin: FAKE_CLAUDE,
      timeoutMs: 200,
    });

    // SIGTERM on POSIX or killed process on Windows — either way the promise
    // must resolve with ok=false once the timer fires.
    expect(result.ok).toBe(false);
    expect(result.stdout).not.toContain("should be killed before writing");

    delete process.env.HERMES_FAKE_DELAY_MS;
    delete process.env.HERMES_FAKE_REPLY;
  }, 20_000);
});

describe("executeSelfEdit — bin resolution", () => {
  test("opts.claudeBin overrides HERMES_CLAUDE_BIN env var", async () => {
    // Point env at something broken; opts.claudeBin should win.
    const prevBin = process.env.HERMES_CLAUDE_BIN;
    process.env.HERMES_CLAUDE_BIN = "claude-fake-env-would-fail";
    process.env.HERMES_FAKE_REPLY = "override worked";

    try {
      const result = await executeSelfEdit({
        prompt: "ok",
        cwd: tempRoot,
        claudeBin: FAKE_CLAUDE,
      });
      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("override worked");
    } finally {
      if (prevBin === undefined) delete process.env.HERMES_CLAUDE_BIN;
      else process.env.HERMES_CLAUDE_BIN = prevBin;
      delete process.env.HERMES_FAKE_REPLY;
    }
  }, 20_000);
});
