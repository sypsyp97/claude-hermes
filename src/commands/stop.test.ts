import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// stop() calls `process.exit(0)` on every path, so we spawn the CLI in a
// subprocess and inspect stdout/exit code. The tests drive the three
// documented code paths:
//
//   1. no pid file           -> "No daemon is running", exit 0
//   2. pid file, dead pid    -> "already dead", exit 0
//   3. pid file, live pid    -> "Stopped daemon (PID X)", pid file gone,
//                               sacrificial child gets SIGTERM and exits.

const REPO_ROOT = process.cwd();

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runStop(cwd: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", join(REPO_ROOT, "src/index.ts"), "--stop"], {
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
      reject(new Error("stop subprocess timed out after 15s"));
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

function spawnSacrificialDaemon(): Promise<{ pid: number; child: ReturnType<typeof spawn> }> {
  // A tiny bun process that does nothing for 60s. We write its pid into the
  // pid file and expect stop() to SIGTERM it.
  return new Promise((resolve, reject) => {
    const child = spawn(
      "bun",
      ["-e", "setTimeout(() => process.exit(0), 60000); process.stdout.write('ready\\n');"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      }
    );
    let settled = false;
    const onReady = (buf: Buffer) => {
      if (buf.toString().includes("ready") && !settled) {
        settled = true;
        if (!child.pid) {
          reject(new Error("sacrificial daemon has no pid"));
          return;
        }
        resolve({ pid: child.pid, child });
      }
    };
    child.stdout?.on("data", onReady);
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        if (child.pid) {
          resolve({ pid: child.pid, child });
        } else {
          reject(new Error("sacrificial daemon never started"));
        }
      }
    }, 2_000);
  });
}

describe("stop command", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hermes-stop-"));
    await mkdir(join(tempDir, ".claude", "hermes"), { recursive: true });
  });

  afterAll(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("with no pid file: reports gracefully and exits 0", async () => {
    const result = await runStop(tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("no daemon");
  }, 20_000);

  test("with stale pid file (dead process): cleans up and exits 0", async () => {
    const pidFile = join(tempDir, ".claude", "hermes", "daemon.pid");
    // 999999999 is extremely unlikely to be a live pid. The kernel returns
    // ESRCH; stop() catches it and logs "already dead".
    await writeFile(pidFile, "999999999\n");

    const result = await runStop(tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toMatch(/already dead|no daemon/);

    // pid file should be gone after cleanup
    const stillThere = await Bun.file(pidFile)
      .text()
      .then(() => true)
      .catch(() => false);
    expect(stillThere).toBe(false);
  }, 20_000);

  test("with live pid file: SIGTERMs the process and removes pid file", async () => {
    const { pid, child } = await spawnSacrificialDaemon();
    try {
      const pidFile = join(tempDir, ".claude", "hermes", "daemon.pid");
      await writeFile(pidFile, `${pid}\n`);

      const result = await runStop(tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(String(pid));
      expect(result.stdout.toLowerCase()).toContain("stopped");

      // pid file should be removed
      const stillThere = await Bun.file(pidFile)
        .text()
        .then(() => true)
        .catch(() => false);
      expect(stillThere).toBe(false);

      // Wait briefly for the sacrificial process to exit
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        const t = setTimeout(resolve, 2_000);
        child.on("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    } finally {
      if (child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    }
  }, 25_000);
});
