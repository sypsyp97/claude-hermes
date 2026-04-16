import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { applyMigrations, closeDb, type Database, openDb } from "../index";
import {
  bumpTurn,
  deleteByKey,
  getById,
  getByKey,
  listRecent,
  markCompactWarned,
  setClaudeSessionId,
  upsertSession,
} from "./sessions";

let db: Database;

beforeAll(async () => {
  db = openDb({ path: ":memory:" });
  await applyMigrations(db);
});

afterAll(() => {
  closeDb(db);
});

beforeEach(() => {
  db.exec("DELETE FROM sessions");
});

describe("upsertSession", () => {
  test("inserts with defaults and returns the full row", () => {
    const row = upsertSession(db, {
      key: "dm:alice",
      scope: "per-user",
      source: "discord",
      workspace: "/tmp/proj",
      user: "alice",
    });
    expect(row.id).toBeGreaterThan(0);
    expect(row.key).toBe("dm:alice");
    expect(row.scope).toBe("per-user");
    expect(row.source).toBe("discord");
    expect(row.workspace).toBe("/tmp/proj");
    expect(row.user).toBe("alice");
    expect(row.guild).toBeNull();
    expect(row.channel).toBeNull();
    expect(row.thread).toBeNull();
    expect(row.claude_session_id).toBeNull();
    expect(row.turn_count).toBe(0);
    expect(row.compact_warned).toBe(0);
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(row.last_used_at).toBe(row.created_at);
  });

  test("optional fields default to null when omitted", () => {
    const row = upsertSession(db, {
      key: "s1",
      scope: "workspace",
      source: "cli",
      workspace: "/tmp/p",
    });
    expect(row.guild).toBeNull();
    expect(row.channel).toBeNull();
    expect(row.thread).toBeNull();
    expect(row.user).toBeNull();
    expect(row.claude_session_id).toBeNull();
  });

  test("stores guild/channel/thread/user/claudeSessionId when provided", () => {
    const row = upsertSession(db, {
      key: "full",
      scope: "per-thread",
      source: "discord",
      workspace: "/tmp/p",
      guild: "g",
      channel: "c",
      thread: "t",
      user: "u",
      claudeSessionId: "claude-abc",
    });
    expect(row.guild).toBe("g");
    expect(row.channel).toBe("c");
    expect(row.thread).toBe("t");
    expect(row.user).toBe("u");
    expect(row.claude_session_id).toBe("claude-abc");
  });

  test("upsert on existing key updates last_used_at only, keeps turn_count and id", async () => {
    const first = upsertSession(db, {
      key: "k",
      scope: "workspace",
      source: "cli",
      workspace: "/tmp/p",
    });
    bumpTurn(db, first.id);
    bumpTurn(db, first.id);

    // Wait a tiny bit so the timestamp actually moves forward.
    await new Promise((r) => setTimeout(r, 10));
    const second = upsertSession(db, {
      key: "k",
      scope: "workspace",
      source: "cli",
      workspace: "/tmp/p",
    });
    expect(second.id).toBe(first.id);
    expect(second.turn_count).toBe(2);
    expect(second.last_used_at >= first.last_used_at).toBe(true);
  });

  test("duplicate keys across sessions are rejected by UNIQUE constraint", () => {
    upsertSession(db, { key: "dup", scope: "workspace", source: "cli", workspace: "/tmp/p" });
    // Another upsert with the same key is legal — it just updates. But a raw
    // insert with the same key should fail.
    expect(() => {
      db.prepare(
        "INSERT INTO sessions (key, scope, source, workspace, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("dup", "workspace", "cli", "/tmp/p", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z");
    }).toThrow();
  });
});

describe("getByKey / getById", () => {
  test("getByKey returns null for unknown key", () => {
    expect(getByKey(db, "ghost")).toBeNull();
  });

  test("getById returns null for unknown id", () => {
    expect(getById(db, 99_999)).toBeNull();
  });

  test("round-trip via both getters", () => {
    const row = upsertSession(db, {
      key: "k",
      scope: "workspace",
      source: "cli",
      workspace: "/tmp/p",
    });
    expect(getByKey(db, "k")?.id).toBe(row.id);
    expect(getById(db, row.id)?.key).toBe("k");
  });
});

describe("listRecent", () => {
  test("empty db returns []", () => {
    expect(listRecent(db)).toEqual([]);
  });

  test("orders by last_used_at DESC and honours limit", () => {
    db.prepare(
      "INSERT INTO sessions (key, scope, source, workspace, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("a", "workspace", "cli", "/p", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO sessions (key, scope, source, workspace, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("b", "workspace", "cli", "/p", "2024-06-01T00:00:00.000Z", "2024-06-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO sessions (key, scope, source, workspace, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("c", "workspace", "cli", "/p", "2024-12-01T00:00:00.000Z", "2024-12-01T00:00:00.000Z");

    expect(listRecent(db).map((r) => r.key)).toEqual(["c", "b", "a"]);
    expect(listRecent(db, 2).map((r) => r.key)).toEqual(["c", "b"]);
  });
});

describe("bumpTurn", () => {
  test("increments turn_count and updates last_used_at", async () => {
    const row = upsertSession(db, {
      key: "t",
      scope: "workspace",
      source: "cli",
      workspace: "/p",
    });
    await new Promise((r) => setTimeout(r, 10));
    bumpTurn(db, row.id);
    bumpTurn(db, row.id);
    bumpTurn(db, row.id);

    const after = getById(db, row.id);
    expect(after?.turn_count).toBe(3);
    expect(after && after.last_used_at >= row.last_used_at).toBe(true);
  });

  test("bumpTurn on missing id is a no-op", () => {
    expect(() => bumpTurn(db, 123_456)).not.toThrow();
  });
});

describe("setClaudeSessionId", () => {
  test("writes claude_session_id and bumps last_used_at", async () => {
    const row = upsertSession(db, {
      key: "c-sid",
      scope: "workspace",
      source: "cli",
      workspace: "/p",
    });
    expect(row.claude_session_id).toBeNull();

    await new Promise((r) => setTimeout(r, 5));
    setClaudeSessionId(db, row.id, "claude-zzz");
    const after = getById(db, row.id);
    expect(after?.claude_session_id).toBe("claude-zzz");
    expect(after && after.last_used_at >= row.last_used_at).toBe(true);
  });

  test("setClaudeSessionId may be called repeatedly to overwrite", () => {
    const row = upsertSession(db, {
      key: "ov",
      scope: "workspace",
      source: "cli",
      workspace: "/p",
    });
    setClaudeSessionId(db, row.id, "first");
    setClaudeSessionId(db, row.id, "second");
    expect(getById(db, row.id)?.claude_session_id).toBe("second");
  });
});

describe("markCompactWarned", () => {
  test("sets compact_warned=1 from default 0", () => {
    const row = upsertSession(db, {
      key: "cw",
      scope: "workspace",
      source: "cli",
      workspace: "/p",
    });
    expect(row.compact_warned).toBe(0);
    markCompactWarned(db, row.id);
    expect(getById(db, row.id)?.compact_warned).toBe(1);
  });

  test("idempotent when already set", () => {
    const row = upsertSession(db, {
      key: "cw2",
      scope: "workspace",
      source: "cli",
      workspace: "/p",
    });
    markCompactWarned(db, row.id);
    markCompactWarned(db, row.id);
    expect(getById(db, row.id)?.compact_warned).toBe(1);
  });
});

describe("deleteByKey", () => {
  test("removes an existing row and reports true", () => {
    upsertSession(db, { key: "gone", scope: "workspace", source: "cli", workspace: "/p" });
    expect(deleteByKey(db, "gone")).toBe(true);
    expect(getByKey(db, "gone")).toBeNull();
  });

  test("returns false for unknown key", () => {
    expect(deleteByKey(db, "ghost")).toBe(false);
  });
});
