/**
 * Jobs repo — index of scheduled Markdown jobs on disk.
 * Rebuilt at startup from `jobs/*.md`; holds scheduler state (last run,
 * result) that would otherwise live in volatile memory.
 */

import type { Database } from "../db";

export interface JobRow {
  name: string;
  path: string;
  schedule: string;
  recurring: number;
  last_run_at: string | null;
  last_result: string | null;
  notify: number;
}

export interface JobUpsert {
  name: string;
  path: string;
  schedule: string;
  recurring?: boolean;
  notify?: boolean;
}

export function upsertJob(db: Database, input: JobUpsert): JobRow {
  db.prepare(
    `INSERT INTO jobs (name, path, schedule, recurring, notify)
     VALUES ($name, $path, $schedule, $recurring, $notify)
     ON CONFLICT(name) DO UPDATE SET
       path = excluded.path,
       schedule = excluded.schedule,
       recurring = excluded.recurring,
       notify = excluded.notify`
  ).run({
    $name: input.name,
    $path: input.path,
    $schedule: input.schedule,
    $recurring: input.recurring ? 1 : 0,
    $notify: input.notify ? 1 : 0,
  });
  return getJob(db, input.name)!;
}

export function getJob(db: Database, name: string): JobRow | null {
  return db.query<JobRow, [string]>("SELECT * FROM jobs WHERE name = ?").get(name) ?? null;
}

export function listJobs(db: Database): JobRow[] {
  return db.query<JobRow, []>("SELECT * FROM jobs ORDER BY name ASC").all();
}

export function recordRun(db: Database, name: string, result: string): void {
  db.prepare("UPDATE jobs SET last_run_at = ?, last_result = ? WHERE name = ?").run(
    new Date().toISOString(),
    result,
    name
  );
}

export function deleteJob(db: Database, name: string): boolean {
  return db.prepare("DELETE FROM jobs WHERE name = ?").run(name).changes > 0;
}

export function pruneMissing(db: Database, presentNames: string[]): number {
  if (presentNames.length === 0) {
    return db.prepare("DELETE FROM jobs").run().changes;
  }
  const placeholders = presentNames.map(() => "?").join(", ");
  return db.prepare(`DELETE FROM jobs WHERE name NOT IN (${placeholders})`).run(...presentNames).changes;
}
