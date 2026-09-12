import { afterEach, beforeEach, expect, test } from "bun:test";
import { applyMigrations, closeDb, openDb, type Database } from "../state";
import { appendMessage } from "../state/repos/messages";
import { insertMemory } from "../state/repos/memory";
import { upsertSession } from "../state/repos/sessions";
import { buildRuntimeMemoryDigest } from "./runtime-digest";

let db: Database;
beforeEach(async () => {
  db = openDb({ path: ":memory:" });
  await applyMigrations(db);
});
afterEach(() => closeDb(db));

const target = {
  key: "user:telegram:alice",
  scope: "per-user",
  source: "telegram",
  workspace: "/test",
  user: "alice",
  memoryScope: "user" as const,
} as const;

function session(key: string = target.key, user = "alice") {
  return upsertSession(db, { ...target, key, user, claudeSessionId: key });
}

test("proactive recall retrieves relevant old context beyond the recent-message window", () => {
  const row = session();
  appendMessage(db, {
    sessionId: row.id,
    content: "Orion deployment uses port 8123",
    role: "user",
    ts: "2025-01-01",
  });
  for (let i = 0; i < 8; i++) {
    appendMessage(db, {
      sessionId: row.id,
      content: `Unrelated lunch ${i}`,
      role: "user",
      ts: `2026-01-0${i + 1}`,
    });
  }
  const options = { target, query: "What port does Orion use?", messagesPerSession: 2 };
  const digest = buildRuntimeMemoryDigest(db, options);
  expect(digest).toContain("8123");
  expect(digest).toContain("Relevant conversation context");
  expect(buildRuntimeMemoryDigest(db, options)).toBe(digest);
});

test("scoped recall excludes other users, channels, sources and unattributed personal facts", () => {
  const own = session();
  const other = session("user:telegram:bob", "bob");
  appendMessage(db, { sessionId: own.id, role: "user", content: "Orion public plan" });
  appendMessage(db, { sessionId: other.id, role: "user", content: "Orion bob-private" });
  insertMemory(db, { scope: "user", key: "private", value: "bob-fact", sourceSessionId: other.id });
  insertMemory(db, { scope: "user", key: "unknown", value: "unattributed-secret" });
  insertMemory(db, { scope: "user", key: "mine", value: "alice-fact", sourceSessionId: own.id });
  const digest = buildRuntimeMemoryDigest(db, { target, query: "Orion" });
  expect(digest).toContain("alice-fact");
  expect(digest).not.toContain("bob-private");
  expect(digest).not.toContain("bob-fact");
  expect(digest).not.toContain("unattributed-secret");
});

test("none disables the entire state digest", () => {
  const row = session();
  appendMessage(db, { sessionId: row.id, role: "user", content: "remember this" });
  expect(buildRuntimeMemoryDigest(db, { target: { ...target, memoryScope: "none" } })).toBe("");
});

test("a newer expired fact does not resurrect a superseded value", () => {
  const row = session();
  insertMemory(db, { scope: "user", key: "port", value: "obsolete-port", sourceSessionId: row.id });
  insertMemory(db, {
    scope: "user",
    key: "port",
    value: "expired-port",
    sourceSessionId: row.id,
    expiresAt: "2020-01-01",
  });
  expect(buildRuntimeMemoryDigest(db, { target })).not.toContain("obsolete-port");
});

test("natural-language punctuation and CJK queries are safe and the digest is budgeted", () => {
  const row = session();
  appendMessage(db, { sessionId: row.id, role: "user", content: "部署端口是8123。".repeat(500) });
  const digest = buildRuntimeMemoryDigest(db, { target, query: '部署端口 " OR (* NEAR(', maxChars: 600 });
  expect(digest.length).toBeLessThanOrEqual(600);
  expect(digest).toContain("部署端口");
  expect(digest.endsWith("</state-digest>")).toBe(true);
});
