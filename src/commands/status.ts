import { join } from "path";
import { readdir } from "fs/promises";
import { hermesDir, jobsDir, pidFile as pidFilePath, settingsFile } from "../paths";
import { listDaemons } from "../runtime/daemon-registry";

function formatCountdown(ms: number): string {
  if (ms <= 0) return "now!";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "<1m";
}

/**
 * Source of truth for "which daemons are running right now?" is the project
 * registry at `<cwd>/.claude/hermes/daemons.json` (honouring the
 * `HERMES_DAEMON_REGISTRY` env override used by tests). The previous
 * approach — scanning `~/.claude/projects` and reversing the slug — mangled
 * any workspace path containing a hyphen (`my-app` → `/my/app`). Hyphenated
 * paths round-trip verbatim through the registry.
 */
export async function findAllDaemons(): Promise<{ path: string; pid: number }[]> {
  const entries = await listDaemons();
  const out: { path: string; pid: number }[] = [];
  for (const entry of entries) {
    try {
      process.kill(entry.pid, 0);
      out.push({ path: entry.cwd, pid: entry.pid });
    } catch {
      // dead pid — skip, leave stale entry for the registry's self-healing
    }
  }
  return out;
}

async function showAll(): Promise<void> {
  const daemons = await findAllDaemons();

  if (daemons.length === 0) {
    console.log(`\x1b[31m○ No running daemons found\x1b[0m`);
    return;
  }

  console.log(`Found ${daemons.length} running daemon(s):\n`);
  for (const d of daemons) {
    console.log(`\x1b[32m● Running\x1b[0m PID ${d.pid} — ${d.path}`);
  }
}

async function showStatus(): Promise<boolean> {
  let daemonRunning = false;
  let pid = "";
  try {
    pid = (await Bun.file(pidFilePath()).text()).trim();
    process.kill(Number(pid), 0);
    daemonRunning = true;
  } catch {
    // not running or no pid file
  }

  if (!daemonRunning) {
    console.log(`\x1b[31m○ Daemon is not running\x1b[0m`);
    return false;
  }

  console.log(`\x1b[32m● Daemon is running\x1b[0m (PID ${pid})`);

  try {
    const settings = await Bun.file(settingsFile()).json();
    const hb = settings.heartbeat;
    const timezone =
      typeof settings?.timezone === "string" && settings.timezone.trim()
        ? settings.timezone.trim()
        : Intl.DateTimeFormat().resolvedOptions().timeZone || "system";
    const windows = Array.isArray(hb?.excludeWindows) ? hb.excludeWindows : [];
    console.log(
      `  Heartbeat: ${hb.enabled ? `every ${hb.interval}m` : "disabled"}`
    );
    if (hb.enabled) {
      console.log(`  Heartbeat timezone: ${timezone}`);
      console.log(`  Quiet windows: ${windows.length > 0 ? windows.length : "none"}`);
    }
  } catch {}

  try {
    const files = await readdir(jobsDir());
    const mdFiles = files.filter((f) => f.endsWith(".md"));
    if (mdFiles.length > 0) {
      console.log(`  Jobs: ${mdFiles.length}`);
      for (const f of mdFiles) {
        const content = await Bun.file(join(jobsDir(), f)).text();
        const match = content.match(/schedule:\s*["']?([^"'\n]+)/);
        const schedule = match ? match[1].trim() : "unknown";
        console.log(`    - ${f.replace(/\.md$/, "")} [${schedule}]`);
      }
    }
  } catch {}

  try {
    const state = await Bun.file(join(hermesDir(), "state.json")).json();
    const now = Date.now();
    console.log("");
    if (state.heartbeat) {
      console.log(
        `  \x1b[31m♥\x1b[0m Next heartbeat: ${formatCountdown(state.heartbeat.nextAt - now)}`
      );
    }
    for (const job of state.jobs || []) {
      console.log(
        `  → ${job.name}: ${formatCountdown(job.nextAt - now)}`
      );
    }
  } catch {}

  return true;
}

export async function status(args: string[]) {
  if (args.includes("--all")) {
    await showAll();
  } else {
    await showStatus();
  }
}
