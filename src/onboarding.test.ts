import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings } from "./config";
import type { PreflightReport } from "./onboarding";

// Mirrors the pattern in src/config.test.ts: chdir into a tmpdir so the lazy
// path helpers (hermesDir, promptsDir, jobsDir) all resolve relative to a
// throwaway workspace. Everything is restored in afterAll.

const ORIG_CWD = process.cwd();
const TEMP_ROOT = join(tmpdir(), `hermes-onboarding-${Date.now()}-${Math.random().toString(36).slice(2)}`);

let onboarding: typeof import("./onboarding");
let paths: typeof import("./paths");

beforeAll(async () => {
  await mkdir(TEMP_ROOT, { recursive: true });
  process.chdir(TEMP_ROOT);
  onboarding = await import("./onboarding");
  paths = await import("./paths");
});

afterAll(async () => {
  process.chdir(ORIG_CWD);
  await rm(TEMP_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Settings object that matches DEFAULT_SETTINGS semantically. */
function makeDefaultSettings(): Settings {
  return {
    model: "",
    api: "",
    fallback: { model: "", api: "" },
    agentic: {
      enabled: false,
      defaultMode: "implementation",
      modes: [
        { name: "planning", model: "opus", keywords: [] },
        { name: "implementation", model: "sonnet", keywords: [] },
      ],
    },
    timezone: "UTC",
    timezoneOffsetMinutes: 0,
    heartbeat: {
      enabled: false,
      interval: 15,
      prompt: "",
      excludeWindows: [],
      forwardToTelegram: false,
      forwardToDiscord: false,
    },
    telegram: { token: "", allowedUserIds: [] },
    discord: { token: "", allowedUserIds: [], listenChannels: [], statusChannelId: "" },
    security: { level: "moderate", allowedTools: [], disallowedTools: [], bypassPermissions: false },
    stt: { baseUrl: "", model: "" },
    plugins: { preflightOnStart: false },
    logging: { includeBodies: false },
  };
}

function whichAll(): (binary: string) => Promise<string | null> {
  return async (binary: string) => `/usr/local/bin/${binary}`;
}

function whichMissing(missing: string[]): (binary: string) => Promise<string | null> {
  const missingSet = new Set(missing);
  return async (binary: string) => (missingSet.has(binary) ? null : `/usr/local/bin/${binary}`);
}

// ---------------------------------------------------------------------------
// detectFirstRun
// ---------------------------------------------------------------------------

describe("detectFirstRun", () => {
  test("returns true for semantic defaults", () => {
    const s = makeDefaultSettings();
    expect(onboarding.detectFirstRun(s)).toBe(true);
  });

  test("returns true for a freshly initConfig'd workspace", async () => {
    // Use a dedicated sub-cwd so we don't collide with other suites.
    const subDir = join(TEMP_ROOT, "first-run-fresh");
    await mkdir(subDir, { recursive: true });
    const prev = process.cwd();
    process.chdir(subDir);
    try {
      const config = await import("./config");
      await config.initConfig();
      const settings = await config.reloadSettings();
      expect(onboarding.detectFirstRun(settings)).toBe(true);
    } finally {
      process.chdir(prev);
    }
  });

  test("returns false when a model is configured", () => {
    const s = makeDefaultSettings();
    s.model = "opus";
    expect(onboarding.detectFirstRun(s)).toBe(false);
  });

  test("returns false when heartbeat is enabled", () => {
    const s = makeDefaultSettings();
    s.heartbeat.enabled = true;
    expect(onboarding.detectFirstRun(s)).toBe(false);
  });

  test("returns false when telegram token is set", () => {
    const s = makeDefaultSettings();
    s.telegram.token = "123:abc";
    expect(onboarding.detectFirstRun(s)).toBe(false);
  });

  test("returns false when discord token is set", () => {
    const s = makeDefaultSettings();
    s.discord.token = "MTIz.abc";
    expect(onboarding.detectFirstRun(s)).toBe(false);
  });

  test("returns false when security level is non-default", () => {
    const s = makeDefaultSettings();
    s.security.level = "strict";
    expect(onboarding.detectFirstRun(s)).toBe(false);
  });

  test("returns false when allowedTools is non-empty", () => {
    const s = makeDefaultSettings();
    s.security.allowedTools = ["Bash(git:*)"];
    expect(onboarding.detectFirstRun(s)).toBe(false);
  });

  test("returns false when disallowedTools is non-empty", () => {
    const s = makeDefaultSettings();
    s.security.disallowedTools = ["WebFetch"];
    expect(onboarding.detectFirstRun(s)).toBe(false);
  });

  test("returns false when heartbeat prompt is non-empty", () => {
    const s = makeDefaultSettings();
    s.heartbeat.prompt = "do a thing";
    expect(onboarding.detectFirstRun(s)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runPreflightChecks
// ---------------------------------------------------------------------------

describe("runPreflightChecks", () => {
  test("healthy system: all checks pass, no problems", async () => {
    const cwd = join(TEMP_ROOT, "preflight-healthy");
    await mkdir(cwd, { recursive: true });
    const home = join(TEMP_ROOT, "preflight-healthy-home");
    await mkdir(home, { recursive: true });
    // Give the cwd a .git so insideGitRepo is true.
    await mkdir(join(cwd, ".git"), { recursive: true });

    const report = await onboarding.runPreflightChecks({
      cwd,
      home,
      which: whichAll(),
    });

    expect(report.claudeCliAvailable).toBe(true);
    expect(report.nodeAvailable).toBe(true);
    expect(report.cwdIsHome).toBe(false);
    expect(report.hermesDirWritable).toBe(true);
    expect(report.insideGitRepo).toBe(true);
    expect(report.problems).toEqual([]);
  });

  test("missing claude CLI populates problems and flag is false", async () => {
    const cwd = join(TEMP_ROOT, "preflight-no-claude");
    await mkdir(cwd, { recursive: true });
    await mkdir(join(cwd, ".git"), { recursive: true });
    const home = join(TEMP_ROOT, "preflight-no-claude-home");
    await mkdir(home, { recursive: true });

    const report = await onboarding.runPreflightChecks({
      cwd,
      home,
      which: whichMissing(["claude"]),
    });

    expect(report.claudeCliAvailable).toBe(false);
    expect(report.nodeAvailable).toBe(true);
    expect(report.problems.length).toBeGreaterThan(0);
    expect(report.problems.some((p) => p.toLowerCase().includes("claude"))).toBe(true);
  });

  test("missing node populates problems and flag is false", async () => {
    const cwd = join(TEMP_ROOT, "preflight-no-node");
    await mkdir(cwd, { recursive: true });
    await mkdir(join(cwd, ".git"), { recursive: true });
    const home = join(TEMP_ROOT, "preflight-no-node-home");
    await mkdir(home, { recursive: true });

    const report = await onboarding.runPreflightChecks({
      cwd,
      home,
      which: whichMissing(["node"]),
    });

    expect(report.nodeAvailable).toBe(false);
    expect(report.problems.some((p) => p.toLowerCase().includes("node"))).toBe(true);
  });

  test("cwd === home triggers cwdIsHome and a blocker problem", async () => {
    const shared = join(TEMP_ROOT, "preflight-home-shared");
    await mkdir(shared, { recursive: true });

    const report = await onboarding.runPreflightChecks({
      cwd: shared,
      home: shared,
      which: whichAll(),
    });

    expect(report.cwdIsHome).toBe(true);
    expect(report.problems.some((p) => p.toLowerCase().includes("home"))).toBe(true);
  });

  test("cwd outside any git repo sets insideGitRepo false", async () => {
    const cwd = join(TEMP_ROOT, "preflight-no-git");
    await mkdir(cwd, { recursive: true });
    const home = join(TEMP_ROOT, "preflight-no-git-home");
    await mkdir(home, { recursive: true });

    const report = await onboarding.runPreflightChecks({
      cwd,
      home,
      which: whichAll(),
    });

    expect(report.insideGitRepo).toBe(false);
    expect(report.problems.some((p) => p.toLowerCase().includes("git"))).toBe(true);
  });

  test("hermesDirWritable is true when hermes dir can be created under cwd", async () => {
    const cwd = join(TEMP_ROOT, "preflight-writable");
    await mkdir(cwd, { recursive: true });
    const home = join(TEMP_ROOT, "preflight-writable-home");
    await mkdir(home, { recursive: true });

    const report = await onboarding.runPreflightChecks({
      cwd,
      home,
      which: whichAll(),
    });

    expect(report.hermesDirWritable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderWelcomeBanner
// ---------------------------------------------------------------------------

describe("renderWelcomeBanner", () => {
  test("returns a non-empty multi-line string containing 'Hermes'", () => {
    const banner = onboarding.renderWelcomeBanner();
    expect(typeof banner).toBe("string");
    expect(banner.length).toBeGreaterThan(0);
    expect(banner).toContain("Hermes");
    expect(banner.includes("\n")).toBe(true);
  });

  test("is stable across calls", () => {
    expect(onboarding.renderWelcomeBanner()).toBe(onboarding.renderWelcomeBanner());
  });
});

// ---------------------------------------------------------------------------
// renderFirstRunGuide
// ---------------------------------------------------------------------------

describe("renderFirstRunGuide", () => {
  function makeHealthyPreflight(): PreflightReport {
    return {
      cwdIsHome: false,
      claudeCliAvailable: true,
      nodeAvailable: true,
      hermesDirWritable: true,
      insideGitRepo: true,
      problems: [],
    };
  }

  test("contains 'Next steps'", () => {
    const out = onboarding.renderFirstRunGuide({
      settings: makeDefaultSettings(),
      preflight: makeHealthyPreflight(),
    });
    expect(out).toContain("Next steps");
  });

  test("prompts for a model when settings.model is empty", () => {
    const out = onboarding.renderFirstRunGuide({
      settings: makeDefaultSettings(),
      preflight: makeHealthyPreflight(),
    });
    expect(out.toLowerCase()).toContain("model");
  });

  test("includes a blocker warning when cwdIsHome is true", () => {
    const preflight = makeHealthyPreflight();
    preflight.cwdIsHome = true;
    preflight.problems = ["cwd equals home directory"];
    const out = onboarding.renderFirstRunGuide({
      settings: makeDefaultSettings(),
      preflight,
    });
    expect(out.toLowerCase()).toContain("home directory");
  });

  test("mentions installing claude when claude CLI is missing", () => {
    const preflight = makeHealthyPreflight();
    preflight.claudeCliAvailable = false;
    preflight.problems = ["claude CLI not found on PATH"];
    const out = onboarding.renderFirstRunGuide({
      settings: makeDefaultSettings(),
      preflight,
    });
    expect(out.toLowerCase()).toContain("install");
    expect(out.toLowerCase()).toContain("claude");
  });

  test("mentions `git init` when not inside a git repo", () => {
    const preflight = makeHealthyPreflight();
    preflight.insideGitRepo = false;
    preflight.problems = ["not inside a git repository"];
    const out = onboarding.renderFirstRunGuide({
      settings: makeDefaultSettings(),
      preflight,
    });
    expect(out).toContain("git init");
  });

  test("lists heartbeat, telegram, and discord as 'not configured' when unset", () => {
    const out = onboarding.renderFirstRunGuide({
      settings: makeDefaultSettings(),
      preflight: makeHealthyPreflight(),
    });
    const lower = out.toLowerCase();
    // Each appears on its own line tagged "not configured".
    const heartbeatLine = out
      .split("\n")
      .find(
        (line) => line.toLowerCase().includes("heartbeat") && line.toLowerCase().includes("not configured")
      );
    const telegramLine = out
      .split("\n")
      .find(
        (line) => line.toLowerCase().includes("telegram") && line.toLowerCase().includes("not configured")
      );
    const discordLine = out
      .split("\n")
      .find(
        (line) => line.toLowerCase().includes("discord") && line.toLowerCase().includes("not configured")
      );
    expect(heartbeatLine).toBeDefined();
    expect(telegramLine).toBeDefined();
    expect(discordLine).toBeDefined();
    // Sanity: the string "not configured" appears at least three times in total.
    const matches = lower.match(/not configured/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  test("fully configured healthy system renders a concise ready state", () => {
    const settings = makeDefaultSettings();
    settings.model = "opus";
    settings.heartbeat.enabled = true;
    settings.heartbeat.prompt = "check git";
    settings.telegram.token = "123:abc";
    settings.discord.token = "MTIz.abc";

    const out = onboarding.renderFirstRunGuide({
      settings,
      preflight: makeHealthyPreflight(),
    });

    expect(out).toContain("Next steps");
    expect(out.toLowerCase()).not.toContain("not configured");
  });
});

// ---------------------------------------------------------------------------
// seedExampleArtifacts
// ---------------------------------------------------------------------------

describe("seedExampleArtifacts", () => {
  // Each test uses a fresh sub-cwd so repeated seeding semantics are clean.
  let subDir: string;
  let prevCwd: string;

  beforeEach(async () => {
    subDir = join(TEMP_ROOT, `seed-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(subDir, { recursive: true });
    prevCwd = process.cwd();
    process.chdir(subDir);
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await rm(subDir, { recursive: true, force: true });
  });

  test("fresh workspace: creates both heartbeat prompt and example job", async () => {
    const result = await onboarding.seedExampleArtifacts();
    expect(result.createdHeartbeatPrompt).toBe(true);
    expect(result.createdExampleJob).toBe(true);
    expect(result.skipped).toEqual([]);

    const heartbeatPath = join(paths.hermesDir(), "prompts", "heartbeat.md");
    const jobPath = join(paths.hermesDir(), "jobs", "example.md");

    const hbStat = await stat(heartbeatPath);
    const jobStat = await stat(jobPath);
    expect(hbStat.isFile()).toBe(true);
    expect(jobStat.isFile()).toBe(true);

    const jobBody = await Bun.file(jobPath).text();
    // Frontmatter must contain a schedule: key.
    expect(/^---[\s\S]*?\bschedule\s*:/m.test(jobBody)).toBe(true);
    // Sanity: frontmatter is terminated.
    expect(jobBody.includes("\n---")).toBe(true);
  });

  test("second call on the same workspace skips both files and returns skip list", async () => {
    await onboarding.seedExampleArtifacts();
    const second = await onboarding.seedExampleArtifacts();

    expect(second.createdHeartbeatPrompt).toBe(false);
    expect(second.createdExampleJob).toBe(false);
    expect(second.skipped.length).toBeGreaterThanOrEqual(2);

    const heartbeatPath = join(paths.hermesDir(), "prompts", "heartbeat.md");
    const jobPath = join(paths.hermesDir(), "jobs", "example.md");
    expect(second.skipped).toContain(heartbeatPath);
    expect(second.skipped).toContain(jobPath);
  });

  test("force: true re-creates both files even if present", async () => {
    await onboarding.seedExampleArtifacts();

    // Stomp the files with sentinel content, then force-reseed.
    const heartbeatPath = join(paths.hermesDir(), "prompts", "heartbeat.md");
    const jobPath = join(paths.hermesDir(), "jobs", "example.md");
    await writeFile(heartbeatPath, "STOMPED");
    await writeFile(jobPath, "STOMPED");

    const forced = await onboarding.seedExampleArtifacts({ force: true });
    expect(forced.createdHeartbeatPrompt).toBe(true);
    expect(forced.createdExampleJob).toBe(true);
    expect(forced.skipped).toEqual([]);

    const hbBody = await Bun.file(heartbeatPath).text();
    const jobBody = await Bun.file(jobPath).text();
    expect(hbBody).not.toBe("STOMPED");
    expect(jobBody).not.toBe("STOMPED");
    expect(/^---[\s\S]*?\bschedule\s*:/m.test(jobBody)).toBe(true);
  });

  test("heartbeat prompt lives under hermesDir()/prompts/heartbeat.md", async () => {
    await onboarding.seedExampleArtifacts();
    const expected = join(paths.hermesDir(), "prompts", "heartbeat.md");
    const s = await stat(expected);
    expect(s.isFile()).toBe(true);
  });
});
