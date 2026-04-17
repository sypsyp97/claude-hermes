import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Settings } from "./config";
import { hermesDir, jobsDir, promptsDir } from "./paths";

export interface PreflightReport {
  claudeCliAvailable: boolean;
  nodeAvailable: boolean;
  cwdIsHome: boolean;
  hermesDirWritable: boolean;
  insideGitRepo: boolean;
  problems: string[];
}

export interface RunPreflightOptions {
  cwd?: string;
  home?: string;
  which?: (binary: string) => Promise<string | null>;
}

export interface SeedExampleOptions {
  cwd?: string;
  force?: boolean;
}

export interface SeedExampleResult {
  createdHeartbeatPrompt: boolean;
  createdExampleJob: boolean;
  skipped: string[];
}

export interface RenderFirstRunGuideInput {
  settings: Settings;
  preflight: PreflightReport;
}

export function detectFirstRun(settings: Settings): boolean {
  if (settings.model && settings.model.trim() !== "") return false;
  if (settings.heartbeat.enabled) return false;
  if (settings.heartbeat.prompt && settings.heartbeat.prompt.trim() !== "") return false;
  if (settings.telegram.token && settings.telegram.token.trim() !== "") return false;
  if (settings.discord.token && settings.discord.token.trim() !== "") return false;
  if (settings.security.level !== "moderate") return false;
  if (settings.security.allowedTools.length > 0) return false;
  if (settings.security.disallowedTools.length > 0) return false;
  return true;
}

function defaultWhich(binary: string): Promise<string | null> {
  const cmd = process.platform === "win32" ? "where" : "which";
  return new Promise((resolvePromise) => {
    try {
      const child = spawn(cmd, [binary], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.on("error", () => resolvePromise(null));
      child.on("close", (code) => {
        if (code === 0) {
          const first = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
          resolvePromise(first ?? null);
        } else {
          resolvePromise(null);
        }
      });
    } catch {
      resolvePromise(null);
    }
  });
}

async function isInsideGitRepo(cwd: string): Promise<boolean> {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function checkHermesDirWritable(cwd: string): Promise<boolean> {
  const target = hermesDir(cwd);
  try {
    await mkdir(target, { recursive: true });
    const probe = join(target, `.write-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await writeFile(probe, "ok");
    await rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function runPreflightChecks(
  options: RunPreflightOptions = {},
): Promise<PreflightReport> {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const which = options.which ?? defaultWhich;

  const [claudePath, nodePath] = await Promise.all([which("claude"), which("node")]);
  const claudeCliAvailable = claudePath !== null;
  const nodeAvailable = nodePath !== null;

  const cwdIsHome = resolve(cwd) === resolve(home);
  const insideGitRepo = await isInsideGitRepo(cwd);
  const hermesDirWritable = await checkHermesDirWritable(cwd);

  const problems: string[] = [];
  if (!claudeCliAvailable) {
    problems.push("claude CLI not found on PATH — install Claude Code before starting the daemon");
  }
  if (!nodeAvailable) {
    problems.push("node not found on PATH — install Node.js");
  }
  if (cwdIsHome) {
    problems.push("cwd equals your home directory — run hermes from a project subdirectory instead");
  }
  if (!hermesDirWritable) {
    problems.push(`cannot write to ${hermesDir(cwd)} — check filesystem permissions`);
  }
  if (!insideGitRepo) {
    problems.push("not inside a git repository — run `git init` so hermes can track changes");
  }

  return {
    claudeCliAvailable,
    nodeAvailable,
    cwdIsHome,
    hermesDirWritable,
    insideGitRepo,
    problems,
  };
}

const WELCOME_BANNER = [
  "  _   _                                ",
  " | | | | ___ _ __ _ __ ___   ___  ___  ",
  " | |_| |/ _ \\ '__| '_ ` _ \\ / _ \\/ __| ",
  " |  _  |  __/ |  | | | | | |  __/\\__ \\ ",
  " |_| |_|\\___|_|  |_| |_| |_|\\___||___/ ",
  "",
  " Hermes — your always-on Claude agent.",
].join("\n");

export function renderWelcomeBanner(): string {
  return WELCOME_BANNER;
}

export function renderFirstRunGuide(input: RenderFirstRunGuideInput): string {
  const { settings, preflight } = input;
  const lines: string[] = [];

  lines.push("Hermes first-run guide");
  lines.push("");

  const blockers: string[] = [];
  if (preflight.cwdIsHome) {
    blockers.push("- blocker: cwd is your home directory. Move into a project folder before starting hermes.");
  }
  if (!preflight.claudeCliAvailable) {
    blockers.push("- install the `claude` CLI (https://claude.com/code) and make sure it is on PATH.");
  }
  if (!preflight.nodeAvailable) {
    blockers.push("- install Node.js so the daemon can spawn child processes.");
  }
  if (!preflight.hermesDirWritable) {
    blockers.push("- hermes cannot write to `.claude/hermes` in this cwd. Check permissions.");
  }
  if (!preflight.insideGitRepo) {
    blockers.push("- run `git init` so hermes can track and revert its own changes.");
  }

  if (blockers.length > 0) {
    lines.push("Blockers:");
    lines.push(...blockers);
    lines.push("");
  }

  const configLines: string[] = [];
  if (!settings.model || settings.model.trim() === "") {
    configLines.push("- model: not configured (set `model` in .claude/hermes/settings.json)");
  }
  if (!settings.heartbeat.enabled) {
    configLines.push("- heartbeat: not configured (set `heartbeat.enabled` and `heartbeat.prompt`)");
  }
  if (!settings.telegram.token || settings.telegram.token.trim() === "") {
    configLines.push("- telegram: not configured (optional — set `telegram.token` to enable)");
  }
  if (!settings.discord.token || settings.discord.token.trim() === "") {
    configLines.push("- discord: not configured (optional — set `discord.token` to enable)");
  }

  if (configLines.length > 0) {
    lines.push("Configuration:");
    lines.push(...configLines);
    lines.push("");
  } else {
    lines.push("Configuration: looks good — model, heartbeat, and messaging tokens are all set.");
    lines.push("");
  }

  lines.push("Next steps:");
  lines.push("- run `hermes new job <name>` to scaffold a scheduled task.");
  lines.push("- run `hermes start` to launch the daemon.");
  lines.push("- edit `.claude/hermes/settings.json` to tune model, heartbeat, and security.");

  return lines.join("\n");
}

const HEARTBEAT_PROMPT_BODY = `# Heartbeat prompt

This prompt runs on every heartbeat tick. Use it to nudge the agent toward a
recurring check-in — review recent work, surface anything important, and keep
memory fresh.

Tasks:
- summarize what changed in the last tick
- flag anything that needs a human decision
- keep the reply short (a few bullet points)
`;

const EXAMPLE_JOB_BODY = `---
schedule: "0 9 29 2 *"
---
# Example job (template)

This is a template so you can see the file shape. The \`schedule\` above is a
standard cron expression — minute, hour, day-of-month, month, day-of-week. The
default here (09:00 on Feb 29) almost never fires, so this template is safe to
leave until you're ready.

When you want a real job: copy this file, rename it, pick a real cron, and
replace this body with the prompt you want hermes to run on that schedule.
Then delete this template.
`;

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function seedExampleArtifacts(
  options: SeedExampleOptions = {},
): Promise<SeedExampleResult> {
  const cwd = options.cwd ?? process.cwd();
  const force = options.force === true;

  const heartbeatPath = join(promptsDir(cwd), "heartbeat.md");
  const jobPath = join(jobsDir(cwd), "example.md");

  await mkdir(dirname(heartbeatPath), { recursive: true });
  await mkdir(dirname(jobPath), { recursive: true });

  const skipped: string[] = [];

  let createdHeartbeatPrompt = false;
  if (force || !(await pathExists(heartbeatPath))) {
    await writeFile(heartbeatPath, HEARTBEAT_PROMPT_BODY, "utf8");
    createdHeartbeatPrompt = true;
  } else {
    skipped.push(heartbeatPath);
  }

  let createdExampleJob = false;
  if (force || !(await pathExists(jobPath))) {
    await writeFile(jobPath, EXAMPLE_JOB_BODY, "utf8");
    createdExampleJob = true;
  } else {
    skipped.push(jobPath);
  }

  return { createdHeartbeatPrompt, createdExampleJob, skipped };
}
