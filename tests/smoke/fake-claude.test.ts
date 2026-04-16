import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";

const REPO_ROOT = process.cwd();

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runFake(args: string[], env: NodeJS.ProcessEnv = {}): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", "tests/fixtures/fake-claude.ts", ...args], {
      env: { ...process.env, ...env },
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (d) => stdout.push(Buffer.from(d)));
    child.stderr.on("data", (d) => stderr.push(Buffer.from(d)));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("fake-claude timed out after 10s"));
    }, 10_000);
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

describe("fake-claude fixture smoke", () => {
  test("default json output exits 0 with session_id and result=ok", async () => {
    const result = await runFake(["-p", "hello", "--output-format", "json"]);
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout.trim());
    expect(typeof parsed.session_id).toBe("string");
    expect(parsed.session_id.length).toBeGreaterThan(0);
    expect(parsed.result).toBe("ok");
  }, 15_000);

  test("env overrides set session_id and reply body", async () => {
    const result = await runFake(["-p", "hello", "--output-format", "json"], {
      HERMES_FAKE_REPLY: "hi",
      HERMES_FAKE_SESSION_ID: "abc123",
    });
    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.session_id).toBe("abc123");
    expect(parsed.result).toBe("hi");
  }, 15_000);

  test("stream-json emits three NDJSON events: system, assistant, result", async () => {
    const result = await runFake(["-p", "hello", "--output-format", "stream-json", "--verbose"]);
    expect(result.exitCode).toBe(0);

    const lines = result.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    expect(lines.length).toBe(3);

    const events = lines.map((l) => JSON.parse(l) as { type: string });
    expect(events[0]?.type).toBe("system");
    expect(events[1]?.type).toBe("assistant");
    expect(events[2]?.type).toBe("result");
  }, 15_000);

  test("HERMES_FAKE_EXIT controls the exit code", async () => {
    const result = await runFake(["-p", "hello", "--output-format", "json"], { HERMES_FAKE_EXIT: "42" });
    expect(result.exitCode).toBe(42);
  }, 15_000);
});
