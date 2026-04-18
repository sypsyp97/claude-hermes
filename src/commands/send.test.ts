import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// send() always calls process.exit() on one of: usage error, missing
// session, or after the claude invocation finishes. We spawn the CLI in a
// subprocess and pin HERMES_CLAUDE_BIN at the fake-claude fixture so no real
// claude binary is required.

const REPO_ROOT = process.cwd();
// HERMES_CLAUDE_BIN resolves relative to the subprocess cwd, so we pass the
// absolute path to the fixture (otherwise Bun can't find it from a tmp dir).
const FAKE_CLAUDE_ABS = join(REPO_ROOT, "tests/fixtures/fake-claude.ts");
const FAKE_CLAUDE_BIN = `bun run ${FAKE_CLAUDE_ABS}`;

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

function runSend(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", join(REPO_ROOT, "src/index.ts"), "send", ...args], {
      cwd,
      env: {
        ...process.env,
        HERMES_CLAUDE_BIN: FAKE_CLAUDE_BIN,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (d) => stdout.push(Buffer.from(d)));
    child.stderr.on("data", (d) => stderr.push(Buffer.from(d)));
    // send() does not always call process.exit() — on exit code 0 it returns
    // cleanly and relies on Bun to close once the event loop is idle. Runner
    // internals keep a 5-minute setTimeout alive (the Claude invocation
    // guard), so we grace-kill after a short quiet period and SURFACE the
    // signal verbatim. Do NOT silently normalise SIGKILL to exitCode 0 —
    // that masks real process-exit regressions. Tests that genuinely rely
    // on the grace-kill fallback must tolerate `signal === "SIGKILL"`
    // explicitly.
    let closed = false;
    const killer = setTimeout(() => {
      if (!closed) {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    }, 5_000);
    const hardTimer = setTimeout(() => {
      if (!closed) {
        try {
          child.kill("SIGKILL");
        } catch {}
        reject(new Error("send subprocess did not terminate within 30s"));
      }
    }, 30_000);
    child.on("error", (err) => {
      closed = true;
      clearTimeout(killer);
      clearTimeout(hardTimer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      closed = true;
      clearTimeout(killer);
      clearTimeout(hardTimer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code,
        signal: signal as NodeJS.Signals | null,
      });
    });
  });
}

/**
 * Tests that care about "did send succeed?" use this helper. It treats
 * a real exit 0 AND a grace-kill SIGKILL-after-completion as success,
 * but NEVER conflates an arbitrary non-zero exit with success. The
 * distinction matters: Finding #9 was that the old `runSend` collapsed
 * SIGKILL → 0, hiding regressions where `send` actually exited non-zero
 * but happened to be killed before the parent observed the code.
 */
function sendSucceeded(result: SpawnResult): boolean {
  if (result.exitCode === 0) return true;
  if (result.exitCode === null && result.signal === "SIGKILL") return true;
  return false;
}

function sendFailed(result: SpawnResult): boolean {
  // Explicitly non-zero exit. null + SIGKILL is ambiguous for failure
  // assertions — treat it as "inconclusive" (neither pass nor fail).
  return typeof result.exitCode === "number" && result.exitCode !== 0;
}

async function freshProject(opts: { withSettings?: boolean; withSession?: boolean }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hermes-send-"));
  const hermesDir = join(dir, ".claude", "hermes");
  await mkdir(hermesDir, { recursive: true });
  if (opts.withSettings !== false) {
    // initConfig() will write defaults if missing; providing an empty
    // settings.json avoids needing initConfig's default write logic.
    await writeFile(
      join(hermesDir, "settings.json"),
      JSON.stringify({
        model: "",
        heartbeat: { enabled: false, interval: 15, excludeWindows: [] },
        telegram: { token: "", allowedUserIds: [] },
        discord: { token: "", allowedUserIds: [], listenChannels: [] },
        security: { level: "moderate", allowedTools: [], disallowedTools: [] },
      })
    );
  }
  if (opts.withSession) {
    await writeFile(
      join(hermesDir, "session.json"),
      JSON.stringify({
        sessionId: "fake-existing-session",
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
        turnCount: 0,
        compactWarned: false,
      })
    );
  }
  return dir;
}

describe("send command", () => {
  const dirsToClean: string[] = [];

  afterAll(async () => {
    for (const d of dirsToClean) {
      try {
        await rm(d, { recursive: true, force: true });
      } catch {}
    }
  });

  test("no message: prints usage and exits 1", async () => {
    const dir = await freshProject({ withSession: true });
    dirsToClean.push(dir);

    const result = await runSend(dir, []);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("usage");
  }, 25_000);

  test("only flags, no message: prints usage and exits 1", async () => {
    const dir = await freshProject({ withSession: true });
    dirsToClean.push(dir);

    // Filtering out the flags leaves an empty message
    const result = await runSend(dir, ["--telegram", "--discord"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("usage");
  }, 25_000);

  test("no active session: exits 1 with a clear message", async () => {
    const dir = await freshProject({ withSession: false });
    dirsToClean.push(dir);

    const result = await runSend(dir, ["hello"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("no active session");
  }, 25_000);

  test("active session + message: fake-claude replies are echoed to stdout", async () => {
    const dir = await freshProject({ withSession: true });
    dirsToClean.push(dir);

    const result = await runSend(dir, ["hello", "there"], {
      HERMES_FAKE_REPLY: "pong",
    });

    // Exit 0 is the real success case. A grace-kill SIGKILL (exitCode null,
    // signal SIGKILL) is ALSO acceptable here — the runner's 5-minute
    // safety timer can keep the event loop alive after stdout completes.
    // What is NOT acceptable is any other exit code being silently
    // relabelled as 0 (Finding #9).
    expect(sendSucceeded(result)).toBe(true);
    expect(result.stdout).toContain("pong");
  }, 40_000);

  test("--telegram without --to: exits 1 with a 'target required' message (pre-network)", async () => {
    const dir = await freshProject({ withSession: true });
    dirsToClean.push(dir);

    const result = await runSend(dir, ["hello", "--telegram"], {
      HERMES_FAKE_REPLY: "pong",
    });
    expect(result.exitCode).toBe(1);
    // Refuses to broadcast — fails before hitting the Telegram network layer.
    expect(result.stderr.toLowerCase()).toContain("--to");
  }, 30_000);

  test("--discord without --to: exits 1 with a 'target required' message", async () => {
    const dir = await freshProject({ withSession: true });
    dirsToClean.push(dir);

    const result = await runSend(dir, ["hello", "--discord"], {
      HERMES_FAKE_REPLY: "pong",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("--to");
  }, 30_000);

  test("--telegram --to on unconfigured token: exits 1 with a telegram-flavored error", async () => {
    const dir = await freshProject({ withSession: true });
    dirsToClean.push(dir);

    const result = await runSend(dir, ["hello", "--telegram", "--to", "123"], { HERMES_FAKE_REPLY: "pong" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("telegram");
  }, 30_000);

  test("--telegram --discord together: exits 1 with a mutually-exclusive error", async () => {
    const dir = await freshProject({ withSession: true });
    dirsToClean.push(dir);

    const result = await runSend(dir, ["hello", "--telegram", "--discord", "--to", "1"], {
      HERMES_FAKE_REPLY: "pong",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("not both");
  }, 30_000);
});

// -----------------------------------------------------------------------
// Finding #7: send validates delivery targets BEFORE invoking Claude.
//
// Today the flow is: runUserMessage(...) → then check --telegram token →
// then check allowlist. So a bad `--to` burns a Claude turn (costing
// tokens and mutating session state) before the send is rejected.
//
// We prove the fix by pointing HERMES_CLAUDE_BIN at a marker-writing
// fixture and asserting the marker was NEVER created.
// -----------------------------------------------------------------------
const MARKER_FAKE_ABS = join(REPO_ROOT, "tests/fixtures/fake-claude-marker.ts");
const MARKER_FAKE_BIN = `bun run ${MARKER_FAKE_ABS}`;

async function markerFor(dir: string): Promise<string> {
  return join(dir, "fake-claude-marker.log");
}

describe("send validates delivery targets BEFORE invoking Claude (Finding #7)", () => {
  const finding7Dirs: string[] = [];
  afterAll(async () => {
    for (const d of finding7Dirs) {
      try {
        await rm(d, { recursive: true, force: true });
      } catch {}
    }
  });

  test("--telegram --to <not-in-allowlist>: exits 1 without ever invoking Claude", async () => {
    const dir = await freshProject({ withSession: true });
    finding7Dirs.push(dir);
    // settings.json has empty allowedUserIds — user 999 is definitely not
    // on the list.
    const marker = await markerFor(dir);
    const result = await runSend(dir, ["hello", "--telegram", "--to", "999"], {
      HERMES_CLAUDE_BIN: MARKER_FAKE_BIN,
      HERMES_FAKE_MARKER_PATH: marker,
    });
    expect(sendFailed(result)).toBe(true);
    // The claude fixture must never have been spawned — no marker file.
    const { existsSync } = await import("node:fs");
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  test("--telegram --to with no token configured: exits 1 without ever invoking Claude", async () => {
    const dir = await freshProject({ withSession: true });
    finding7Dirs.push(dir);
    const marker = await markerFor(dir);
    // settings.json has telegram.token = "" (freshProject default).
    const result = await runSend(dir, ["hello", "--telegram", "--to", "123"], {
      HERMES_CLAUDE_BIN: MARKER_FAKE_BIN,
      HERMES_FAKE_MARKER_PATH: marker,
    });
    expect(sendFailed(result)).toBe(true);
    expect(result.stderr.toLowerCase()).toContain("telegram");
    const { existsSync } = await import("node:fs");
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  test("--discord --to with no token configured: exits 1 without ever invoking Claude", async () => {
    const dir = await freshProject({ withSession: true });
    finding7Dirs.push(dir);
    const marker = await markerFor(dir);
    const result = await runSend(dir, ["hello", "--discord", "--to", "abc"], {
      HERMES_CLAUDE_BIN: MARKER_FAKE_BIN,
      HERMES_FAKE_MARKER_PATH: marker,
    });
    expect(sendFailed(result)).toBe(true);
    expect(result.stderr.toLowerCase()).toContain("discord");
    const { existsSync } = await import("node:fs");
    expect(existsSync(marker)).toBe(false);
  }, 30_000);
});

// -----------------------------------------------------------------------
// Finding #9: the old runSend treated SIGKILL as exitCode 0. That masked
// any real non-zero exit from `send` whenever the grace killer happened
// to win the race. We now pin down the contract explicitly.
// -----------------------------------------------------------------------
describe("runSend does not silently normalise SIGKILL to success (Finding #9)", () => {
  const finding9Dirs: string[] = [];
  afterAll(async () => {
    for (const d of finding9Dirs) {
      try {
        await rm(d, { recursive: true, force: true });
      } catch {}
    }
  });

  test("signal field is exposed verbatim, exitCode is NOT forced to 0 on SIGKILL", async () => {
    // The usage-error branch exits cleanly with code 1 — no SIGKILL. This
    // is the positive control: the helper must preserve the real exit
    // code rather than overwriting it.
    const dir = await freshProject({ withSession: true });
    finding9Dirs.push(dir);
    const result = await runSend(dir, []);
    // exitCode must be the real 1, signal must be null.
    expect(result.exitCode).toBe(1);
    expect(result.signal).toBeNull();
  }, 25_000);

  test("sendSucceeded returns false for exit 1 + null signal", () => {
    // Pure helper contract — exit 1 is never "success", even if the
    // caller is tempted to tolerate kill signals.
    expect(sendSucceeded({ stdout: "", stderr: "", exitCode: 1, signal: null })).toBe(false);
    expect(sendFailed({ stdout: "", stderr: "", exitCode: 1, signal: null })).toBe(true);
  });

  test("sendSucceeded tolerates grace-kill SIGKILL only when exitCode is null", () => {
    // The legitimate use of the grace-kill escape hatch: no exit code
    // was ever reported, the parent issued SIGKILL to unblock the event
    // loop.
    expect(sendSucceeded({ stdout: "", stderr: "", exitCode: null, signal: "SIGKILL" })).toBe(true);
    // But an exitCode of 2 with signal SIGKILL is NOT success — the
    // child actually exited with 2 before being killed (unlikely, but
    // the contract needs to reject it).
    expect(sendSucceeded({ stdout: "", stderr: "", exitCode: 2, signal: "SIGKILL" })).toBe(false);
  });
});
