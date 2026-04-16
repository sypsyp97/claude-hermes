/**
 * Schema migrator. Walks `./migrations/*.sql` in lexical order and applies
 * anything not already recorded in `schema_migrations`.
 *
 * Each migration file is executed in a single transaction — the SQL files
 * own their own `CREATE TABLE IF NOT EXISTS` idempotency, but the outer
 * transaction guarantees all-or-nothing per version.
 */

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Database } from "./db";

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

export async function applyMigrations(db: Database): Promise<string[]> {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);"
  );

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

  const applied = new Set(
    db
      .query<{ version: string }, []>("SELECT version FROM schema_migrations")
      .all()
      .map((r) => r.version)
  );

  const run: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (applied.has(version)) continue;

    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    const now = new Date().toISOString();
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, now);
    })();
    run.push(version);
  }

  return run;
}
