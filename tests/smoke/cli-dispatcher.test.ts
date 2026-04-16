import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const ENTRY = join(REPO_ROOT, "src", "index.ts");

interface Result {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function spawnDispatcher(args: string[], cwd: string, timeoutMs = 15_000): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", ENTRY, ...args], {
      cwd,
      env: {
        ...process.env,
        HERMES_CLAUDE_BIN: `bun run ${join(REPO_ROOT, "tests", "fixtures", "fake-claude.ts")}`,
        HERMES_SKIP_PREFLIGHT: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d) => out.push(Buffer.from(d)));
    child.stderr.on("data", (d) => err.push(Buffer.from(d)));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`dispatcher ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
  });
}

describe("CLI dispatcher routing", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hermes-cli-dispatch-"));
    await mkdir(join(tempDir, ".claude", "hermes"), { recursive: true });
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("--stop with no running daemon exits 0 and reports no daemon", async () => {
    const r = await spawnDispatcher(["--stop"], tempDir);
    expect(r.exitCode).toBe(0);
    const text = `${r.stdout}\n${r.stderr}`.toLowerCase();
    expect(text).toContain("no daemon");
  });

  test("--clear with no active session exits 0 and reports no daemon", async () => {
    const r = await spawnDispatcher(["--clear"], tempDir);
    expect(r.exitCode).toBe(0);
    const text = `${r.stdout}\n${r.stderr}`.toLowerCase();
    // backupSession reports "No active session to back up." then "No daemon running."
    expect(text).toMatch(/no active session|no daemon/);
  });

  test("--stop-all exits 0 even when no daemons are tracked", async () => {
    const r = await spawnDispatcher(["--stop-all"], tempDir);
    expect(r.exitCode).toBe(0);
    const text = `${r.stdout}\n${r.stderr}`.toLowerCase();
    expect(text).toMatch(/no projects|no running daemons|stopped/);
  });

  test("--prompt without text errors with usage hint", async () => {
    // start.ts validates flag combinations BEFORE spawning the daemon, so this
    // exits cleanly without ever opening a session.
    const r = await spawnDispatcher(["start", "--prompt"], tempDir);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("usage");
  });

  test("payload without --prompt errors with the right hint", async () => {
    const r = await spawnDispatcher(["start", "hello"], tempDir);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("--prompt");
  });

  test("--telegram without --trigger errors with the trigger requirement", async () => {
    const r = await spawnDispatcher(["start", "--telegram"], tempDir);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("trigger");
  });
});
