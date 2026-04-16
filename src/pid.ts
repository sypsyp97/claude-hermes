import { writeFile, unlink, readFile } from "fs/promises";
import { pidFile } from "./paths";

export function getPidPath(): string {
  return pidFile();
}

/**
 * Check if a daemon is already running in this directory.
 * If a stale PID file exists (process dead), it gets cleaned up.
 * Returns the running PID if alive, or null.
 */
export async function checkExistingDaemon(): Promise<number | null> {
  let raw: string;
  try {
    raw = (await readFile(pidFile(), "utf-8")).trim();
  } catch {
    return null; // no pid file
  }

  const pid = Number(raw);
  if (!pid || isNaN(pid)) {
    await cleanupPidFile();
    return null;
  }

  try {
    process.kill(pid, 0); // signal 0 = just check if alive
    return pid;
  } catch {
    // process is dead, clean up stale pid file
    await cleanupPidFile();
    return null;
  }
}

export async function writePidFile(): Promise<void> {
  await writeFile(pidFile(), String(process.pid) + "\n");
}

export async function cleanupPidFile(): Promise<void> {
  try {
    await unlink(pidFile());
  } catch {
    // already gone
  }
}
