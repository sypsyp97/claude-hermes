import { rm } from "node:fs/promises";
import { canonicalWorkspace, nativeMemoryDirectory } from "../paths";
/** A resolved conversation identity shared by execution, controls and recall. */
import type { MemoryScope, ChannelPolicy } from "../policy/channel";
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
  policy?: Pick<ChannelPolicy, "allowedSkills" | "modelPolicy">;
}

export type SessionInput = string | SessionTarget;

export function sessionAccess(input: SessionInput | undefined, source: ThreadSource = "cli") {
  const scoped = typeof input === "object";
  const thread = typeof input === "string" ? input : undefined;
  const target: SessionTarget = scoped
    ? { ...input, workspace: canonicalWorkspace(input.workspace) }
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
    async forget() {
      if (!scoped) throw new Error("Forgetting memory requires an explicit conversation target.");
      const db = await getSharedDb(target.workspace);
      // Remove native files first: a filesystem error must not leave an
      // apparently forgotten conversation whose native memory still exists.
      await rm(nativeMemoryDirectory(target.workspace, target.key), { recursive: true, force: true });
      db.transaction(() => {
        const row = getByKey(db, target.key);
        if (row) db.prepare("DELETE FROM memory_entries WHERE source_session_id = ?").run(row.id);
        db.prepare("DELETE FROM sessions WHERE key = ?").run(target.key);
      })();
      if (target.thread) await threadSessions.forgetLegacyThread(target.thread, target.workspace);
    },
  };
}

/** Claude Code >= 2.1.257: per-conversation native auto memory and refreshed runtime context. */
export function claudeSessionArgs(target: SessionTarget): string[] {
  return [
    "--settings",
    JSON.stringify({
      autoMemoryDirectory: nativeMemoryDirectory(target.workspace, target.key),
      ...(target.memoryScope === "none" ? { autoMemoryEnabled: false } : {}),
    }),
    "--system-prompt-snapshot",
    "off",
  ];
}
