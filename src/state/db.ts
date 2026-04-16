/**
 * Single SQLite handle for the daemon. WAL + synchronous=NORMAL + FK on.
 *
 * Callers construct one `Database` per daemon lifecycle and pass it into
 * the repo functions; there are no module-level singletons so tests can open
 * throwaway `:memory:` handles.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { stateDbFile } from "../paths";

export { Database };

export interface OpenDbOptions {
  path?: string;
  readonly?: boolean;
}

export function openDb(options: OpenDbOptions = {}): Database {
  const path = options.path ?? stateDbFile();
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path, options.readonly ? { readonly: true } : undefined);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

export function closeDb(db: Database): void {
  db.close();
}
