import { writeFile, unlink, readdir, readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { getPidPath, cleanupPidFile } from "../pid";
import { claudeDir, hermesDir, pidFile } from "../paths";

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

  try {
    await unlink(join(hermesDir(), "state.json"));
  } catch {
    // already gone
  }

  process.exit(0);
}

export async function stopAll() {
  const projectsDir = join(homedir(), ".claude", "projects");
  let dirs: string[];
  try {
    dirs = await readdir(projectsDir);
  } catch {
    console.log("No projects found.");
    process.exit(0);
  }

  let found = 0;
  for (const dir of dirs) {
    const projectPath = "/" + dir.slice(1).replace(/-/g, "/");
    const pidFilePath = pidFile(projectPath);

    let pid: string;
    try {
      pid = (await readFile(pidFilePath, "utf-8")).trim();
      process.kill(Number(pid), 0);
    } catch {
      continue;
    }

    found++;
    try {
      process.kill(Number(pid), "SIGTERM");
      console.log(`\x1b[33m■ Stopped\x1b[0m PID ${pid} — ${projectPath}`);
      try { await unlink(pidFilePath); } catch {}
    } catch {
      console.log(`\x1b[31m✗ Failed to stop\x1b[0m PID ${pid} — ${projectPath}`);
    }
  }

  if (found === 0) {
    console.log("No running daemons found.");
  }

  process.exit(0);
}
