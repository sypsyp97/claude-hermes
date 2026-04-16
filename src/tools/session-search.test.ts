import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { applyMigrations, closeDb, type Database, openDb } from "../state";
import { appendMessage } from "../state/repos/messages";
import { upsertSession } from "../state/repos/sessions";
import { invokeSessionSearch, sessionSearchTool } from "./session-search";

let db: Database;

beforeAll(async () => {
  db = openDb({ path: ":memory:" });
  await applyMigrations(db);
});

afterAll(() => {
  closeDb(db);
});

beforeEach(() => {
  db.exec("DELETE FROM messages");
  db.exec("DELETE FROM sessions");
});

function seedSession(key: string, scope = "workspace", source = "cli"): number {
  return upsertSession(db, { key, scope, source, workspace: "/tmp/p" }).id;
}

describe("sessionSearchTool descriptor", () => {
  test("names and describes the tool for the LLM", () => {
    expect(sessionSearchTool.name).toBe("session_search");
    expect(typeof sessionSearchTool.description).toBe("string");
    expect(sessionSearchTool.description.length).toBeGreaterThan(10);
  });

  test("input schema requires a query and documents optional fields", () => {
    expect(sessionSearchTool.inputSchema.type).toBe("object");
    expect(sessionSearchTool.inputSchema.required).toEqual(["query"]);
    const props = sessionSearchTool.inputSchema.properties;
    expect(props.query.type).toBe("string");
    expect(props.scope.type).toBe("string");
    expect(props.source.type).toBe("string");
    expect(props.limit.type).toBe("number");
  });
});

describe("invokeSessionSearch", () => {
  test("returns [] for empty / whitespace-only query (no DB hit)", () => {
    const sid = seedSession("s");
    appendMessage(db, { sessionId: sid, role: "user", content: "hello world" });

    expect(invokeSessionSearch(db, { query: "" })).toEqual([]);
    expect(invokeSessionSearch(db, { query: "   " })).toEqual([]);
    expect(invokeSessionSearch(db, { query: "\t\n" })).toEqual([]);
  });

  test("returns shaped search hits for a matching term", () => {
    const sid = seedSession("shape");
    appendMessage(db, { sessionId: sid, role: "user", content: "deploy gateway tomorrow" });

    const hits = invokeSessionSearch(db, { query: "gateway" });
    expect(hits.length).toBe(1);
    const hit = hits[0];
    expect(hit.sessionKey).toBe("shape");
    expect(hit.role).toBe("user");
    expect(hit.snippet).toContain("[gateway]");
    expect(typeof hit.messageId).toBe("number");
    expect(typeof hit.sessionId).toBe("number");
    expect(typeof hit.ts).toBe("string");
  });

  test("passes scope filter through to FTS search", () => {
    const ws = upsertSession(db, {
      key: "ws",
      scope: "workspace",
      source: "cli",
      workspace: "/tmp/p",
    });
    const dm = upsertSession(db, {
      key: "dm",
      scope: "per-user",
      source: "telegram",
      workspace: "/tmp/p",
    });
    appendMessage(db, { sessionId: ws.id, role: "user", content: "scopetoken" });
    appendMessage(db, { sessionId: dm.id, role: "user", content: "scopetoken" });

    const wsHits = invokeSessionSearch(db, { query: "scopetoken", scope: "workspace" });
    expect(wsHits.length).toBe(1);
    expect(wsHits[0].sessionKey).toBe("ws");
  });

  test("passes source filter through", () => {
    const a = upsertSession(db, {
      key: "a",
      scope: "workspace",
      source: "cli",
      workspace: "/tmp/p",
    });
    const b = upsertSession(db, {
      key: "b",
      scope: "workspace",
      source: "discord",
      workspace: "/tmp/p",
    });
    appendMessage(db, { sessionId: a.id, role: "user", content: "sourcetoken" });
    appendMessage(db, { sessionId: b.id, role: "user", content: "sourcetoken" });

    const discord = invokeSessionSearch(db, { query: "sourcetoken", source: "discord" });
    expect(discord.length).toBe(1);
    expect(discord[0].sessionKey).toBe("b");
  });

  test("respects limit", () => {
    const sid = seedSession("lim");
    for (let i = 0; i < 6; i++) {
      appendMessage(db, {
        sessionId: sid,
        role: "user",
        content: `limittoken message ${i}`,
        ts: `2024-01-0${i + 1}T00:00:00.000Z`,
      });
    }
    const hits = invokeSessionSearch(db, { query: "limittoken", limit: 3 });
    expect(hits.length).toBe(3);
  });

  test("returns [] when query has no matches", () => {
    const sid = seedSession("nope");
    appendMessage(db, { sessionId: sid, role: "user", content: "something" });
    expect(invokeSessionSearch(db, { query: "nonexistentword" })).toEqual([]);
  });

  test("combines scope and source filters simultaneously", () => {
    const good = upsertSession(db, {
      key: "good",
      scope: "workspace",
      source: "cli",
      workspace: "/tmp/p",
    });
    const wrongScope = upsertSession(db, {
      key: "wrongscope",
      scope: "per-user",
      source: "cli",
      workspace: "/tmp/p",
    });
    const wrongSource = upsertSession(db, {
      key: "wrongsource",
      scope: "workspace",
      source: "telegram",
      workspace: "/tmp/p",
    });
    appendMessage(db, { sessionId: good.id, role: "user", content: "combotoken" });
    appendMessage(db, { sessionId: wrongScope.id, role: "user", content: "combotoken" });
    appendMessage(db, { sessionId: wrongSource.id, role: "user", content: "combotoken" });

    const hits = invokeSessionSearch(db, {
      query: "combotoken",
      scope: "workspace",
      source: "cli",
    });
    expect(hits.length).toBe(1);
    expect(hits[0].sessionKey).toBe("good");
  });
});
