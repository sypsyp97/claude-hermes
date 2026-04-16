/**
 * Memory entries — durable per-scope facts. Scope is one of `user`, `channel`,
 * `workspace`; the (scope, key) pair is deliberately non-unique so the
 * nudge-writer can append with deduping handled at the query layer.
 */

import type { Database } from "../db";

export type MemoryScope = "user" | "channel" | "workspace";

export interface MemoryRow {
  id: number;
  scope: MemoryScope;
  key: string;
  value: string;
  source_session_id: number | null;
  created_at: string;
  expires_at: string | null;
}

export interface NewMemory {
  scope: MemoryScope;
  key: string;
  value: string;
  sourceSessionId?: number | null;
  expiresAt?: string | null;
}

export function insertMemory(db: Database, input: NewMemory): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO memory_entries (scope, key, value, source_session_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(input.scope, input.key, input.value, input.sourceSessionId ?? null, now, input.expiresAt ?? null);
  return Number(result.lastInsertRowid);
}

export interface MemoryFilter {
  scope?: MemoryScope;
  key?: string;
  now?: string;
}

export function listMemory(db: Database, filter: MemoryFilter = {}): MemoryRow[] {
  const now = filter.now ?? new Date().toISOString();
  const clauses = ["(expires_at IS NULL OR expires_at > ?)"];
  const params: (string | number)[] = [now];
  if (filter.scope) {
    clauses.push("scope = ?");
    params.push(filter.scope);
  }
  if (filter.key) {
    clauses.push("key = ?");
    params.push(filter.key);
  }
  const sql = `SELECT * FROM memory_entries WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`;
  return db.query<MemoryRow, typeof params>(sql).all(...params);
}

export function deleteExpired(db: Database, now = new Date().toISOString()): number {
  return db.prepare("DELETE FROM memory_entries WHERE expires_at IS NOT NULL AND expires_at <= ?").run(now)
    .changes;
}

export function deleteById(db: Database, id: number): boolean {
  return db.prepare("DELETE FROM memory_entries WHERE id = ?").run(id).changes > 0;
}
