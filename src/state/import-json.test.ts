import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Envelope } from "../router/envelope";
import { sessionKeyFor } from "../router/session-key";
import { type Database, closeDb, openDb } from "./db";
import { importLegacyJson } from "./import-json";
import { applyMigrations } from "./index";
import { getByKey } from "./repos/sessions";

let tempRoot: string;
let db: Database;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "hermes-import-"));
  await mkdir(join(tempRoot, ".claude", "hermes"), { recursive: true });
  db = openDb({ path: ":memory:" });
  await applyMigrations(db);
});

afterAll(async () => {
  closeDb(db);
  await rm(tempRoot, { recursive: true, force: true });
});

function makeThreadEnvelope(threadId: string, source: "discord" | "telegram" = "discord"): Envelope {
  return {
    source,
    workspace: tempRoot,
    user: { id: "U1", isAdmin: false },
    thread: threadId,
    message: { text: "" },
    attachments: [],
    trigger: "mention",
    receivedAt: new Date("2026-04-16T00:00:00Z"),
  };
}

function makeWorkspaceEnvelope(): Envelope {
  return {
    source: "cli",
    workspace: tempRoot,
    user: { id: "local", isAdmin: true },
    message: { text: "" },
    attachments: [],
    trigger: "mention",
    receivedAt: new Date("2026-04-16T00:00:00Z"),
  };
}

describe("importLegacyJson — shape compatibility", () => {
  test("reads thread sessions from the actual {threads:{...}} envelope (not bare records)", async () => {
    // This is the on-disk shape sessionManager.ts writes.
    await writeFile(
      join(tempRoot, ".claude", "hermes", "sessions.json"),
      JSON.stringify({
        threads: {
          "thread-abc": {
            sessionId: "claude-aaa",
            createdAt: "2026-04-01T00:00:00Z",
            lastUsedAt: "2026-04-10T00:00:00Z",
          },
          "thread-def": {
            sessionId: "claude-bbb",
            createdAt: "2026-04-02T00:00:00Z",
            lastUsedAt: "2026-04-11T00:00:00Z",
          },
        },
      })
    );
    const summary = await importLegacyJson(db, tempRoot);
    expect(summary.threadSessions).toBe(2);
  });

  test("does not crash or import on the old bare-record shape (never existed on disk anyway)", async () => {
    // Defensive: an unexpected shape should import nothing, not throw.
    await writeFile(
      join(tempRoot, ".claude", "hermes", "sessions.json"),
      JSON.stringify({ "thread-abc": { sessionId: "x" } })
    );
    const summary = await importLegacyJson(db, tempRoot);
    expect(summary.threadSessions).toBe(0);
  });

  test("no-ops when neither legacy file is present", async () => {
    const summary = await importLegacyJson(db, tempRoot);
    expect(summary).toEqual({ globalSession: false, threadSessions: 0 });
  });
});

describe("importLegacyJson — key format matches the live router contract", () => {
  test("workspace session lands under workspace:<hash>, matching sessionKeyFor", async () => {
    await writeFile(
      join(tempRoot, ".claude", "hermes", "session.json"),
      JSON.stringify({ sessionId: "claude-workspace-xyz" })
    );
    const summary = await importLegacyJson(db, tempRoot);
    expect(summary.globalSession).toBe(true);

    const liveKey = sessionKeyFor({ envelope: makeWorkspaceEnvelope(), scope: "workspace" });
    const row = getByKey(db, liveKey);
    expect(row).not.toBeNull();
    expect(row?.claude_session_id).toBe("claude-workspace-xyz");
  });

  test("thread session lands under thread:<source>:<id>, matching sessionKeyFor", async () => {
    await writeFile(
      join(tempRoot, ".claude", "hermes", "sessions.json"),
      JSON.stringify({
        threads: {
          "thread-777": { sessionId: "claude-thread-777" },
        },
      })
    );
    const summary = await importLegacyJson(db, tempRoot);
    expect(summary.threadSessions).toBe(1);

    const liveKey = sessionKeyFor({
      envelope: makeThreadEnvelope("thread-777", "discord"),
      scope: "per-thread",
    });
    const row = getByKey(db, liveKey);
    expect(row).not.toBeNull();
    expect(row?.claude_session_id).toBe("claude-thread-777");
    expect(row?.source).toBe("discord");
    expect(row?.thread).toBe("thread-777");
  });

  test("threadSource option overrides the default discord mapping", async () => {
    await writeFile(
      join(tempRoot, ".claude", "hermes", "sessions.json"),
      JSON.stringify({
        threads: {
          "tg-chat-42": { sessionId: "claude-tg-42" },
        },
      })
    );
    await importLegacyJson(db, tempRoot, { threadSource: "telegram" });
    const liveKey = sessionKeyFor({
      envelope: makeThreadEnvelope("tg-chat-42", "telegram"),
      scope: "per-thread",
    });
    const row = getByKey(db, liveKey);
    expect(row).not.toBeNull();
    expect(row?.source).toBe("telegram");
  });

  test("is idempotent: second import does not duplicate rows", async () => {
    await writeFile(
      join(tempRoot, ".claude", "hermes", "session.json"),
      JSON.stringify({ sessionId: "claude-workspace-xyz" })
    );
    await writeFile(
      join(tempRoot, ".claude", "hermes", "sessions.json"),
      JSON.stringify({
        threads: { "thread-777": { sessionId: "claude-thread-777" } },
      })
    );
    await importLegacyJson(db, tempRoot);
    await importLegacyJson(db, tempRoot);

    const count = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM sessions").get();
    expect(count?.c).toBe(2);
  });
});
