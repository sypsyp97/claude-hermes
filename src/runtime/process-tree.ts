import { fileURLToPath } from "node:url";
import { hasSessionLease } from "./session-lease";

export function taskProcessArgs(args: string[]): { args: string[]; leased: boolean } {
  const leased = hasSessionLease();
  return {
    leased,
    args: leased
      ? [process.execPath, "run", fileURLToPath(new URL("./lease-child.ts", import.meta.url)), ...args]
      : args,
  };
}

interface OwnedProcess {
  pid?: number;
  kill(signal: "SIGTERM" | "SIGKILL"): unknown;
}

export class ProcessTreeCleanupError extends Error {
  constructor(cause: unknown) {
    super("Could not confirm process tree termination", { cause });
  }
}

function snapshotGroup(pid: number, command: string): boolean {
  const snapshot = Bun.spawnSync([command, "-axo", "pgid=,stat="]);
  if (snapshot.exitCode !== 0) throw new Error("Could not inspect the owned process group");
  const output = snapshot.stdout.toString().trim();
  if (!output) throw new Error("Empty owned process group snapshot");
  const rows = output.split("\n").map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\S+)$/);
    if (!match) throw new Error("Invalid owned process group snapshot");
    return { group: Number(match[1]), live: !match[2].startsWith("Z") };
  });
  return rows.some((row) => row.group === pid && row.live);
}

function liveGroup(pid: number, command = "ps"): boolean {
  try {
    process.kill(-pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return snapshotGroup(pid, "/bin/ps");
    throw error;
  }
  // Zombies cannot execute work. Darwin can report EPERM for a group with
  // only zombies; a strict native snapshot must distinguish it from live work.
  return snapshotGroup(pid, command);
}

/** Only pass a child spawned with detached:true on POSIX. */
export async function terminateProcessTree(
  proc: OwnedProcess,
  exited: Promise<unknown>,
  graceMs: number
): Promise<void> {
  const pid = proc.pid;
  if (process.platform === "win32" || pid === undefined || !Number.isInteger(pid) || pid <= 1) {
    try {
      proc.kill("SIGTERM");
    } catch {}
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }, graceMs);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
    return;
  }

  const signalGroup = (signal: "SIGTERM" | "SIGKILL") => {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return;
      if (code === "EPERM" && !snapshotGroup(pid, "/bin/ps")) return;
      throw error;
    }
  };
  try {
    signalGroup("SIGTERM");
    const deadline = Date.now() + graceMs;
    while (liveGroup(pid) && Date.now() < deadline) await Bun.sleep(10);
    // The leader may already have exited. Its descendants still own the group.
    if (liveGroup(pid)) signalGroup("SIGKILL");
    await exited;
    while (liveGroup(pid)) await Bun.sleep(10);
  } catch (error) {
    // A failed inspection must still attempt escalation for this owned group.
    try {
      signalGroup("SIGKILL");
    } catch (killError) {
      throw new ProcessTreeCleanupError(killError);
    }
    await exited;
    // PATH lookup may be the failed probe. Confirm escalation with the native
    // utility before reporting cleanup failure; the leader can already be dead.
    try {
      while (liveGroup(pid, "/bin/ps")) await Bun.sleep(10);
    } catch (inspectionError) {
      throw new ProcessTreeCleanupError(inspectionError);
    }
    throw new ProcessTreeCleanupError(error);
  }
}
