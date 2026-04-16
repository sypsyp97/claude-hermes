/**
 * One-shot importer: lifts legacy JSON state into the SQLite DB on first boot
 * after Phase 2 lands. Idempotent — re-running is safe because every repo
 * upserts by primary key.
 *
 * Called from the daemon startup path AFTER `migrateIfNeeded()` has moved
 * `.claude/claudeclaw/` → `.claude/hermes/` and AFTER `applyMigrations()` has
 * built the schema. If the legacy files are absent, this is a no-op.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { sessionFile, threadSessionsFile } from "../paths";
import type { Database } from "./db";
import { upsertSession } from "./repos/sessions";

export interface ImportSummary {
  globalSession: boolean;
  threadSessions: number;
}

interface LegacyGlobalSession {
  sessionId?: string;
  lastUsedAt?: string;
}

interface LegacyThreadSession {
  sessionId: string;
  createdAt?: string;
  lastUsedAt?: string;
}

export async function importLegacyJson(db: Database, cwd: string = process.cwd()): Promise<ImportSummary> {
  const summary: ImportSummary = { globalSession: false, threadSessions: 0 };

  const globalPath = sessionFile(cwd);
  if (existsSync(globalPath)) {
    const parsed = await readJson<LegacyGlobalSession>(globalPath);
    if (parsed?.sessionId) {
      upsertSession(db, {
        key: "global",
        scope: "workspace",
        source: "cli",
        workspace: cwd,
        claudeSessionId: parsed.sessionId,
      });
      summary.globalSession = true;
    }
  }

  const threadsPath = threadSessionsFile(cwd);
  if (existsSync(threadsPath)) {
    const threads = await readJson<Record<string, LegacyThreadSession>>(threadsPath);
    if (threads) {
      for (const [threadId, entry] of Object.entries(threads)) {
        if (!entry?.sessionId) continue;
        upsertSession(db, {
          key: `thread:${threadId}`,
          scope: "per-thread",
          source: "discord",
          workspace: cwd,
          thread: threadId,
          claudeSessionId: entry.sessionId,
        });
        summary.threadSessions++;
      }
    }
  }

  return summary;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
