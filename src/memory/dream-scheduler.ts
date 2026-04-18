/**
 * Rate-limited cron driver for the Dream consolidation pass.
 *
 * Persists `dream.lastRunAt` into the `kv` table (migration 005_kv.sql) so the
 * gate survives daemon restarts. The daemon's 60s cron tick calls
 * `maybeRunDream` unconditionally; this module decides whether to actually
 * fire `runDream` based on the configured interval.
 *
 * Race tolerance: SQLite WAL serializes writes, but two concurrent
 * `maybeRunDream` callers can both pass the gate before either persists. The
 * test spec accepts that case as long as the kv row ends up populated.
 */

import type { Database } from "../state/db";
import { type DreamResult, runDream } from "./dream";

const HOUR_MS = 3_600_000;
const KV_KEY = "dream.lastRunAt";

export interface DreamScheduleSettings {
  dreamCron: boolean;
  dreamIntervalHours?: number;
  dreamAgeDays?: number;
}

export interface MaybeRunDreamOptions {
  now?: Date;
  cwd?: string;
}

export type MaybeRunDreamResult =
  | { ran: false; reason: "disabled" | "throttled" }
  | { ran: true; result: DreamResult };

export async function maybeRunDream(
  db: Database,
  settings: DreamScheduleSettings,
  opts: MaybeRunDreamOptions = {}
): Promise<MaybeRunDreamResult> {
  if (!settings.dreamCron) {
    return { ran: false, reason: "disabled" };
  }

  const now = opts.now ?? new Date();
  const intervalHours = settings.dreamIntervalHours ?? 24;
  const ageDays = settings.dreamAgeDays ?? 7;

  const row = db.query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?").get(KV_KEY);

  if (row) {
    const lastRunAt = new Date(row.value);
    if (!Number.isNaN(lastRunAt.getTime()) && now.getTime() - lastRunAt.getTime() < intervalHours * HOUR_MS) {
      return { ran: false, reason: "throttled" };
    }
  }

  const result = await runDream(db, { ageDays, now, cwd: opts.cwd });

  const iso = now.toISOString();
  db.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)").run(KV_KEY, iso, iso);

  return { ran: true, result };
}
