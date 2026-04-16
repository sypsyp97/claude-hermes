/**
 * One-shot importer: lifts legacy JSON state into the SQLite DB on first boot
 * after Phase 2 lands. Idempotent — re-running is safe because every repo
 * upserts by primary key.
 *
 * Two things had to be fixed before this was safe to call:
 *
 *   1. Shape mismatch. Legacy `sessions.json` is `{ threads: { id: { ... } } }`
 *      (the sessionManager.ts writer shape), not a bare `Record<id, session>`.
 *      The old iteration stepped once with `[key, value] = ["threads", ...]`
 *      and silently skipped every real session.
 *
 *   2. Key-format mismatch. The importer used to write `global` / `thread:<id>`
 *      while the live router produces `workspace:<hash>` / `thread:<source>:<id>`.
 *      Imported rows existed but the lookup path never hit them. The importer
 *      now emits keys via the same helpers the router uses, so a row inserted
 *      here is the same row the live code will load.
 *
 * Called from the daemon startup path AFTER `migrateIfNeeded()` has moved
 * `.claude/claudeclaw/` → `.claude/hermes/` and AFTER `applyMigrations()` has
 * built the schema. If the legacy files are absent, this is a no-op.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { sessionFile, threadSessionsFile } from "../paths";
import { threadKey, workspaceKey } from "../router/session-key";
import type { Database } from "./db";
import { upsertSession } from "./repos/sessions";

export interface ImportSummary {
  globalSession: boolean;
  threadSessions: number;
}

export interface ImportOptions {
  /**
   * The `source` value assigned to imported thread sessions. The router key
   * contract is `thread:<source>:<id>`, but the legacy JSON only knew the
   * bare thread id. Discord is the only bridge in the current codebase that
   * creates thread sessions, so "discord" is the safe default; callers that
   * know otherwise can pass a different value.
   */
  threadSource?: "discord" | "telegram" | "cli";
}

interface LegacyGlobalSession {
  sessionId?: string;
  lastUsedAt?: string;
}

interface LegacyThreadSession {
  sessionId?: string;
  createdAt?: string;
  lastUsedAt?: string;
}

interface LegacyThreadsEnvelope {
  threads?: Record<string, LegacyThreadSession>;
}

export async function importLegacyJson(
  db: Database,
  cwd: string = process.cwd(),
  options: ImportOptions = {}
): Promise<ImportSummary> {
  const summary: ImportSummary = { globalSession: false, threadSessions: 0 };
  const threadSource = options.threadSource ?? "discord";

  const globalPath = sessionFile(cwd);
  if (existsSync(globalPath)) {
    const parsed = await readJson<LegacyGlobalSession>(globalPath);
    if (parsed?.sessionId) {
      upsertSession(db, {
        key: workspaceKey(cwd),
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
    const envelope = await readJson<LegacyThreadsEnvelope>(threadsPath);
    const threads = envelope?.threads;
    if (threads && typeof threads === "object") {
      for (const [threadId, entry] of Object.entries(threads)) {
        if (!entry || typeof entry !== "object") continue;
        if (!entry.sessionId) continue;
        upsertSession(db, {
          key: threadKey(threadSource, threadId),
          scope: "per-thread",
          source: threadSource,
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
