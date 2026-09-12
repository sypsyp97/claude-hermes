import { createHash } from "node:crypto";
import { join } from "node:path";
import { hermesDir } from "../paths";
/** A resolved conversation identity shared by execution, controls and recall. */
import type { MemoryScope } from "../policy/channel";
import type { SessionScope } from "../router/envelope";
import { threadKey, workspaceKey } from "../router/session-key";
import { getSharedDb } from "../state/shared-db";
import {
  bumpTurn,
  getByKey,
  markCompactWarned,
  replaceSession,
  touchLastUsed,
} from "../state/repos/sessions";
import * as workspaceSessions from "../sessions";
import * as threadSessions from "../sessionManager";
import type { ThreadSource } from "../sessionManager";

export interface SessionTarget {
  key: string;
  scope: SessionScope;
  source: ThreadSource;
  workspace: string;
  guild?: string;
  channel?: string;
  thread?: string;
  user?: string;
  memoryScope: MemoryScope;
}

export type SessionInput = string | SessionTarget;

export function sessionAccess(input: SessionInput | undefined, source: ThreadSource = "cli") {
  const scoped = typeof input === "object";
  const thread = typeof input === "string" ? input : undefined;
  const target: SessionTarget = scoped
    ? input
    : {
        key: thread ? threadKey(source, thread) : workspaceKey(process.cwd()),
        scope: thread ? "per-thread" : "workspace",
        source: thread ? source : "cli",
        workspace: process.cwd(),
        thread,
        memoryScope: thread ? "channel" : "workspace",
      };
  async function peek() {
    if (!scoped)
      return thread ? threadSessions.peekThreadSession(source, thread) : workspaceSessions.peekSession();
    const row = getByKey(await getSharedDb(target.workspace), target.key);
    return row?.claude_session_id
      ? {
          sessionId: row.claude_session_id,
          turnCount: row.turn_count,
          compactWarned: row.compact_warned !== 0,
          createdAt: row.created_at,
          lastUsedAt: row.last_used_at,
        }
      : null;
  }
  return {
    target,
    scoped,
    peek,
    async get() {
      if (!scoped)
        return thread ? threadSessions.getThreadSession(source, thread) : workspaceSessions.getSession();
      const db = await getSharedDb(target.workspace);
      const row = getByKey(db, target.key);
      if (row?.claude_session_id) touchLastUsed(db, row.id);
      return peek();
    },
    async create(sessionId: string) {
      if (!scoped)
        return thread
          ? threadSessions.createThreadSession(source, thread, sessionId)
          : workspaceSessions.createSession(sessionId);
      replaceSession(await getSharedDb(target.workspace), { ...target, claudeSessionId: sessionId });
    },
    async increment() {
      if (!scoped)
        return thread
          ? threadSessions.incrementThreadTurn(source, thread)
          : workspaceSessions.incrementTurn();
      const db = await getSharedDb(target.workspace);
      const row = getByKey(db, target.key);
      if (!row) return 0;
      bumpTurn(db, row.id);
      return row.turn_count + 1;
    },
    async markWarned() {
      if (!scoped)
        return thread
          ? threadSessions.markThreadCompactWarned(source, thread)
          : workspaceSessions.markCompactWarned();
      const db = await getSharedDb(target.workspace);
      const row = getByKey(db, target.key);
      if (row) markCompactWarned(db, row.id);
    },
    async reset() {
      if (!scoped)
        return thread ? threadSessions.removeThreadSession(source, thread) : workspaceSessions.resetSession();
      // A fresh Claude context keeps attributed long-term memory searchable.
      const db = await getSharedDb(target.workspace);
      db.prepare(
        "UPDATE sessions SET claude_session_id = NULL, turn_count = 0, compact_warned = 0 WHERE key = ?"
      ).run(target.key);
    },
  };
}

/** Claude Code >= 2.1.257: per-conversation native auto memory and refreshed runtime context. */
export function claudeSessionArgs(target: SessionTarget): string[] {
  const id = createHash("sha256").update(target.key).digest("hex");
  return [
    "--settings",
    JSON.stringify({
      autoMemoryDirectory: join(hermesDir(target.workspace), "claude-memory", id),
      ...(target.memoryScope === "none" ? { autoMemoryEnabled: false } : {}),
    }),
    "--system-prompt-snapshot",
    "off",
  ];
}
