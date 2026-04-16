import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = process.cwd();

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runStatus(cwd: string, env: NodeJS.ProcessEnv = {}): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", join(REPO_ROOT, "src/index.ts"), "status"], {
      cwd,
      env: { ...process.env, ...env },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (d) => stdout.push(Buffer.from(d)));
    child.stderr.on("data", (d) => stderr.push(Buffer.from(d)));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("status command timed out after 15s"));
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

describe("status CLI smoke", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hermes-smoke-status-"));
    await mkdir(join(tempDir, ".claude", "hermes"), { recursive: true });
  });

  afterAll(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("reports cleanly when no daemon is running", async () => {
    const result = await runStatus(tempDir, {
      HERMES_CLAUDE_BIN: "bun run tests/fixtures/fake-claude.ts",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);

    const haystack = `${result.stdout}\n${result.stderr}`.toLowerCase();
    const hasRecognizableMarker =
      haystack.includes("no daemon") ||
      haystack.includes("not running") ||
      haystack.includes("daemon is") ||
      haystack.includes("no running");
    expect(hasRecognizableMarker).toBe(true);
  }, 20_000);
});
