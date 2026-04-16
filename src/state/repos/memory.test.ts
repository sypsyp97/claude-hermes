import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { applyMigrations, closeDb, type Database, openDb } from "../index";
import { deleteById, deleteExpired, insertMemory, listMemory } from "./memory";

let db: Database;

beforeAll(async () => {
  db = openDb({ path: ":memory:" });
  await applyMigrations(db);
});

afterAll(() => {
  closeDb(db);
});

beforeEach(() => {
  // memory_entries has a FK to sessions(ON DELETE SET NULL) — clean both so
  // source_session_id references do not leak between tests.
  db.exec("DELETE FROM memory_entries");
  db.exec("DELETE FROM sessions");
});

describe("insertMemory", () => {
  test("returns a positive id and persists values", () => {
    const id = insertMemory(db, { scope: "user", key: "fav-color", value: "indigo" });
    expect(id).toBeGreaterThan(0);

    const rows = listMemory(db, { scope: "user" });
    expect(rows.length).toBe(1);
    expect(rows[0].key).toBe("fav-color");
    expect(rows[0].value).toBe("indigo");
    expect(rows[0].source_session_id).toBeNull();
    expect(rows[0].expires_at).toBeNull();
  });

  test("stores optional sourceSessionId and expiresAt", () => {
    // Insert a fake session so we can point source_session_id at it.
    db.prepare(
      "INSERT INTO sessions (key, scope, source, workspace, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("dummy", "workspace", "cli", "/tmp/p", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z");
    const sessionId = db.query<{ id: number }, []>("SELECT id FROM sessions WHERE key='dummy'").get()!.id;

    const expires = "2099-01-01T00:00:00.000Z";
    insertMemory(db, {
      scope: "channel",
      key: "topic",
      value: "ops",
      sourceSessionId: sessionId,
      expiresAt: expires,
    });
    const [row] = listMemory(db, { scope: "channel", key: "topic" });
    expect(row.source_session_id).toBe(sessionId);
    expect(row.expires_at).toBe(expires);
  });

  test("same (scope,key) can be inserted multiple times (non-unique)", () => {
    const a = insertMemory(db, { scope: "user", key: "note", value: "first" });
    const b = insertMemory(db, { scope: "user", key: "note", value: "second" });
    expect(b).toBeGreaterThan(a);

    const rows = listMemory(db, { scope: "user", key: "note" });
    expect(rows.length).toBe(2);
    // DESC by created_at: second should appear first if timestamps differ —
    // but timestamps can collide within the same ms, so just check set.
    expect(rows.map((r) => r.value).sort()).toEqual(["first", "second"]);
  });

  test("same key in different scopes do not collide", () => {
    insertMemory(db, { scope: "user", key: "topic", value: "claws" });
    insertMemory(db, { scope: "channel", key: "topic", value: "ops" });
    insertMemory(db, { scope: "workspace", key: "topic", value: "hermes" });

    expect(listMemory(db, { scope: "user", key: "topic" })[0].value).toBe("claws");
    expect(listMemory(db, { scope: "channel", key: "topic" })[0].value).toBe("ops");
    expect(listMemory(db, { scope: "workspace", key: "topic" })[0].value).toBe("hermes");
  });
});

describe("listMemory filters", () => {
  test("empty db returns []", () => {
    expect(listMemory(db)).toEqual([]);
  });

  test("no filter returns all non-expired entries", () => {
    insertMemory(db, { scope: "user", key: "a", value: "1" });
    insertMemory(db, { scope: "channel", key: "b", value: "2" });
    insertMemory(db, { scope: "workspace", key: "c", value: "3" });
    expect(listMemory(db).length).toBe(3);
  });

  test("scope filter restricts to matching scope", () => {
    insertMemory(db, { scope: "user", key: "a", value: "u" });
    insertMemory(db, { scope: "channel", key: "a", value: "c" });
    const userOnly = listMemory(db, { scope: "user" });
    expect(userOnly.every((r) => r.scope === "user")).toBe(true);
    expect(userOnly.length).toBe(1);
  });

  test("key filter restricts to matching key", () => {
    insertMemory(db, { scope: "user", key: "alpha", value: "1" });
    insertMemory(db, { scope: "user", key: "beta", value: "2" });
    const alphas = listMemory(db, { key: "alpha" });
    expect(alphas.length).toBe(1);
    expect(alphas[0].key).toBe("alpha");
  });

  test("non-existent key filter returns []", () => {
    insertMemory(db, { scope: "user", key: "alpha", value: "1" });
    expect(listMemory(db, { key: "zulu" })).toEqual([]);
  });

  test("expires_at in the past hides the row; NULL never expires", () => {
    const past = "2000-01-01T00:00:00.000Z";
    const future = "2099-01-01T00:00:00.000Z";
    insertMemory(db, { scope: "user", key: "old", value: "gone", expiresAt: past });
    insertMemory(db, { scope: "user", key: "new", value: "live", expiresAt: future });
    insertMemory(db, { scope: "user", key: "forever", value: "always" });

    const visible = listMemory(db);
    expect(visible.map((r) => r.key).sort()).toEqual(["forever", "new"]);
  });

  test("filter.now lets callers pin the comparison time", () => {
    const t0 = "2025-06-01T00:00:00.000Z";
    const expiresLater = "2025-07-01T00:00:00.000Z";
    insertMemory(db, { scope: "user", key: "k", value: "v", expiresAt: expiresLater });

    // Before expiry — visible.
    expect(listMemory(db, { now: t0 }).length).toBe(1);
    // After expiry — hidden.
    expect(listMemory(db, { now: "2025-08-01T00:00:00.000Z" }).length).toBe(0);
  });

  test("orders by created_at DESC", () => {
    // Insert in a loop with sleeps would be flaky; instead reach in with
    // explicit timestamps to guarantee ordering.
    db.prepare("INSERT INTO memory_entries (scope, key, value, created_at) VALUES (?, ?, ?, ?)").run(
      "user",
      "k",
      "first",
      "2024-01-01T00:00:00.000Z"
    );
    db.prepare("INSERT INTO memory_entries (scope, key, value, created_at) VALUES (?, ?, ?, ?)").run(
      "user",
      "k",
      "second",
      "2024-06-01T00:00:00.000Z"
    );
    db.prepare("INSERT INTO memory_entries (scope, key, value, created_at) VALUES (?, ?, ?, ?)").run(
      "user",
      "k",
      "third",
      "2024-12-01T00:00:00.000Z"
    );

    const rows = listMemory(db, { scope: "user", key: "k" });
    expect(rows.map((r) => r.value)).toEqual(["third", "second", "first"]);
  });
});

describe("deleteExpired", () => {
  test("removes rows with expires_at <= now, leaves NULL and future alone", () => {
    insertMemory(db, { scope: "user", key: "e1", value: "x", expiresAt: "2000-01-01T00:00:00.000Z" });
    insertMemory(db, { scope: "user", key: "e2", value: "y", expiresAt: "2001-01-01T00:00:00.000Z" });
    insertMemory(db, { scope: "user", key: "future", value: "z", expiresAt: "2099-01-01T00:00:00.000Z" });
    insertMemory(db, { scope: "user", key: "forever", value: "w" });

    const deleted = deleteExpired(db, "2050-01-01T00:00:00.000Z");
    expect(deleted).toBe(2);

    // Include already-expired filter by asking for memory "as of" past time so
    // future rows are visible — but the deleted ones are gone.
    const remaining = db
      .query<{ key: string }, []>("SELECT key FROM memory_entries ORDER BY key")
      .all()
      .map((r) => r.key);
    expect(remaining.sort()).toEqual(["forever", "future"]);
  });

  test("returns 0 when nothing is expired", () => {
    insertMemory(db, { scope: "user", key: "k", value: "v" });
    expect(deleteExpired(db, "2099-12-31T00:00:00.000Z")).toBe(0);
  });
});

describe("deleteById", () => {
  test("removes by id and reports true", () => {
    const id = insertMemory(db, { scope: "user", key: "k", value: "v" });
    expect(deleteById(db, id)).toBe(true);
    expect(listMemory(db).length).toBe(0);
  });

  test("returns false for unknown id", () => {
    expect(deleteById(db, 999_999)).toBe(false);
  });
});
