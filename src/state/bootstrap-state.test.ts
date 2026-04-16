import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionKeyFor } from "../router/session-key";
import type { Envelope } from "../router/envelope";
import { bootstrapState } from "./bootstrap-state";
import { closeDb } from "./db";
import { getByKey } from "./repos/sessions";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "hermes-bootstrap-"));
  await mkdir(join(tempRoot, ".claude", "hermes"), { recursive: true });
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
});

describe("bootstrapState", () => {
  test("opens DB, applies migrations, and runs the legacy importer in one call", async () => {
    await writeFile(
      join(tempRoot, ".claude", "hermes", "session.json"),
      JSON.stringify({ sessionId: "claude-xyz" })
    );
    await writeFile(
      join(tempRoot, ".claude", "hermes", "sessions.json"),
      JSON.stringify({
        threads: {
          "thread-1": { sessionId: "claude-thread-1" },
          "thread-2": { sessionId: "claude-thread-2" },
        },
      })
    );

    const result = await bootstrapState(tempRoot);
    try {
      expect(result.migrationsApplied.length).toBeGreaterThan(0);
      expect(result.globalSessionImported).toBe(true);
      expect(result.threadSessionsImported).toBe(2);

      const envelope: Envelope = {
        source: "discord",
        workspace: tempRoot,
        user: { id: "U1", isAdmin: false },
        thread: "thread-1",
        message: { text: "" },
        attachments: [],
        trigger: "mention",
        receivedAt: new Date("2026-04-16T00:00:00Z"),
      };
      const key = sessionKeyFor({ envelope, scope: "per-thread" });
      const row = getByKey(result.db, key);
      expect(row?.claude_session_id).toBe("claude-thread-1");
    } finally {
      closeDb(result.db);
    }
  });

  test("idempotent: second call does not duplicate rows", async () => {
    await writeFile(
      join(tempRoot, ".claude", "hermes", "sessions.json"),
      JSON.stringify({
        threads: { "thread-once": { sessionId: "claude-once" } },
      })
    );

    const a = await bootstrapState(tempRoot);
    closeDb(a.db);
    const b = await bootstrapState(tempRoot);
    try {
      const c = b.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM sessions").get();
      expect(c?.c).toBe(1);
    } finally {
      closeDb(b.db);
    }
  });
});
