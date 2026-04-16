import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `start()` is one giant async main() that talks to the filesystem, spawns
// Claude, installs SIGTERM handlers, and finally calls `process.exit` on every
// validation branch. Trying to unit-test it in-process would either
// half-initialise the daemon or exit the test runner. So we do two things:
//
//   1. Import the module to prove it loads cleanly and exposes `start`.
//   2. Spawn the CLI in a subprocess for the argv-validation branches that
//      fail fast (they only touch argv parsing and stderr before exit).
//
// Happy-path daemon behaviour is covered by tests/smoke/*.

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
      child.kill("SIGKILL");
      reject(new Error("start subprocess timed out after 10s"));
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

describe("start module surface", () => {
  test("module imports cleanly and exports start()", async () => {
    const mod = await import("./start");
    expect(typeof mod.start).toBe("function");
    // The function is async; calling it without args would actually try to
    // boot the daemon, so we only assert its shape here.
    expect(mod.start.length).toBeGreaterThanOrEqual(0);
  });
});

describe("start flag validation (subprocess)", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hermes-start-flags-"));
    await mkdir(join(tempDir, ".claude", "hermes"), { recursive: true });
  });

  afterAll(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("--prompt without a payload exits 1 with usage hint", async () => {
    const result = await runStart(tempDir, ["--prompt"], {
      HERMES_CLAUDE_BIN: "bun run tests/fixtures/fake-claude.ts",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("usage");
  }, 15_000);

  test("bare payload without --prompt flag exits 1", async () => {
    const result = await runStart(tempDir, ["some", "stray", "words"], {
      HERMES_CLAUDE_BIN: "bun run tests/fixtures/fake-claude.ts",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("--prompt");
  }, 15_000);

  test("--telegram without --trigger exits 1", async () => {
    const result = await runStart(tempDir, ["--telegram"], {
      HERMES_CLAUDE_BIN: "bun run tests/fixtures/fake-claude.ts",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("telegram");
    expect(result.stderr.toLowerCase()).toContain("trigger");
  }, 15_000);

  test("--discord without --trigger exits 1", async () => {
    const result = await runStart(tempDir, ["--discord"], {
      HERMES_CLAUDE_BIN: "bun run tests/fixtures/fake-claude.ts",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("discord");
    expect(result.stderr.toLowerCase()).toContain("trigger");
  }, 15_000);
});
