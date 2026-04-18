import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = process.cwd();

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("plugin install-time contract", () => {
  test("plugin.json declares the expected plugin name and version", async () => {
    const text = await readFile(join(REPO_ROOT, ".claude-plugin", "plugin.json"), "utf8");
    const parsed = JSON.parse(text);
    expect(parsed.name).toBe("claude-hermes");
    expect(typeof parsed.version).toBe("string");
    expect(parsed.version.length).toBeGreaterThan(0);
  });

  test("marketplace.json points at this repo as the plugin source", async () => {
    const text = await readFile(join(REPO_ROOT, ".claude-plugin", "marketplace.json"), "utf8");
    const parsed = JSON.parse(text);
    expect(parsed.name).toBe("claude-hermes");
    expect(Array.isArray(parsed.plugins)).toBe(true);
    expect(parsed.plugins.length).toBeGreaterThan(0);
    const hermes = parsed.plugins.find((p: { name?: string }) => p.name === "claude-hermes");
    expect(hermes).toBeDefined();
    expect(hermes.source).toBe("./");
  });

  test("every ${CLAUDE_PLUGIN_ROOT}/... path referenced from commands/*.md exists", async () => {
    const dir = join(REPO_ROOT, "commands");
    const entries = await readdir(dir);
    const broken: string[] = [];

    for (const name of entries) {
      if (!name.endsWith(".md")) continue;
      const text = await readFile(join(dir, name), "utf8");
      // Match ${CLAUDE_PLUGIN_ROOT}/<relpath> — relpath is the run target.
      const matches = text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s`)>]+)/g);
      for (const m of matches) {
        const rel = m[1];
        const abs = join(REPO_ROOT, rel);
        if (!(await exists(abs))) {
          broken.push(`${name} -> ${rel}`);
        }
      }
    }

    expect(broken).toEqual([]);
  });

  test("entrypoint src/index.ts dispatches every command referenced from .md docs", async () => {
    // Sanity check: anything we tell users to run via `bun run src/index.ts <cmd>`
    // must be wired into the dispatcher. If a command name appears in commands/*.md
    // but isn't routed by index.ts, users will get an unknown-command/silent-default.
    const indexText = await readFile(join(REPO_ROOT, "src", "index.ts"), "utf8");
    const cmdDir = join(REPO_ROOT, "commands");
    const entries = await readdir(cmdDir);
    const dispatchedTokens = new Set<string>();
    for (const name of entries) {
      if (!name.endsWith(".md")) continue;
      const text = await readFile(join(cmdDir, name), "utf8");
      const matches = text.matchAll(/src\/index\.ts\s+(--?\w[\w-]*)/g);
      for (const m of matches) dispatchedTokens.add(m[1]);
    }

    const missing: string[] = [];
    for (const tok of dispatchedTokens) {
      // `--clear`, `--stop`, `start`, `status`, `send`, `run`...
      const literal = `"${tok}"`;
      if (!indexText.includes(literal)) {
        // `run` is invoked via `claude-hermes run <job-name>` — that path is
        // documented in jobs.md but the dispatcher routes unknowns to start().
        // Skip job-runner pseudo-command which is intentionally handled by
        // start.ts internally rather than the dispatcher.
        if (tok === "run") continue;
        missing.push(tok);
      }
    }
    expect(missing).toEqual([]);
  });

  test("AGENTS.md exists and pins the agent contract sections", async () => {
    // AGENTS.md is the entry point for autonomous agents. Renaming sections
    // breaks discovery for evolve loops and third-party agent SDKs that index
    // by header. If a real edit needs new headers, update both this test and
    // any agents that grep for them.
    const text = await readFile(join(REPO_ROOT, "AGENTS.md"), "utf8");
    const requiredSections = [
      "## Quickstart",
      "## The verify pipeline",
      "## Test conventions",
      "## Hard rules",
      "## Where things live",
      "## Maintenance discipline",
    ];
    const missing = requiredSections.filter((s) => !text.includes(s));
    expect(missing).toEqual([]);
  });

  test(".github/pull_request_template.md exists and references the verify pipeline", async () => {
    const text = await readFile(join(REPO_ROOT, ".github", "pull_request_template.md"), "utf8");
    expect(text).toContain("bun run verify");
  });
});

// ----------------------------------------------------------------------
// Finding #8: unknown subcommand must fail loudly, not silently fall
// through to `await start()`. Today `src/index.ts:34` dispatches any
// unmatched argv to `start()`, so `bun run src/index.ts doesnotexist`
// boots the daemon. A typo becomes a real side effect.
// ----------------------------------------------------------------------
describe("unknown CLI subcommand (Finding #8)", () => {
  test("bun run src/index.ts <typo> exits non-zero without starting the daemon", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "hermes-unknown-cmd-"));
    const hermesDir = join(tempDir, ".claude", "hermes");
    await mkdir(hermesDir, { recursive: true });
    try {
      const child = spawn("bun", ["run", join(REPO_ROOT, "src", "index.ts"), "doesnotexist"], {
        cwd: tempDir,
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
      // The fix makes the child exit immediately with a clear error. Today
      // it falls through to `await start()` and the daemon enters its hot
      // loop, so we cap the wait at 5s and kill the child. If the child
      // died on its own (fix shipped), we observe the real exit code; if
      // it was still running, `timedOut === true` and the test treats
      // that as a failure too (typos must NOT cause a daemon to boot).
      const result = await new Promise<{
        stdout: string;
        stderr: string;
        exitCode: number | null;
        timedOut: boolean;
      }>((resolve) => {
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          try {
            child.kill("SIGKILL");
          } catch {}
        }, 5_000);
        child.on("error", () => {
          clearTimeout(timer);
          resolve({
            stdout: Buffer.concat(out).toString("utf8"),
            stderr: Buffer.concat(err).toString("utf8"),
            exitCode: null,
            timedOut,
          });
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({
            stdout: Buffer.concat(out).toString("utf8"),
            stderr: Buffer.concat(err).toString("utf8"),
            exitCode: code,
            timedOut,
          });
        });
      });

      // Hard red: a timed-out wait means the daemon entered its hot
      // loop on an unknown command. That IS the bug.
      expect(result.timedOut).toBe(false);
      // Must exit non-zero — typos cannot be treated as "run the daemon".
      expect(result.exitCode).not.toBe(0);
      // Error must name the unknown command so the user can see what
      // they mistyped.
      const combined = (result.stdout + result.stderr).toLowerCase();
      expect(combined).toContain("doesnotexist");
      // And no daemon pid file should have been written in the tmp cwd.
      const pidPath = join(hermesDir, "daemon.pid");
      const pidFile = Bun.file(pidPath);
      expect(await pidFile.exists()).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 20_000);
});
