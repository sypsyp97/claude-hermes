import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSharedDbCache } from "../state/shared-db";
import { sessionAccess, type SessionTarget } from "./session-target";

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "hermes-target-"));
});
afterEach(async () => {
  await resetSharedDbCache();
  await rm(cwd, { recursive: true, force: true });
});

test("canonical targets retain source, channel and owner metadata without a second thread prefix", async () => {
  const target: SessionTarget = {
    key: "user:telegram:alice",
    scope: "per-user",
    source: "telegram",
    workspace: cwd,
    user: "alice",
    memoryScope: "user",
  };
  const access = sessionAccess(target, "telegram");
  await access.create("session-a");
  expect((await access.peek())?.sessionId).toBe("session-a");
  expect(await access.increment()).toBe(1);
  const { getSharedDb } = await import("../state/shared-db");
  const db = await getSharedDb(cwd);
  expect(db.query("SELECT key, user, source FROM sessions").all()).toEqual([
    { key: target.key, user: "alice", source: "telegram" },
  ]);
});

test("reset clears only the addressed session and preserves durable conversation history", async () => {
  const target: SessionTarget = {
    key: "user:discord:alice",
    scope: "per-user",
    source: "discord",
    workspace: cwd,
    user: "alice",
    memoryScope: "user",
  };
  const a = sessionAccess(target, "discord");
  const b = sessionAccess({ ...target, key: "user:discord:bob", user: "bob" }, "discord");
  await a.create("a");
  await b.create("b");
  const { getSharedDb } = await import("../state/shared-db");
  const db = await getSharedDb(cwd);
  db.exec(
    "INSERT INTO messages(session_id, ts, role, content) SELECT id, '2026', 'user', 'remember me' FROM sessions WHERE user = 'alice'"
  );
  await a.reset();
  expect(await a.peek()).toBeNull();
  expect((await b.peek())?.sessionId).toBe("b");
  expect(db.query("SELECT content FROM messages").all()).toEqual([{ content: "remember me" }]);
});

test("native Claude memory is stable within a conversation and isolated across conversations", async () => {
  const { claudeSessionArgs } = await import("./session-target");
  const target: SessionTarget = {
    key: "user:telegram:alice",
    scope: "per-user",
    source: "telegram",
    workspace: cwd,
    user: "alice",
    memoryScope: "user",
  };
  const args = claudeSessionArgs(target);
  const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
  expect(settings.autoMemoryDirectory.startsWith(cwd)).toBe(true);
  expect(claudeSessionArgs(target)).toEqual(args);
  expect(claudeSessionArgs({ ...target, key: "user:telegram:bob" })).not.toEqual(args);
  const noneArgs = claudeSessionArgs({ ...target, memoryScope: "none" });
  expect(JSON.parse(noneArgs[noneArgs.indexOf("--settings") + 1]).autoMemoryEnabled).toBe(false);
  expect(args).toContain("--system-prompt-snapshot");
});
