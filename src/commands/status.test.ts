import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// status.ts captures HEARTBEAT_DIR = hermesDir() at module load time, so we
// chdir into the temp dir BEFORE the first dynamic import (same trick as
// src/jobs.test.ts). Each test resets the .claude/hermes contents between
// runs.

const ORIG_CWD = process.cwd();
const TEMP_DIR = join(tmpdir(), `hermes-status-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const HERMES_DIR = join(TEMP_DIR, ".claude", "hermes");
const PID_FILE = join(HERMES_DIR, "daemon.pid");
const SETTINGS_FILE = join(HERMES_DIR, "settings.json");
const JOBS_DIR = join(HERMES_DIR, "jobs");
const STATE_FILE = join(HERMES_DIR, "state.json");

await mkdir(HERMES_DIR, { recursive: true });
process.chdir(TEMP_DIR);
const { status } = await import("./status");

interface CapturedLog {
  lines: string[];
  restore: () => void;
}

function captureConsole(): CapturedLog {
  const original = console.log;
  const originalErr = console.error;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.log = original;
      console.error = originalErr;
    },
  };
}

function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escape sequences is the whole point
  return s.replace(/\x1b\[\d+m/g, "");
}

async function resetHermesDir(): Promise<void> {
  await rm(HERMES_DIR, { recursive: true, force: true });
  await mkdir(HERMES_DIR, { recursive: true });
  await mkdir(JOBS_DIR, { recursive: true });
}

beforeAll(async () => {
  await resetHermesDir();
});

afterEach(async () => {
  await resetHermesDir();
});

afterAll(async () => {
  process.chdir(ORIG_CWD);
  await rm(TEMP_DIR, { recursive: true, force: true });
});

describe("status (no --all)", () => {
  test("no pid file: reports daemon not running", async () => {
    const cap = captureConsole();
    try {
      await status([]);
    } finally {
      cap.restore();
    }
    const combined = stripAnsi(cap.lines.join("\n")).toLowerCase();
    expect(combined).toContain("not running");
  });

  test("pid file with dead pid: still reports not running", async () => {
    await writeFile(PID_FILE, "999999999\n");
    const cap = captureConsole();
    try {
      await status([]);
    } finally {
      cap.restore();
    }
    const combined = stripAnsi(cap.lines.join("\n")).toLowerCase();
    expect(combined).toContain("not running");
  });

  test("pid file with live pid + settings + state: reports running and prints heartbeat info", async () => {
    // Use our own pid; `process.kill(pid, 0)` will succeed.
    await writeFile(PID_FILE, `${process.pid}\n`);
    await writeFile(
      SETTINGS_FILE,
      JSON.stringify({
        heartbeat: { enabled: true, interval: 30, excludeWindows: [] },
        timezone: "UTC",
      })
    );
    // Minimal state file to exercise the countdown formatter
    await writeFile(
      STATE_FILE,
      JSON.stringify({
        heartbeat: { nextAt: Date.now() + 2 * 60 * 60 * 1000 }, // ~2h
        jobs: [{ name: "demo", nextAt: Date.now() + 5 * 60 * 1000 }],
      })
    );
    await writeFile(join(JOBS_DIR, "demo.md"), `---\nschedule: "* * * * *"\nrecurring: true\n---\nDemo body`);

    const cap = captureConsole();
    try {
      await status([]);
    } finally {
      cap.restore();
    }
    const combined = stripAnsi(cap.lines.join("\n")).toLowerCase();
    expect(combined).toContain("daemon is running");
    expect(combined).toContain(String(process.pid));
    expect(combined).toContain("every 30m");
    expect(combined).toContain("jobs: 1");
    expect(combined).toContain("demo");
    // Timezone line is only logged when heartbeat is enabled
    expect(combined).toContain("timezone");
  });
});

describe("status --all", () => {
  test("returns a 'no running daemons' message when --all is requested", async () => {
    // --all scans ~/.claude/projects; we won't try to make it find our pid
    // there (that would require touching the real user's HOME). We just
    // check the code path emits the right message when nothing is alive.
    const cap = captureConsole();
    try {
      await status(["--all"]);
    } finally {
      cap.restore();
    }
    const combined = stripAnsi(cap.lines.join("\n")).toLowerCase();
    // Either "no running daemons" (empty home) or "running" (if the host
    // genuinely has live daemons for other projects). Both are valid — we
    // only assert the call did not throw and produced output.
    expect(cap.lines.length).toBeGreaterThan(0);
    expect(combined).toMatch(/no running daemons|running daemon/);
  });
});
