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

export async function stop() {
  const pidFile = getPidPath();
  let pid: string;
  try {
    pid = (await Bun.file(pidFile).text()).trim();
  } catch {
    console.log("No daemon is running (PID file not found).");
    process.exit(0);
  }

  try {
    process.kill(Number(pid), "SIGTERM");
    console.log(`Stopped daemon (PID ${pid}).`);
  } catch {
    console.log(`Daemon process ${pid} already dead.`);
  }

  await cleanupPidFile();
  await teardownStatusline();
  // Drop our entry from the cross-project registry. The daemon's own SIGTERM
  // handler does this too, but we strip it here as belt-and-suspenders in
  // case it died without unregistering.
  await unregisterDaemon(Number(pid)).catch(() => {});

  try {
    await unlink(join(hermesDir(), "state.json"));
  } catch {
    // already gone
  }

  process.exit(0);
}

export async function stopAll() {
  // Source of truth is the cross-project registry (~/.claude/hermes/daemons.json).
  // We used to scan ~/.claude/projects/ and reverse Claude's slug encoding,
  // which broke entirely on Windows (path was `/C//...` instead of `C:\...`)
  // and silently lost any project whose folder name contained a hyphen
  // (e.g. `~/projects/my-app` → reconstructed as `~/projects/my/app`).
  const entries = await listDaemons();

  if (entries.length === 0) {
    console.log("No running daemons found.");
    process.exit(0);
  }

  let found = 0;
  for (const entry of entries) {
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
