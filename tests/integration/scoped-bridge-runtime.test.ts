import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUserMessage, resetCurrentSession, compactCurrentSession } from "../../src/runner";
import { telegramSessionTarget } from "../../src/router/bridge-session";
import { sessionAccess } from "../../src/runtime/session-target";
import { getSharedDb, resetSharedDbCache } from "../../src/state/shared-db";
import { appendMessage } from "../../src/state/repos/messages";
import { getByKey } from "../../src/state/repos/sessions";
import { reloadSettings } from "../../src/config";

import { handleMessage as handleTelegramMessage } from "../../src/commands/telegram";
import {
  handleMessageCreate,
  handleInteractionCreate,
  handleDispatch,
  stopGateway,
} from "../../src/commands/discord";
import { upsertPolicy } from "../../src/state/repos/policies";
import { createThreadSession, peekThreadSession, removeThreadSession } from "../../src/sessionManager";
import { insertMemory } from "../../src/state/repos/memory";
const originalFetch = globalThis.fetch;
const originalCwd = process.cwd();
const originalEnv = { ...process.env };
let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "hermes-scoped-runtime-"));
  await mkdir(join(cwd, ".claude/hermes"), { recursive: true });
  await writeFile(
    join(cwd, ".claude/hermes/settings.json"),
    JSON.stringify({
      agentic: { enabled: false },
      learning: { captureCandidateSkills: false },
      telegram: { token: "fake", allowedUserIds: [1, 2] },
      discord: { token: "fake", allowedUserIds: ["a", "b"] },
    })
  );
  process.chdir(cwd);
  process.env.HERMES_CLAUDE_BIN = `bun run ${join(originalCwd, "tests/fixtures/fake-claude.ts")}`;
  process.env.HERMES_FAKE_SESSION_ID = "scoped-session";
  await reloadSettings();
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  stopGateway();
  await resetSharedDbCache();
  process.chdir(originalCwd);
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  await rm(cwd, { recursive: true, force: true });
});

function target(userId = 1) {
  return telegramSessionTarget({ workspace: cwd, chatId: userId, userId, isDm: true });
}

test("Discord archival preserves a thread context for later unarchival", async () => {
  await createThreadSession("discord", "thread", "existing");
  handleDispatch("fake", "THREAD_UPDATE", {
    id: "thread",
    parent_id: "channel",
    thread_metadata: { archived: true },
  });
  await Bun.sleep(10);
  expect((await peekThreadSession("discord", "thread"))?.sessionId).toBe("existing");
});

test("deleting a thread never converts attributed facts into shared workspace facts", async () => {
  await createThreadSession("discord", "thread", "existing");
  const db = await getSharedDb();
  insertMemory(db, {
    scope: "workspace",
    key: "private",
    value: "secret",
    sourceSessionId: getByKey(db, "thread:discord:thread")!.id,
  });
  await removeThreadSession("discord", "thread");
  expect(db.query("SELECT * FROM memory_entries WHERE key = 'private'").all()).toHaveLength(0);
});

test("a timed-out resumed task is not automatically replayed or compacted", async () => {
  const mine = target();
  await sessionAccess(mine).create("existing");
  const script = join(cwd, "timeout-claude.ts");
  const calls = join(cwd, "calls.txt");
  await writeFile(
    script,
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(calls)}, "called\\n");
process.exit(process.argv.includes("/compact") ? 0 : 124);`
  );
  process.env.HERMES_CLAUDE_BIN = `bun run ${script}`;
  const result = await runUserMessage("telegram", "perform side effect", mine, undefined, "telegram");
  expect(result.exitCode).toBe(124);
  expect(await readFile(calls, "utf8")).toBe("called\n");
  expect((await sessionAccess(mine).peek())?.sessionId).toBe("existing");
});

test("resumed buffered turns keep structured errors and do not persist false success", async () => {
  const mine = target();
  await sessionAccess(mine).create("existing");
  const script = join(cwd, "error-claude.ts");
  await writeFile(
    script,
    `const args = process.argv;
const format = args[args.indexOf("--output-format") + 1];
console.log(format === "json"
  ? JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, errors: ["Turn budget exhausted"], session_id: "existing" })
  : "Turn budget exhausted");`
  );
  process.env.HERMES_CLAUDE_BIN = `bun run ${script}`;
  const result = await runUserMessage("telegram", "work", mine, undefined, "telegram");
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Turn budget exhausted");
  const db = await getSharedDb();
  expect(db.query("SELECT * FROM messages").all()).toHaveLength(0);
});

test("real runner persists canonical metadata and actively recalls only the addressed conversation", async () => {
  const mine = target();
  const other = target(2);
  await sessionAccess(mine).create("mine");
  await sessionAccess(other).create("other");
  const db = await getSharedDb();
  appendMessage(db, {
    sessionId: getByKey(db, mine.key)!.id,
    role: "user",
    content: "Orion uses port 8123",
    ts: "2020",
  });
  appendMessage(db, {
    sessionId: getByKey(db, other.key)!.id,
    role: "user",
    content: "Orion secret from another user",
  });
  for (let i = 0; i < 8; i++)
    appendMessage(db, { sessionId: getByKey(db, mine.key)!.id, role: "user", content: `lunch ${i}` });
  process.env.HERMES_FAKE_ECHO_APPEND_SYSTEM_PROMPT = "1";
  const result = await runUserMessage("telegram", "Orion port?", mine, undefined, "telegram");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("8123");
  expect(result.stdout).not.toContain("secret from another user");
  expect(getByKey(db, mine.key)?.turn_count).toBe(1);
  expect(db.query("SELECT key FROM sessions WHERE key LIKE '%[object%'").all()).toHaveLength(0);
});

test("queued reset follows the running turn, targets one lane and allows a fresh session", async () => {
  const mine = target();
  const other = target(2);
  await sessionAccess(other).create("untouched");
  process.env.HERMES_FAKE_DELAY_MS = "20";
  const turn = runUserMessage("telegram", "hello", mine, undefined, "telegram");
  const reset = resetCurrentSession({ target: mine });
  await Promise.all([turn, reset]);
  expect(await sessionAccess(mine).peek()).toBeNull();
  expect((await sessionAccess(other).peek())?.sessionId).toBe("untouched");
  expect((await compactCurrentSession({ target: mine })).success).toBe(false);
  await runUserMessage("telegram", "again", mine, undefined, "telegram");
  expect((await sessionAccess(mine).peek())?.sessionId).toBe("scoped-session");
});

test("Telegram production handlers isolate private chats and forum topics; reset addresses the same lane", async () => {
  globalThis.fetch = (async () =>
    Response.json({ ok: true, result: { message_id: 1 } })) as unknown as typeof fetch;
  const message = {
    message_id: 1,
    from: { id: 1, first_name: "Alice" },
    chat: { id: 1, type: "private" },
    text: "hello",
  };
  await handleTelegramMessage(message);
  await handleTelegramMessage({
    ...message,
    from: { id: 2, first_name: "Bob" },
    chat: { id: 2, type: "private" },
  });
  const db = await getSharedDb();
  expect(getByKey(db, "user:telegram:1")?.user).toBe("1");
  expect(getByKey(db, "user:telegram:2")?.user).toBe("2");
  for (const chatId of [-1, -2])
    await handleTelegramMessage({
      ...message,
      chat: { id: chatId, type: "supergroup" },
      message_thread_id: 7,
      text: "@bot hello",
      entities: [{ type: "mention", offset: 0, length: 4 }],
    });
  expect(getByKey(db, "thread:telegram:-1:7")).not.toBeNull();
  expect(getByKey(db, "thread:telegram:-2:7")).not.toBeNull();
  await handleTelegramMessage({ ...message, text: "/reset" });
  expect(getByKey(db, "user:telegram:1")?.claude_session_id).toBeNull();
  expect(getByKey(db, "user:telegram:2")?.claude_session_id).toBe("scoped-session");
});

test("Discord production handlers enforce live channel policy and isolate slash reset", async () => {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (init?.method === "GET") return Response.json({ name: "listen-work", type: 0 });
    return Response.json({ id: "sent" });
  }) as unknown as typeof fetch;
  const message = {
    id: "m1",
    channel_id: "c",
    guild_id: "g",
    author: { id: "a", username: "Alice", discriminator: "0" },
    content: "hello",
    attachments: [],
    mentions: [],
    type: 0,
  };
  await handleMessageCreate("fake", message);
  await handleMessageCreate("fake", {
    ...message,
    id: "m2",
    author: { id: "b", username: "Bob", discriminator: "0" },
  });
  const db = await getSharedDb();
  expect(getByKey(db, "channel-user:discord:g:c:a")?.channel).toBe("c");
  expect(getByKey(db, "channel-user:discord:g:c:b")?.user).toBe("b");
  await handleInteractionCreate("fake", {
    id: "i",
    type: 2,
    channel_id: "c",
    guild_id: "g",
    token: "fake",
    member: { user: message.author },
    data: { name: "reset" },
  });
  expect(getByKey(db, "channel-user:discord:g:c:a")?.claude_session_id).toBeNull();
  expect(getByKey(db, "channel-user:discord:g:c:b")?.claude_session_id).toBe("scoped-session");
  const before = db.query("SELECT count(*) AS n FROM messages").get();
  upsertPolicy(
    db,
    { source: "discord", guild: "g", channel: "c" },
    { mode: "delivery-only", deliveryRole: "delivery" }
  );
  await handleMessageCreate("fake", message);
  expect(db.query("SELECT count(*) AS n FROM messages").get()).toEqual(before);
});

test("Discord acknowledges reset before waiting for the running conversation", async () => {
  const { discordSessionTarget } = await import("../../src/router/bridge-session");
  const { defaultPolicy } = await import("../../src/policy/channel");
  const mine = discordSessionTarget(
    { workspace: cwd, channelId: "c", guildId: "g", userId: "a" },
    defaultPolicy({ source: "discord" })
  );
  let acknowledged = false;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (String(input).endsWith("/callback")) acknowledged = true;
    return init?.method === "GET" ? Response.json({ name: "c", type: 0 }) : Response.json({ id: "sent" });
  }) as unknown as typeof fetch;
  process.env.HERMES_FAKE_DELAY_MS = "300";
  const turn = runUserMessage("discord", "hello", mine, undefined, "discord");
  const reset = handleInteractionCreate("fake", {
    id: "reset",
    type: 2,
    application_id: "app",
    channel_id: "c",
    guild_id: "g",
    token: "fake",
    member: { user: { id: "a", username: "a", discriminator: "0" } },
    data: { name: "reset" },
  });
  await Bun.sleep(100);
  const ackBeforeCompletion = acknowledged;
  await Promise.all([turn, reset]);
  expect(ackBeforeCompletion).toBe(true);
  expect(await sessionAccess(mine).peek()).toBeNull();
});
