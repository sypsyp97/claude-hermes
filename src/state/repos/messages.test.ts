import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { applyMigrations, closeDb, type Database, openDb } from "../index";
import { appendMessage, listForSession, search } from "./messages";
import { upsertSession } from "./sessions";

let db: Database;

beforeAll(async () => {
  db = openDb({ path: ":memory:" });
  await applyMigrations(db);
});

afterAll(() => {
  closeDb(db);
});

beforeEach(() => {
  // Order matters: messages → sessions (FK). The FTS table is content-linked
  // to messages via triggers, so deleting messages also scrubs the FTS index.
  db.exec("DELETE FROM messages");
  db.exec("DELETE FROM sessions");
});

function seedSession(key: string, scope = "workspace", source = "cli"): number {
  return upsertSession(db, { key, scope, source, workspace: "/tmp/p" }).id;
}

describe("appendMessage", () => {
  test("inserts and returns a positive id", () => {
    const sid = seedSession("s1");
    const id = appendMessage(db, { sessionId: sid, role: "user", content: "hello" });
    expect(id).toBeGreaterThan(0);
  });

  test("defaults ts to now() if not provided", () => {
    const sid = seedSession("s-ts");
    const before = Date.now();
    appendMessage(db, { sessionId: sid, role: "user", content: "x" });
    const after = Date.now();

    const [row] = listForSession(db, sid);
    const rowMs = Date.parse(row.ts);
    // Allow 1s slack either side for clock drift.
    expect(rowMs).toBeGreaterThanOrEqual(before - 1000);
    expect(rowMs).toBeLessThanOrEqual(after + 1000);
  });

  test("honours explicit ts when given", () => {
    const sid = seedSession("s-ts2");
    appendMessage(db, { sessionId: sid, role: "user", content: "x", ts: "2020-05-05T05:05:05.000Z" });
    const [row] = listForSession(db, sid);
    expect(row.ts).toBe("2020-05-05T05:05:05.000Z");
  });

  test("stores undefined toolCalls/attachments as NULL, otherwise as JSON", () => {
    const sid = seedSession("s-tool");
    appendMessage(db, { sessionId: sid, role: "assistant", content: "empty" });
    appendMessage(db, {
      sessionId: sid,
      role: "assistant",
      content: "with tools",
      toolCalls: [{ name: "bash", args: { cmd: "ls" } }],
      attachments: [{ path: "/tmp/x.png" }],
    });

    const rows = listForSession(db, sid);
    expect(rows[0].tool_calls_json).toBeNull();
    expect(rows[0].attachments_json).toBeNull();
    expect(JSON.parse(rows[1].tool_calls_json ?? "[]")).toEqual([{ name: "bash", args: { cmd: "ls" } }]);
    expect(JSON.parse(rows[1].attachments_json ?? "[]")).toEqual([{ path: "/tmp/x.png" }]);
  });
});

describe("listForSession", () => {
  test("returns empty array for unknown session", () => {
    expect(listForSession(db, 99_999)).toEqual([]);
  });

  test("returns messages in ts ASC order, scoped to session", () => {
    const a = seedSession("a");
    const b = seedSession("b");
    appendMessage(db, { sessionId: a, role: "user", content: "a1", ts: "2024-01-01T00:00:00.000Z" });
    appendMessage(db, { sessionId: a, role: "assistant", content: "a2", ts: "2024-01-02T00:00:00.000Z" });
    appendMessage(db, { sessionId: b, role: "user", content: "b1", ts: "2024-01-01T00:00:00.000Z" });

    const aRows = listForSession(db, a);
    expect(aRows.map((r) => r.content)).toEqual(["a1", "a2"]);
    const bRows = listForSession(db, b);
    expect(bRows.map((r) => r.content)).toEqual(["b1"]);
  });

  test("honours the limit argument", () => {
    const sid = seedSession("lim");
    for (let i = 0; i < 5; i++) {
      appendMessage(db, {
        sessionId: sid,
        role: "user",
        content: `m${i}`,
        ts: `2024-01-0${i + 1}T00:00:00.000Z`,
      });
    }
    const limited = listForSession(db, sid, 2);
    expect(limited.length).toBe(2);
    expect(limited.map((r) => r.content)).toEqual(["m0", "m1"]);
  });
});

describe("FTS5 triggers + search", () => {
  test("inserted messages become findable via MATCH (messages_ai trigger)", () => {
    const sid = seedSession("fts");
    appendMessage(db, { sessionId: sid, role: "user", content: "deploy the gateway now" });
    appendMessage(db, { sessionId: sid, role: "assistant", content: "unrelated chatter" });

    const hits = search(db, "gateway");
    expect(hits.length).toBe(1);
    expect(hits[0].sessionKey).toBe("fts");
    expect(hits[0].snippet).toContain("[gateway]");
  });

  test("deleted messages drop out of FTS (messages_ad trigger)", () => {
    const sid = seedSession("fts-del");
    appendMessage(db, { sessionId: sid, role: "user", content: "keywordunique" });
    expect(search(db, "keywordunique").length).toBe(1);

    db.prepare("DELETE FROM messages WHERE session_id = ?").run(sid);
    expect(search(db, "keywordunique").length).toBe(0);
  });

  test("updated content replaces FTS entry (messages_au trigger)", () => {
    const sid = seedSession("fts-upd");
    appendMessage(db, { sessionId: sid, role: "user", content: "originaltokenabc" });
    expect(search(db, "originaltokenabc").length).toBe(1);

    const row = listForSession(db, sid)[0];
    db.prepare("UPDATE messages SET content = ? WHERE id = ?").run("updatedtokendef", row.id);

    expect(search(db, "originaltokenabc").length).toBe(0);
    expect(search(db, "updatedtokendef").length).toBe(1);
  });

  test("results ordered by messages.ts DESC", () => {
    const sid = seedSession("ord");
    appendMessage(db, { sessionId: sid, role: "user", content: "banana", ts: "2024-01-01T00:00:00.000Z" });
    appendMessage(db, { sessionId: sid, role: "user", content: "banana", ts: "2024-06-01T00:00:00.000Z" });
    appendMessage(db, { sessionId: sid, role: "user", content: "banana", ts: "2024-12-01T00:00:00.000Z" });

    const hits = search(db, "banana");
    expect(hits.length).toBe(3);
    expect(hits[0].ts).toBe("2024-12-01T00:00:00.000Z");
    expect(hits[2].ts).toBe("2024-01-01T00:00:00.000Z");
  });

  test("scope filter restricts hits to matching sessions", () => {
    const ws = upsertSession(db, {
      key: "ws-s",
      scope: "workspace",
      source: "cli",
      workspace: "/tmp/p",
    });
    const dm = upsertSession(db, {
      key: "dm-s",
      scope: "per-user",
      source: "telegram",
      workspace: "/tmp/p",
    });
    appendMessage(db, { sessionId: ws.id, role: "user", content: "scopekeyword" });
    appendMessage(db, { sessionId: dm.id, role: "user", content: "scopekeyword" });

    const wsHits = search(db, "scopekeyword", { scope: "workspace" });
    expect(wsHits.length).toBe(1);
    expect(wsHits[0].sessionKey).toBe("ws-s");

    const dmHits = search(db, "scopekeyword", { scope: "per-user" });
    expect(dmHits.length).toBe(1);
    expect(dmHits[0].sessionKey).toBe("dm-s");
  });

  test("source filter restricts hits to matching sessions", () => {
    const cli = upsertSession(db, {
      key: "cli-s",
      scope: "workspace",
      source: "cli",
      workspace: "/tmp/p",
    });
    const tg = upsertSession(db, {
      key: "tg-s",
      scope: "workspace",
      source: "telegram",
      workspace: "/tmp/p",
    });
    appendMessage(db, { sessionId: cli.id, role: "user", content: "sourcekeyword" });
    appendMessage(db, { sessionId: tg.id, role: "user", content: "sourcekeyword" });

    const cliHits = search(db, "sourcekeyword", { source: "cli" });
    expect(cliHits.length).toBe(1);
    expect(cliHits[0].sessionKey).toBe("cli-s");
  });

  test("honours the limit parameter (default 20)", () => {
    const sid = seedSession("lim");
    for (let i = 0; i < 5; i++) {
      appendMessage(db, {
        sessionId: sid,
        role: "user",
        content: `tokenxyz message ${i}`,
        ts: `2024-01-0${i + 1}T00:00:00.000Z`,
      });
    }
    const hits = search(db, "tokenxyz", { limit: 2 });
    expect(hits.length).toBe(2);
  });

  test("query with no matches returns []", () => {
    const sid = seedSession("nomatch");
    appendMessage(db, { sessionId: sid, role: "user", content: "present" });
    expect(search(db, "absentword")).toEqual([]);
  });

  test("FTS query supports prefix matching via *", () => {
    const sid = seedSession("prefix");
    appendMessage(db, { sessionId: sid, role: "user", content: "summarisation pipeline running" });
    const hits = search(db, "summari*");
    expect(hits.length).toBe(1);
  });

  test("multi-token MATCH query is AND-combined in FTS5", () => {
    const sid = seedSession("multi");
    appendMessage(db, { sessionId: sid, role: "user", content: "alpha beta gamma" });
    appendMessage(db, { sessionId: sid, role: "user", content: "alpha only" });
    const both = search(db, "alpha beta");
    expect(both.length).toBe(1);
    expect(both[0].snippet).toContain("[alpha]");
  });

  test("ON DELETE CASCADE from sessions also removes messages + FTS entries", () => {
    const sid = seedSession("del-session");
    appendMessage(db, { sessionId: sid, role: "user", content: "cascadetargetword" });
    expect(search(db, "cascadetargetword").length).toBe(1);

    db.prepare("DELETE FROM sessions WHERE id = ?").run(sid);
    expect(search(db, "cascadetargetword").length).toBe(0);
    expect(listForSession(db, sid)).toEqual([]);
  });
});
