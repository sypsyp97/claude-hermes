import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { applyMigrations, closeDb, openDb, type Database } from "../state";
import { appendMessage } from "../state/repos/messages";
import { insertMemory } from "../state/repos/memory";
import { upsertSession } from "../state/repos/sessions";
import { buildRuntimeMemoryDigest } from "./runtime-digest";

let db: Database;

beforeAll(async () => {
  db = openDb({ path: ":memory:" });
  await applyMigrations(db);
});

afterAll(() => {
  closeDb(db);
});

describe("buildRuntimeMemoryDigest", () => {
  test("renders recent durable facts and persisted conversation context", () => {
    db.exec("DELETE FROM messages");
    db.exec("DELETE FROM memory_entries");
    db.exec("DELETE FROM sessions");

    const prior = upsertSession(db, {
      key: "workspace:runtime-digest",
      scope: "workspace",
      source: "cli",
      workspace: "/tmp/runtime-digest",
      claudeSessionId: "runtime-digest-session",
    });
    appendMessage(db, {
      sessionId: prior.id,
      ts: "2024-01-01T00:00:00.000Z",
      role: "user",
      content: "Remember to inspect persisted memory first.",
    });
    appendMessage(db, {
      sessionId: prior.id,
      ts: "2024-01-01T00:00:01.000Z",
      role: "assistant",
      content: "state.db keeps the recent conversation history.",
    });
    insertMemory(db, {
      scope: "workspace",
      key: "memory-policy",
      value: "Inspect persisted memory on fresh sessions.",
      sourceSessionId: prior.id,
    });

    const digest = buildRuntimeMemoryDigest(db, { now: "2024-01-01T01:00:00.000Z" });

    expect(digest).toContain("<state-digest>");
    expect(digest).toContain("Recent durable facts:");
    expect(digest).toContain("- workspace.memory-policy = Inspect persisted memory on fresh sessions.");
    expect(digest).toContain("Recent persisted conversation context:");
    expect(digest).toContain("- workspace:runtime-digest [cli/workspace]");
    expect(digest).toContain("  user: Remember to inspect persisted memory first.");
    expect(digest).toContain("  assistant: state.db keeps the recent conversation history.");
    expect(digest).toContain("</state-digest>");
    expect(digest).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("excludes channel-scoped durable facts from the workspace digest", () => {
    db.exec("DELETE FROM messages");
    db.exec("DELETE FROM memory_entries");
    db.exec("DELETE FROM sessions");

    insertMemory(db, {
      scope: "channel",
      key: "channel-secret",
      value: "Only for one channel.",
    });
    insertMemory(db, {
      scope: "user",
      key: "user-preference",
      value: "Use tools proactively.",
    });

    const digest = buildRuntimeMemoryDigest(db, { now: "2024-01-01T01:00:00.000Z" });

    expect(digest).toContain("- user.user-preference = Use tools proactively.");
    expect(digest).not.toContain("channel-secret");
    expect(digest).not.toContain("Only for one channel.");
  });
});
