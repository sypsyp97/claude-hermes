import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { canonicalWorkspace } from "../paths";
import type { Database } from "../state/db";
import { getSharedDb } from "../state/shared-db";
import { bridgeSignal } from "./bridge-context";
import type { SessionTarget } from "./session-target";

interface RuntimeRow {
  generation: number;
  lease_token: string | null;
  owner_pid: number | null;
  child_pid: number | null;
}

interface Lease {
  db: Database;
  key: string;
  token: string;
  generation: number;
  active: boolean;
}

const leases = new AsyncLocalStorage<Lease>();

function runtimeRow(db: Database, key: string): RuntimeRow {
  return db.query<RuntimeRow, [string]>("SELECT * FROM session_runtime WHERE key = ?").get(key)!;
}

/** A successful native snapshot distinguishes dead/zombie owners from live groups. */
async function processSnapshot(): Promise<{
  ownerAlive(pid: number): boolean;
  groupAlive(pid: number): boolean;
}> {
  const windows = process.platform === "win32";
  const proc = Bun.spawn(
    windows
      ? [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress",
        ]
      : ["ps", "-e", "-o", "pid=,pgid=,stat="],
    { stdout: "pipe", stderr: "pipe", windowsHide: true }
  );
  const [code, output, error] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0 || !output.trim()) throw new Error(`Cannot inspect session lease processes: ${error}`);
  if (windows) {
    const parsed = JSON.parse(output);
    const rows: { ProcessId: number; ParentProcessId: number }[] = Array.isArray(parsed) ? parsed : [parsed];
    if (!rows.every((row) => Number.isInteger(row.ProcessId) && Number.isInteger(row.ParentProcessId)))
      throw new Error("Invalid session lease process snapshot");
    const live = new Set(rows.map((row) => row.ProcessId));
    return {
      ownerAlive: (pid) => live.has(pid),
      groupAlive: (pid) => {
        const descendants = new Set([pid]);
        let size: number;
        do {
          size = descendants.size;
          for (const row of rows) if (descendants.has(row.ParentProcessId)) descendants.add(row.ProcessId);
        } while (descendants.size !== size);
        return [...descendants].some((child) => live.has(child));
      },
    };
  }
  const rows = output
    .trim()
    .split("\n")
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/);
      if (!match) throw new Error("Invalid session lease process snapshot");
      return { pid: Number(match[1]), group: Number(match[2]), live: !match[3].startsWith("Z") };
    });
  return {
    ownerAlive: (pid) => rows.some((row) => row.pid === pid && row.live),
    groupAlive: (pid) => rows.some((row) => (row.group === pid || row.pid === pid) && row.live),
  };
}

function sameLease(db: Database, key: string, row: RuntimeRow, token: string): number {
  return db
    .prepare(
      "UPDATE session_runtime SET lease_token = ?, owner_pid = ?, child_pid = NULL WHERE key = ? AND lease_token IS ? AND owner_pid IS ? AND child_pid IS ?"
    )
    .run(token, process.pid, key, row.lease_token, row.owner_pid, row.child_pid).changes;
}

async function acquire(target: SessionTarget): Promise<Lease> {
  const db = await getSharedDb(canonicalWorkspace(target.workspace));
  const token = randomUUID();
  const signal = bridgeSignal();
  while (true) {
    signal?.throwIfAborted();
    const row = db
      .transaction(() => {
        db.prepare("INSERT INTO session_runtime (key) VALUES (?) ON CONFLICT(key) DO NOTHING").run(
          target.key
        );
        const current = runtimeRow(db, target.key);
        if (current.lease_token === null) {
          sameLease(db, target.key, current, token);
          return runtimeRow(db, target.key);
        }
        return current;
      })
      .immediate();
    if (row.lease_token === token)
      return { db, key: target.key, token, generation: row.generation, active: true };
    // Probing must never hold SQLite's writer lock. Recovery does not signal PIDs.
    const snapshot = await processSnapshot();
    signal?.throwIfAborted();
    if (
      !(row.owner_pid && snapshot.ownerAlive(row.owner_pid)) &&
      !(row.child_pid && snapshot.groupAlive(row.child_pid))
    ) {
      const recovered = db
        .transaction(() => {
          if (sameLease(db, target.key, row, token) !== 1) return null;
          return runtimeRow(db, target.key);
        })
        .immediate();
      if (recovered) return { db, key: target.key, token, generation: recovered.generation, active: true };
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(signal?.reason ?? new Error("Session lease wait cancelled"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, 50);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
}

function activeLease(): Lease | undefined {
  const lease = leases.getStore();
  if (lease && !lease.active) throw new Error("Session lease context is no longer active");
  return lease;
}

export function hasSessionLease(): boolean {
  return activeLease() !== undefined;
}

export function leaseGeneration(): number | undefined {
  return activeLease()?.generation;
}

/** Commit process ownership before a guarded child receives launch permission. */
export async function registerLeaseProcess(pid: number): Promise<void> {
  const lease = activeLease();
  if (!lease) return;
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid session lease child PID");
  const row = runtimeRow(lease.db, lease.key);
  if (row.lease_token !== lease.token || row.owner_pid !== process.pid || row.generation !== lease.generation)
    throw new Error("Session lease changed before child registration");
  if (row.child_pid !== null && row.child_pid !== pid && (await processSnapshot()).groupAlive(row.child_pid))
    throw new Error("Session lease still owns an active child group");
  activeLease();
  const updated = lease.db
    .transaction(
      () =>
        lease.db
          .prepare(
            "UPDATE session_runtime SET child_pid = ? WHERE key = ? AND lease_token = ? AND owner_pid = ? AND child_pid IS ? AND generation = ?"
          )
          .run(pid, lease.key, lease.token, process.pid, row.child_pid, lease.generation).changes
    )
    .immediate();
  if (updated !== 1) throw new Error("Session lease changed before child registration");
}

/** A surviving background descendant keeps its process group recorded. */
export async function releaseLeaseProcess(pid: number): Promise<void> {
  const lease = activeLease();
  if (!lease) return;
  if ((await processSnapshot()).groupAlive(pid)) return;
  activeLease();
  lease.db
    .prepare(
      "UPDATE session_runtime SET child_pid = NULL WHERE key = ? AND lease_token = ? AND owner_pid = ? AND child_pid = ?"
    )
    .run(lease.key, lease.token, process.pid, pid);
}

export async function withSessionLease<T>(target: SessionTarget, work: () => Promise<T>): Promise<T> {
  const lease = await acquire(target);
  try {
    return await leases.run(lease, work);
  } finally {
    lease.active = false;
    const row = runtimeRow(lease.db, lease.key);
    if (row.lease_token === lease.token) {
      // A failed probe retains the child fence but retires this turn's owner PID.
      let live = row.child_pid !== null;
      try {
        if (row.child_pid !== null) live = (await processSnapshot()).groupAlive(row.child_pid);
      } catch {
        // Recovery may retry the probe; it must never steal on an unknown outcome.
      }
      lease.db
        .prepare(
          "UPDATE session_runtime SET lease_token = ?, owner_pid = ?, child_pid = ? WHERE key = ? AND lease_token = ? AND owner_pid IS ? AND child_pid IS ?"
        )
        .run(
          live ? lease.token : null,
          live ? 0 : null,
          live ? row.child_pid : null,
          lease.key,
          lease.token,
          row.owner_pid,
          row.child_pid
        );
    }
  }
}
