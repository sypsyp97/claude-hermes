/**
 * End-to-end state engine bootstrap for the daemon: open the DB, apply
 * schema migrations, and mirror any legacy JSON session state into SQLite
 * so the two stores can't drift. Safe to call on every boot — both steps
 * are idempotent.
 *
 * This is the bridge that closes the split-brain: runner.ts still reads
 * session state from sessions.ts / sessionManager.ts JSON files (that
 * surgery is a separate change), but after this runs the SQLite store
 * always has an up-to-date reflection. Any code that wants to consult
 * SQLite (status painter, evolve journal, future routing code) sees the
 * same sessions the live runner does.
 */

import { applyMigrations } from "./bootstrap";
import { type Database, openDb } from "./db";
import { importLegacyJson } from "./import-json";
import { stateDbFile } from "../paths";

export interface BootstrapResult {
  db: Database;
  migrationsApplied: string[];
  globalSessionImported: boolean;
  threadSessionsImported: number;
}

export async function bootstrapState(cwd: string = process.cwd()): Promise<BootstrapResult> {
  const db = openDb({ path: stateDbFile(cwd) });
  const migrationsApplied = await applyMigrations(db);
  const summary = await importLegacyJson(db, cwd);
  return {
    db,
    migrationsApplied,
    globalSessionImported: summary.globalSession,
    threadSessionsImported: summary.threadSessions,
  };
}
