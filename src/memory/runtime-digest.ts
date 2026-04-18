/**
 * Deterministic runtime digest sourced from `state.db`.
 *
 * The digest is compact enough to live in the appended system prompt on every
 * run, and stable enough that identical persisted state yields byte-identical
 * output. We intentionally omit volatile timestamps from the rendered text:
 * recency drives selection and ordering, while the prompt body only carries
 * durable fact/value pairs plus short message excerpts from recent sessions.
 */

import type { Database } from "../state/db";

const DEFAULT_FACT_LIMIT = 8;
const DEFAULT_SESSION_LIMIT = 4;
const DEFAULT_MESSAGES_PER_SESSION = 2;
const DEFAULT_FACT_CHARS = 160;
const DEFAULT_MESSAGE_CHARS = 220;

interface FactRow {
  id: number;
  scope: string;
  key: string;
  value: string;
  created_at: string;
}

interface SessionRow {
  id: number;
  key: string;
  scope: string;
  source: string;
  last_used_at: string;
}

interface SessionMessageRow {
  id: number;
  role: "user" | "assistant";
  content: string;
  ts: string;
}

export interface RuntimeDigestOptions {
  now?: string;
  factsLimit?: number;
  sessionsLimit?: number;
  messagesPerSession?: number;
  maxFactChars?: number;
  maxMessageChars?: number;
}

export function buildRuntimeMemoryDigest(db: Database, options: RuntimeDigestOptions = {}): string {
  const now = options.now ?? new Date().toISOString();
  const factsLimit = positiveInt(options.factsLimit, DEFAULT_FACT_LIMIT);
  const sessionsLimit = positiveInt(options.sessionsLimit, DEFAULT_SESSION_LIMIT);
  const messagesPerSession = positiveInt(options.messagesPerSession, DEFAULT_MESSAGES_PER_SESSION);
  const maxFactChars = positiveInt(options.maxFactChars, DEFAULT_FACT_CHARS);
  const maxMessageChars = positiveInt(options.maxMessageChars, DEFAULT_MESSAGE_CHARS);

  const sections: string[] = [];

  const facts = listRecentFacts(db, now, factsLimit)
    .map((row) => formatFact(row, maxFactChars))
    .filter((line): line is string => line !== null);
  if (facts.length > 0) {
    sections.push(["Recent durable facts:", ...facts].join("\n"));
  }

  const sessions = listRecentSessions(db, sessionsLimit);
  const sessionLines: string[] = [];
  for (const session of sessions) {
    const rendered = formatSession(
      session,
      listSessionMessages(db, session.id, messagesPerSession),
      maxMessageChars
    );
    if (rendered.length > 0) {
      sessionLines.push(...rendered);
    }
  }
  if (sessionLines.length > 0) {
    sections.push(["Recent persisted conversation context:", ...sessionLines].join("\n"));
  }

  if (sections.length === 0) return "";
  return ["<state-digest>", "## Prior context from state.db", ...sections, "</state-digest>"].join("\n\n");
}

function listRecentFacts(db: Database, now: string, limit: number): FactRow[] {
  return db
    .query<FactRow, [string, number]>(
      `WITH ranked AS (
         SELECT id,
                scope,
                key,
                value,
                created_at,
                ROW_NUMBER() OVER (
                  PARTITION BY scope, key
                  ORDER BY created_at DESC, id DESC
                ) AS rn
         FROM memory_entries
         WHERE (expires_at IS NULL OR expires_at > ?)
           AND scope IN ('user', 'workspace')
       )
       SELECT id, scope, key, value, created_at
       FROM ranked
       WHERE rn = 1
       ORDER BY created_at DESC, id DESC, scope ASC, key ASC
       LIMIT ?`
    )
    .all(now, limit);
}

function listRecentSessions(db: Database, limit: number): SessionRow[] {
  return db
    .query<SessionRow, [number]>(
      `SELECT sessions.id,
              sessions.key,
              sessions.scope,
              sessions.source,
              sessions.last_used_at
       FROM sessions
       WHERE EXISTS (
         SELECT 1
         FROM messages
         WHERE messages.session_id = sessions.id
           AND messages.role IN ('user', 'assistant')
           AND trim(messages.content) <> ''
       )
       ORDER BY sessions.last_used_at DESC, sessions.id DESC
       LIMIT ?`
    )
    .all(limit);
}

function listSessionMessages(db: Database, sessionId: number, limit: number): SessionMessageRow[] {
  const rows = db
    .query<SessionMessageRow, [number, number]>(
      `SELECT id, role, content, ts
       FROM messages
       WHERE session_id = ?
         AND role IN ('user', 'assistant')
         AND trim(content) <> ''
       ORDER BY ts DESC, id DESC
       LIMIT ?`
    )
    .all(sessionId, limit);
  rows.reverse();
  return rows;
}

function formatFact(row: FactRow, maxChars: number): string | null {
  const key = normalizeInline(row.key);
  const value = normalizeInline(row.value);
  if (!key || !value) return null;
  return `- ${row.scope}.${clip(key, 48)} = ${clip(value, maxChars)}`;
}

function formatSession(session: SessionRow, messages: SessionMessageRow[], maxChars: number): string[] {
  const lines: string[] = [];
  const key = clip(normalizeInline(session.key), 80);
  if (!key) return lines;

  const renderedMessages = messages
    .map((message) => {
      const content = clip(normalizeInline(message.content), maxChars);
      if (!content) return "";
      return `  ${message.role}: ${content}`;
    })
    .filter((line) => line.length > 0);

  if (renderedMessages.length === 0) return lines;

  lines.push(`- ${key} [${session.source}/${session.scope}]`);
  lines.push(...renderedMessages);
  return lines;
}

function normalizeInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clip(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
