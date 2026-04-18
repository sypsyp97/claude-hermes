import { unlink, writeFile } from "fs/promises";
import { join } from "path";
import { cleanupPidFile, getPidPath } from "../pid";
import { claudeDir, hermesDir, pidFile } from "../paths";
import { listDaemons, unregisterDaemon } from "../runtime/daemon-registry";

// NOTE: these paths MUST be resolved lazily on every call. Capturing them at
// module load would freeze them to whatever process.cwd() was when the module
// was first imported — a footgun when the process chdir's between import and
// teardown. See src/paths.ts for the same guidance.
function statuslineFile(): string {
  return join(claudeDir(), "statusline.cjs");
}

function claudeSettingsFile(): string {
  return join(claudeDir(), "settings.json");
}

async function teardownStatusline() {
  const settingsPath = claudeSettingsFile();
  try {
    const settings = await Bun.file(settingsPath).json();
    delete settings.statusLine;
    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  } catch {
    // file doesn't exist, nothing to clean up
  }

  try {
    await unlink(statuslineFile());
  } catch {
    // already gone
  }
}

// Read HERMES_PARENT_PID once per invocation. A child that was spawned by the
// daemon gets its parent daemon's pid injected here; we must never SIGTERM
// that pid from inside the daemon's own child (same class as the /clear bug;
// see commit 2c9097a).
function readParentPid(): number | null {
  const raw = process.env.HERMES_PARENT_PID;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Wait until `process.kill(pid, 0)` throws (i.e. the process is gone), up to
 * `budgetMs`. Polls every 50 ms. Returns true if exit was observed, false if
 * the budget expired. On Windows this typically returns almost immediately
 * because `SIGTERM` is translated into a synchronous `TerminateProcess`.
 */
async function waitForExit(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

export async function stop() {
  const pidFile = getPidPath();
  let pid: string;
  try {
    pid = (await Bun.file(pidFile).text()).trim();
  } catch {
    console.log("No daemon is running (PID file not found).");
    process.exit(0);
  }

  const pidNum = Number(pid);
  const parentPid = readParentPid();
  if (parentPid !== null && pidNum === parentPid) {
    console.log(
      `Skipping PID ${pidNum} — parent daemon of the current process.`,
    );
    process.exit(0);
  }

  try {
    process.kill(pidNum, "SIGTERM");
    console.log(`Stopped daemon (PID ${pid}).`);
  } catch {
    console.log(`Daemon process ${pid} already dead.`);
  }

  // Wait for the daemon to actually exit before we unlink its pid-file /
  // registry row. Otherwise a fast `hermes start` could race the shutdown
  // and mint a second daemon while the old one is still draining.
  await waitForExit(pidNum, 2000);

  await cleanupPidFile();
  await teardownStatusline();
  // Drop our entry from the project-scoped registry. The daemon's own SIGTERM
  // handler does this too, but we strip it here as belt-and-suspenders in
  // case it died without unregistering.
  await unregisterDaemon(pidNum).catch(() => {});

  try {
    await unlink(join(hermesDir(), "state.json"));
  } catch {
    // already gone
  }

  process.exit(0);
}

export async function stopAll() {
  // Source of truth is the project-scoped registry
  // (`<cwd>/.claude/hermes/daemons.json`). We used to keep this registry under
  // `~/.claude/hermes/daemons.json` and scan `~/.claude/projects/` before that,
  // but both approaches broke on Windows (path was `/C//...` instead of `C:\...`)
  // and silently lost any project whose folder name contained a hyphen
  // (e.g. `~/projects/my-app` → reconstructed as `~/projects/my/app`).
  console.log("Stopping hermes daemons for this project...");
  const entries = await listDaemons();

  if (entries.length === 0) {
    console.log("No running daemons found.");
    process.exit(0);
  }

  // If we were spawned by a hermes daemon (it injected HERMES_PARENT_PID into
  // our env), skip that pid — SIGTERMing it would kill the daemon awaiting
  // our reply. Same class as the /clear bug; see commit 2c9097a.
  const parentPid = readParentPid();

  let found = 0;
  for (const entry of entries) {
    if (parentPid !== null && entry.pid === parentPid) {
      console.log(
        `Skipping PID ${entry.pid} — parent daemon of the current process.`,
      );
      continue;
    }

    // Skip entries whose pid is already dead — registers without a clean
    // shutdown leave stale rows behind. We unregister them here so the file
    // self-heals over time.
    try {
      process.kill(entry.pid, 0);
    } catch {
      await unregisterDaemon(entry.pid).catch(() => {});
      continue;
    }

    found++;
    try {
      process.kill(entry.pid, "SIGTERM");
      console.log(`\x1b[33m■ Stopped\x1b[0m PID ${entry.pid} — ${entry.cwd}`);
      // Wait for the daemon to actually exit before unlinking its pid-file
      // and registry row. Otherwise a fast follow-up `hermes start` could
      // race the shutdown and mint a second daemon while the old one is
      // still draining.
      await waitForExit(entry.pid, 2000);
      // Best-effort pid-file cleanup at the daemon's own cwd. The daemon's
      // SIGTERM handler will also do this, but we don't wait for it.
      try { await unlink(pidFile(entry.cwd)); } catch {}
      await unregisterDaemon(entry.pid).catch(() => {});
    } catch {
      console.log(`\x1b[31m✗ Failed to stop\x1b[0m PID ${entry.pid} — ${entry.cwd}`);
    }
  }

  if (found === 0) {
    console.log("No running daemons found.");
  }

  process.exit(0);
}
