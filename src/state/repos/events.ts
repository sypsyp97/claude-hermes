/**
 * Learn events — append-only journal substrate. Phase 6 writes skill-pipeline
 * decisions here; Phase 8 (evolve loop) reuses the same table for
 * self-rewrite plan/commit/revert entries. Kind is a free-form string — see
 * callers for the vocabulary.
 */

import type { Database } from "../db";

export interface EventRow {
  id: number;
  ts: string;
  kind: string;
  payload_json: string;
}

export function appendEvent(db: Database, kind: string, payload: unknown): number {
  const result = db
    .prepare("INSERT INTO learn_events (ts, kind, payload_json) VALUES (?, ?, ?)")
    .run(new Date().toISOString(), kind, JSON.stringify(payload ?? {}));
  return Number(result.lastInsertRowid);
}

export interface EventFilter {
  kindPrefix?: string;
  since?: string;
  limit?: number;
}

export interface ParsedEvent<T = unknown> {
  id: number;
  ts: string;
  kind: string;
  payload: T;
}

export function listEvents<T = unknown>(db: Database, filter: EventFilter = {}): ParsedEvent<T>[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter.kindPrefix) {
    clauses.push("kind LIKE ?");
    params.push(`${filter.kindPrefix}%`);
  }
  if (filter.since) {
    clauses.push("ts >= ?");
    params.push(filter.since);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = filter.limit ?? 100;
  params.push(limit);
  const rows = db
    .query<EventRow, typeof params>(`SELECT * FROM learn_events ${where} ORDER BY ts DESC LIMIT ?`)
    .all(...params);
  return rows.map((row) => ({
    id: row.id,
    ts: row.ts,
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as T,
  }));
}

export function countEvents(db: Database, filter: EventFilter = {}): number {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter.kindPrefix) {
    clauses.push("kind LIKE ?");
    params.push(`${filter.kindPrefix}%`);
  }
  if (filter.since) {
    clauses.push("ts >= ?");
    params.push(filter.since);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const row = db
    .query<{ n: number }, typeof params>(`SELECT COUNT(*) AS n FROM learn_events ${where}`)
    .get(...params);
  return row?.n ?? 0;
}
