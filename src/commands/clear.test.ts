import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// clear() backs up session.json -> session_N.backup and then either stops
// the daemon (if one is running) or exits with a "no daemon" hint. Every
// branch calls process.exit(), so all tests spawn the CLI in a subprocess.

const REPO_ROOT = process.cwd();

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runClear(cwd: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", join(REPO_ROOT, "src/index.ts"), "--clear"], {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (d) => stdout.push(Buffer.from(d)));
    child.stderr.on("data", (d) => stderr.push(Buffer.from(d)));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("clear subprocess timed out after 15s"));
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

async function freshProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hermes-clear-"));
  await mkdir(join(dir, ".claude", "hermes"), { recursive: true });
  return dir;
}

describe("clear command", () => {
  const dirsToClean: string[] = [];

  afterAll(async () => {
    for (const d of dirsToClean) {
      try {
        await rm(d, { recursive: true, force: true });
      } catch {}
    }
  });

  test("no session + no daemon: logs 'no active session' and exits 0", async () => {
    const dir = await freshProject();
    dirsToClean.push(dir);

    const result = await runClear(dir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("no active session");
    expect(result.stdout.toLowerCase()).toContain("no daemon");
  }, 20_000);

  test("session present + no daemon: renames session.json → session_1.backup", async () => {
    const dir = await freshProject();
    dirsToClean.push(dir);

    const hermesDir = join(dir, ".claude", "hermes");
    const sessionFile = join(hermesDir, "session.json");
    const payload = JSON.stringify({
      sessionId: "abc-123",
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      turnCount: 0,
      compactWarned: false,
    });
    await writeFile(sessionFile, payload);

    const result = await runClear(dir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("backed up");

    // Original session.json should be gone
    const stillHasSession = await Bun.file(sessionFile)
      .text()
      .then(() => true)
      .catch(() => false);
    expect(stillHasSession).toBe(false);

    // A session_N.backup file should exist with the original payload
    const entries = await readdir(hermesDir);
    const backups = entries.filter((n) => /^session_\d+\.backup$/.test(n));
    expect(backups.length).toBe(1);
    expect(backups[0]).toBe("session_1.backup");

    const backupContent = await readFile(join(hermesDir, backups[0]!), "utf8");
    expect(backupContent).toContain("abc-123");
  }, 20_000);

  test("multiple prior backups: next backup picks the next numeric index", async () => {
    const dir = await freshProject();
    dirsToClean.push(dir);

    const hermesDir = join(dir, ".claude", "hermes");
    // Seed a couple of pre-existing backups so the next index should be 3
    await writeFile(join(hermesDir, "session_1.backup"), "first");
    await writeFile(join(hermesDir, "session_2.backup"), "second");

    // Live session file to back up
    await writeFile(
      join(hermesDir, "session.json"),
      JSON.stringify({
        sessionId: "live",
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
        turnCount: 0,
        compactWarned: false,
      })
    );

    const result = await runClear(dir);
    expect(result.exitCode).toBe(0);

    const entries = await readdir(hermesDir);
    const backups = entries.filter((n) => /^session_\d+\.backup$/.test(n)).sort();
    expect(backups).toContain("session_3.backup");
  }, 20_000);
});
