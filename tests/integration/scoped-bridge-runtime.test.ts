import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runUserMessage,
  resetCurrentSession,
  compactCurrentSession,
  deleteThreadSession,
} from "../../src/runner";
import { telegramSessionTarget, discordSessionTarget } from "../../src/router/bridge-session";
import { defaultPolicy } from "../../src/policy/channel";
import { nativeMemoryDirectory } from "../../src/paths";
import { enqueueBridge } from "../../src/runtime/bridge-queue";
import { sessionAccess, claudeSessionArgs } from "../../src/runtime/session-target";
import { getSharedDb, resetSharedDbCache } from "../../src/state/shared-db";
import { appendMessage } from "../../src/state/repos/messages";
import { getByKey } from "../../src/state/repos/sessions";
import { reloadSettings } from "../../src/config";
import { withBridgeSignal } from "../../src/runtime/bridge-context";
import { createFakeSink } from "../../src/status/sink";

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

test("recall uses human text before clock, bridge and skill context consume query terms", async () => {
  const mine = target();
  await sessionAccess(mine).create("existing");
  const db = await getSharedDb();
  const sessionId = getByKey(db, mine.key)!.id;
  appendMessage(db, { sessionId, role: "user", content: "Orion uses port 8123", ts: "2020" });
  for (let i = 0; i < 8; i++) appendMessage(db, { sessionId, role: "user", content: `lunch ${i}` });
  const text = "Could you kindly help me recall exactly which configuration we previously chose for Orion?";
  process.env.HERMES_FAKE_ECHO_APPEND_SYSTEM_PROMPT = "1";
  const result = await runUserMessage(
    "telegram",
    { text, context: `[Telegram from Alice]\nMessage: ${text}` },
    mine,
    undefined,
    "telegram"
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("8123");
});

test.each(["creation", "attachment"] as const)(
  "Telegram topic forget cannot overtake first-turn %s",
  async (phase) => {
    const db = await getSharedDb();
    upsertPolicy(db, { source: "telegram", channel: "-60" }, { mode: "listen", autoThread: true });
    let started!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((r) => {
      started = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).endsWith("/createForumTopic")) {
        if (phase === "creation") {
          started();
          await gate;
        }
        return Response.json({ ok: true, result: { message_thread_id: 81 } });
      }
      if (String(url).endsWith("/getFile")) {
        if (phase === "attachment") {
          started();
          await gate;
        }
        return Response.json({ ok: true, result: { file_path: "image.jpg" } });
      }
      if (String(url).includes("/file/bot")) return new Response(new Uint8Array([1, 2, 3]));
      return Response.json({ ok: true, result: { message_id: 1 } });
    }) as typeof fetch;
    const base = {
      message_id: 1,
      from: { id: 1, first_name: "Alice" },
      chat: { id: -60, type: "supergroup", is_forum: true },
    };
    const first = handleTelegramMessage({
      ...base,
      text: "remember that TOP_SECRET is 8123",
      photo: [{ file_id: "image", width: 1, height: 1 }],
    });
    await ready;
    const forget = handleTelegramMessage({ ...base, message_id: 2, message_thread_id: 81, text: "/forget" });
    await Promise.race([forget, Bun.sleep(50)]);
    release();
    await Promise.all([first, forget]);
    expect(getByKey(db, "thread:telegram:-60:81")).toBeNull();
    expect(db.query("SELECT * FROM memory_entries").all()).toEqual([]);
  }
);

test.each(["message", "skill"] as const)(
  "Discord autoThread %s reserves its lane before the REST response",
  async (kind) => {
    const db = await getSharedDb();
    upsertPolicy(
      db,
      { source: "discord", guild: "g", channel: "parent" },
      { mode: "listen", autoThread: true }
    );
    await mkdir(join(cwd, ".claude/skills/report"), { recursive: true });
    await writeFile(join(cwd, ".claude/skills/report/SKILL.md"), "Generate a report.");
    let started!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((r) => {
      started = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/threads")) {
        handleDispatch("fake", "THREAD_CREATE", { id: "m", type: 11, parent_id: "parent", guild_id: "g" });
        started();
        await gate;
        return Response.json({ id: "m", name: "work" });
      }
      if (init?.method === "GET") return Response.json({ name: "work", type: 0 });
      return Response.json({ id: "sent" });
    }) as typeof fetch;
    const user = { id: "a", username: "Alice", discriminator: "0" };
    const interaction = {
      id: "skill",
      type: 2,
      application_id: "app",
      token: "fake",
      channel_id: "parent",
      guild_id: "g",
      member: { user },
      data: { name: "report" },
    };
    const first =
      kind === "message"
        ? handleMessageCreate("fake", {
            id: "m",
            author: user,
            channel_id: "parent",
            guild_id: "g",
            content: "remember that TOP_SECRET is 8123",
            attachments: [],
            mentions: [],
            type: 0,
          })
        : handleInteractionCreate("fake", interaction);
    await ready;
    const forget = handleInteractionCreate("fake", {
      ...interaction,
      id: "forget",
      channel_id: "m",
      data: { name: "forget" },
    });
    await Promise.race([forget, Bun.sleep(50)]);
    release();
    await Promise.all([first, forget]);
    expect(getByKey(db, "thread:discord:m")).toBeNull();
    expect(db.query("SELECT * FROM memory_entries").all()).toEqual([]);
  }
);

test.each(["message", "skill"] as const)(
  "autoThread %s cannot recreate a thread deleted before its creation response",
  async (kind) => {
    const db = await getSharedDb();
    upsertPolicy(
      db,
      { source: "discord", guild: "g", channel: "parent" },
      { mode: "listen", autoThread: true }
    );
    await mkdir(join(cwd, ".claude/skills/report"), { recursive: true });
    await writeFile(
      join(cwd, ".claude/skills/report/SKILL.md"),
      "---\nname: report\ndescription: Report\n---\nWrite a report."
    );
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/threads")) {
        handleDispatch("fake", "THREAD_CREATE", {
          id: "deleted-auto",
          parent_id: "parent",
          type: 11,
          guild_id: "g",
        });
        handleDispatch("fake", "THREAD_DELETE", { id: "deleted-auto" });
        return Response.json({ id: "deleted-auto", name: "work" });
      }
      if (init?.method === "GET") return Response.json({ name: "work", type: 0 });
      return Response.json({ id: "sent" });
    }) as typeof fetch;
    const author = { id: "a", username: "Alice", discriminator: "0" };
    if (kind === "message")
      await handleMessageCreate("fake", {
        id: "m",
        channel_id: "parent",
        guild_id: "g",
        author,
        content: "remember that Orion uses port 8123",
        attachments: [],
        mentions: [],
        type: 0,
      });
    else
      await handleInteractionCreate("fake", {
        id: "i",
        type: 2,
        application_id: "app",
        token: "fake",
        channel_id: "parent",
        guild_id: "g",
        member: { user: author },
        data: { name: "report" },
      });
    await enqueueBridge("discord", "deleted-auto", async () => {});
    expect(getByKey(db, "thread:discord:deleted-auto")).toBeNull();
    expect(db.query("SELECT * FROM memory_entries").all()).toEqual([]);
  }
);

test("deleting a shared thread waits for its first admitted turn before removing it", async () => {
  const target = discordSessionTarget(
    { workspace: cwd, channelId: "new-thread", guildId: "g", userId: "a", isThread: true },
    { ...defaultPolicy({ source: "discord" }), sessionScope: "shared" }
  );
  const running = runUserMessage(
    "discord",
    "remember that deployment uses port 8123",
    target,
    undefined,
    "discord"
  );
  const deleting = deleteThreadSession("discord", "new-thread");
  expect((await running).exitCode).toBe(0);
  await deleting;
  const db = await getSharedDb();
  expect(getByKey(db, target.key)).toBeNull();
  expect(db.query("SELECT * FROM memory_entries").all()).toEqual([]);
});

test("thread deletion removes all thread-owned policy scopes and retains a cross-channel user session", async () => {
  const db = await getSharedDb();
  const targets = ["shared", "per-channel-user", "per-thread", "per-user"].map((scope) =>
    discordSessionTarget(
      { workspace: cwd, channelId: "deleted-thread", guildId: "g", userId: "a", isThread: true },
      {
        ...defaultPolicy({ source: "discord" }),
        sessionScope: scope as "shared" | "per-channel-user" | "per-thread" | "per-user",
      }
    )
  );
  for (const target of targets) {
    await sessionAccess(target).create("session");
    insertMemory(db, {
      scope: "workspace",
      key: target.key,
      value: "private",
      sourceSessionId: getByKey(db, target.key)!.id,
    });
    const native = nativeMemoryDirectory(cwd, target.key);
    await mkdir(native, { recursive: true });
    await writeFile(join(native, "MEMORY.md"), "private");
  }
  handleDispatch("fake", "THREAD_DELETE", { id: "deleted-thread" });
  await enqueueBridge("discord", "deleted-thread", async () => {});
  for (const target of targets) {
    const retained = target.scope === "per-user";
    expect(Boolean(getByKey(db, target.key))).toBe(retained);
    expect(await Bun.file(join(nativeMemoryDirectory(cwd, target.key), "MEMORY.md")).exists()).toBe(retained);
  }
  expect(db.query("SELECT key FROM memory_entries").all()).toEqual([{ key: targets[3].key }]);
});

test("buffered and streaming conversations share a bounded child execution budget", async () => {
  const log = join(cwd, "concurrent.log");
  const script = join(cwd, "concurrent-child.ts");
  await writeFile(
    script,
    `import {appendFileSync} from "node:fs"; appendFileSync(${JSON.stringify(log)},"start\\n"); await Bun.sleep(300); appendFileSync(${JSON.stringify(log)},"end\\n"); console.log(JSON.stringify({type:"result",subtype:"success",session_id:String(process.pid),result:"ok"}));`
  );
  process.env.HERMES_CLAUDE_BIN = `bun run ${script}`;
  await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      runUserMessage("telegram", "work", target(i + 1), i % 2 ? createFakeSink() : undefined, "telegram")
    )
  );
  let active = 0;
  let peak = 0;
  for (const event of (await readFile(log, "utf8")).trim().split("\n")) {
    active += event === "start" ? 1 : -1;
    peak = Math.max(peak, active);
  }
  expect(peak).toBeLessThanOrEqual(4);
  expect(peak).toBeGreaterThan(1);
  expect(active).toBe(0);
});

test("autoThread honors explicit shared scope consistently on creation and continuation", async () => {
  const db = await getSharedDb();
  upsertPolicy(
    db,
    { source: "telegram", channel: "-61" },
    { mode: "listen", autoThread: true, sessionScope: "shared" }
  );
  upsertPolicy(
    db,
    { source: "discord", guild: "g", channel: "shared-auto" },
    { mode: "listen", autoThread: true, sessionScope: "shared" }
  );
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/createForumTopic"))
      return Response.json({ ok: true, result: { message_thread_id: 82 } });
    if (String(url).endsWith("/threads")) return Response.json({ id: "shared-thread", name: "work" });
    if (init?.method === "GET") return Response.json({ name: "work", type: 0 });
    return Response.json({ ok: true, result: { message_id: 1 }, id: "sent" });
  }) as unknown as typeof fetch;
  const tg = {
    message_id: 1,
    from: { id: 1, first_name: "Alice" },
    chat: { id: -61, type: "supergroup", is_forum: true },
    text: "hello",
  };
  await handleTelegramMessage(tg);
  await handleTelegramMessage({ ...tg, message_id: 2, message_thread_id: 82, text: "continue" });
  const discord = {
    id: "first",
    channel_id: "shared-auto",
    guild_id: "g",
    author: { id: "a", username: "Alice", discriminator: "0" },
    content: "hello",
    attachments: [],
    mentions: [],
    type: 0,
  };
  await handleMessageCreate("fake", discord);
  await handleMessageCreate("fake", {
    ...discord,
    id: "next",
    channel_id: "shared-thread",
    content: "continue",
  });
  expect(db.query("SELECT key, turn_count FROM sessions ORDER BY source").all()).toEqual([
    { key: "shared:discord:g:shared-thread", turn_count: 1 },
    { key: "shared:telegram:_:-61", turn_count: 1 },
  ]);
});

test("autoThread preserves Discord hire/fire management on the parent channel", async () => {
  upsertPolicy(
    await getSharedDb(),
    { source: "discord", guild: "g", channel: "manage" },
    { mode: "listen", autoThread: true }
  );
  const requests: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    requests.push(`${init?.method} ${url}`);
    if (init?.method === "GET")
      return Response.json({ name: String(url).endsWith("named-thread") ? "Alice" : "work", type: 0 });
    if (String(url).endsWith("/threads")) return Response.json({ id: "named-thread", name: "Alice" });
    return Response.json({ id: "sent" });
  }) as unknown as typeof fetch;
  const message = {
    id: "hire",
    channel_id: "manage",
    guild_id: "g",
    author: { id: "a", username: "Alice", discriminator: "0" },
    content: "hire Alice",
    attachments: [],
    mentions: [],
    type: 0,
  };
  await handleMessageCreate("fake", message);
  await handleMessageCreate("fake", { ...message, id: "fire", content: "fire Alice" });
  expect(requests.some((path) => path.includes("/messages/hire/threads"))).toBe(false);
  expect(requests.some((path) => path.includes("DELETE") && path.endsWith("/channels/named-thread"))).toBe(
    true
  );
});

test("Discord skill interactions apply autoThread and deliver inside the thread", async () => {
  await mkdir(join(cwd, ".claude/skills/my-report"), { recursive: true });
  await writeFile(join(cwd, ".claude/skills/my-report/SKILL.md"), "Generate a report.");
  upsertPolicy(
    await getSharedDb(),
    { source: "discord", guild: "g", channel: "slash-auto" },
    { autoThread: true, allowedSkills: ["my-report"] }
  );
  const paths: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    paths.push(String(url));
    if (init?.method === "GET") return Response.json({ name: "work", type: 0 });
    if (String(url).endsWith("/threads")) return Response.json({ id: "slash-thread", name: "report" });
    return Response.json({ id: "sent" });
  }) as unknown as typeof fetch;
  await handleInteractionCreate("fake", {
    id: "slash",
    type: 2,
    application_id: "app",
    channel_id: "slash-auto",
    guild_id: "g",
    token: "fake",
    member: { user: { id: "a", username: "Alice", discriminator: "0" } },
    data: { name: "my-report" },
  });
  expect(paths.some((path) => path.endsWith("/channels/slash-thread/messages"))).toBe(true);
  expect(getByKey(await getSharedDb(), "thread:discord:slash-thread")?.claude_session_id).toBe(
    "scoped-session"
  );
});

test("stopping a bridge cancels its child and prevents successful persistence", async () => {
  const ready = join(cwd, "child-ready");
  const script = join(cwd, "cancel-child.ts");
  await writeFile(
    script,
    `await Bun.write(${JSON.stringify(ready)},"ready"); await Bun.sleep(700); console.log(JSON.stringify({session_id:"cancel",result:"done"}));`
  );
  process.env.HERMES_CLAUDE_BIN = `bun run ${script}`;
  const controller = new AbortController();
  const task = withBridgeSignal(controller.signal, () =>
    runUserMessage("telegram", "run until stopped", target(), undefined, "telegram")
  );
  const deadline = Date.now() + 2000;
  while (!(await Bun.file(ready).exists()) && Date.now() < deadline) await Bun.sleep(5);
  controller.abort(new Error("bridge stopped"));
  const result = await task;
  expect(result.exitCode).toBe(130);
  expect((await getSharedDb()).query("SELECT * FROM messages").all()).toHaveLength(0);
});

test("Telegram admits media and text in arrival order before attachment preparation", async () => {
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).endsWith("/getFile")) {
      await Bun.sleep(60);
      return Response.json({ ok: true, result: { file_path: "image.jpg" } });
    }
    if (String(url).includes("/file/bot")) return new Response(new Uint8Array([1, 2, 3]));
    return Response.json({ ok: true, result: { message_id: 1 } });
  }) as unknown as typeof fetch;
  const message = {
    message_id: 1,
    from: { id: 1, first_name: "Alice" },
    chat: { id: 1, type: "private" },
    text: "FIRST",
  };
  await Promise.all([
    handleTelegramMessage({ ...message, photo: [{ file_id: "image", width: 1, height: 1 }] }),
    handleTelegramMessage({ ...message, message_id: 2, text: "SECOND" }),
  ]);
  const db = await getSharedDb();
  const rows = db
    .query<{ content: string }, []>("SELECT content FROM messages WHERE role = 'user' ORDER BY id")
    .all();
  expect(rows[0].content).toContain("FIRST");
  expect(rows[1].content).toContain("SECOND");
});

test("Discord admits messages before asynchronous channel lookup", async () => {
  let gets = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "GET") {
      if (++gets === 1) await Bun.sleep(60);
      return Response.json({ name: "listen-order", type: 0 });
    }
    return Response.json({ id: "sent" });
  }) as unknown as typeof fetch;
  const message = {
    id: "first",
    channel_id: "ordered",
    guild_id: "g",
    author: { id: "a", username: "Alice", discriminator: "0" },
    content: "FIRST",
    attachments: [],
    mentions: [],
    type: 0,
  };
  await Promise.all([
    handleMessageCreate("fake", message),
    handleMessageCreate("fake", { ...message, id: "second", content: "SECOND" }),
  ]);
  const rows = (await getSharedDb())
    .query<{ content: string }, []>("SELECT content FROM messages WHERE role = 'user' ORDER BY id")
    .all();
  expect(rows[0].content).toContain("FIRST");
  expect(rows[1].content).toContain("SECOND");
});

test("Telegram live policy controls triggers, shared sessions, models and skill admission", async () => {
  const db = await getSharedDb();
  upsertPolicy(
    db,
    { source: "telegram", channel: "-51" },
    {
      mode: "listen",
      sessionScope: "shared",
      memoryScope: "none",
      allowedSkills: [],
      modelPolicy: { model: "haiku", fallback: "sonnet" },
    }
  );
  const capture = join(cwd, "policy-args.json");
  const script = join(cwd, "policy-claude.ts");
  await writeFile(
    script,
    `await Bun.write(${JSON.stringify(capture)},JSON.stringify(process.argv)); console.log(JSON.stringify({type:"result",subtype:"success",session_id:"policy",result:"ok"}));`
  );
  process.env.HERMES_CLAUDE_BIN = `bun run ${script}`;
  const replies: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body.text) replies.push(body.text);
    return Response.json({ ok: true, result: { message_id: 1 } });
  }) as unknown as typeof fetch;
  const message = {
    message_id: 1,
    from: { id: 1, first_name: "Alice" },
    chat: { id: -51, type: "supergroup" as const },
    text: "no mention required",
  };
  await handleTelegramMessage(message);
  expect(getByKey(db, "shared:telegram:_:-51")?.claude_session_id).toBe("policy");
  const args = JSON.parse(await readFile(capture, "utf8"));
  expect(args[args.indexOf("--model") + 1]).toBe("haiku");
  expect(args[args.indexOf("--fallback-model") + 1]).toBe("sonnet");
  expect(args).toContain("--disable-slash-commands");
  const before = db.query("SELECT count(*) AS n FROM messages").get();
  await handleTelegramMessage({ ...message, text: "/deploy" });
  expect(replies.some((text) => text.includes("not allowed"))).toBe(true);
  expect(db.query("SELECT count(*) AS n FROM messages").get()).toEqual(before);
  upsertPolicy(db, { source: "telegram", channel: "-51" }, { mode: "delivery-only" });
  await handleTelegramMessage({ ...message, text: "/start" });
  expect(db.query("SELECT count(*) AS n FROM messages").get()).toEqual(before);
});

test("Discord autoThread routes work and replies into the created thread", async () => {
  const db = await getSharedDb();
  upsertPolicy(
    db,
    { source: "discord", guild: "g", channel: "auto-c" },
    { mode: "listen", autoThread: true, sessionScope: "per-thread", modelPolicy: { model: "haiku" } }
  );
  const paths: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const path = String(url);
    paths.push(path);
    if (init?.method === "GET") return Response.json({ id: "auto-c", name: "work", type: 0 });
    if (path.endsWith("/threads")) return Response.json({ id: "new-thread", name: "work" });
    return Response.json({ id: "sent" });
  }) as unknown as typeof fetch;
  await handleMessageCreate("fake", {
    id: "m-auto",
    channel_id: "auto-c",
    guild_id: "g",
    author: { id: "a", username: "Alice", discriminator: "0" },
    content: "hello",
    attachments: [],
    mentions: [],
    type: 0,
  });
  expect(paths.some((path) => path.endsWith("/channels/auto-c/messages/m-auto/threads"))).toBe(true);
  expect(paths.some((path) => path.endsWith("/channels/new-thread/messages"))).toBe(true);
  expect(getByKey(db, "thread:discord:new-thread")?.claude_session_id).toBe("scoped-session");
  upsertPolicy(
    db,
    { source: "discord", guild: "g", channel: "auto-c" },
    { mode: "listen", autoThread: true, allowedSkills: [] }
  );
  const createdBefore = paths.filter((path) => path.endsWith("/threads")).length;
  await handleMessageCreate("fake", {
    id: "m-denied",
    channel_id: "auto-c",
    guild_id: "g",
    author: { id: "a", username: "Alice", discriminator: "0" },
    content: "/deploy",
    attachments: [],
    mentions: [],
    type: 0,
  });
  expect(paths.filter((path) => path.endsWith("/threads"))).toHaveLength(createdBefore);
});

test("Telegram autoThread creates a forum topic and isolates its session", async () => {
  const db = await getSharedDb();
  upsertPolicy(db, { source: "telegram", channel: "-60" }, { mode: "listen", autoThread: true });
  const topics: number[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (String(url).endsWith("/createForumTopic"))
      return Response.json({ ok: true, result: { message_thread_id: 81 } });
    if (String(url).endsWith("/sendMessage")) topics.push(body.message_thread_id);
    return Response.json({ ok: true, result: { message_id: 1 } });
  }) as unknown as typeof fetch;
  await handleTelegramMessage({
    message_id: 1,
    from: { id: 1, first_name: "Alice" },
    chat: { id: -60, type: "supergroup", is_forum: true },
    text: "hello",
  });
  expect(getByKey(db, "thread:telegram:-60:81")?.claude_session_id).toBe("scoped-session");
  expect(topics.every((topic) => topic === 81)).toBe(true);
});

test("native overload fallback excludes Hermes provider aliases", async () => {
  const settingsPath = join(cwd, ".claude/hermes/settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  settings.model = "sonnet";
  settings.fallback = { model: "glm", api: "" };
  await writeFile(settingsPath, JSON.stringify(settings));
  await reloadSettings();
  const script = join(cwd, "capture-fallback.ts");
  const capture = join(cwd, "args.json");
  await writeFile(
    script,
    `await Bun.write(${JSON.stringify(capture)}, JSON.stringify(process.argv)); console.log(JSON.stringify({session_id:"test", result:"ok"}));`
  );
  process.env.HERMES_CLAUDE_BIN = `bun run ${script}`;
  await runUserMessage("telegram", "hello", target(), undefined, "telegram");
  expect(JSON.parse(await readFile(capture, "utf8"))).not.toContain("--fallback-model");
  settings.fallback.model = "haiku";
  await writeFile(settingsPath, JSON.stringify(settings));
  await reloadSettings();
  await runUserMessage("telegram", "hello again", target(), undefined, "telegram");
  const args = JSON.parse(await readFile(capture, "utf8"));
  expect(args[args.indexOf("--fallback-model") + 1]).toBe("haiku");
});

test("bridge facts use the original human text and remain attributed", async () => {
  globalThis.fetch = (async () =>
    Response.json({ ok: true, result: { message_id: 1 } })) as unknown as typeof fetch;
  await handleTelegramMessage({
    message_id: 31,
    from: { id: 1, first_name: "Alice" },
    chat: { id: 1, type: "private" },
    text: "my deployment port is 8123",
  });
  const db = await getSharedDb();
  const facts = db.query("SELECT value, source_session_id FROM memory_entries").all();
  expect(facts).toEqual([{ value: "8123", source_session_id: getByKey(db, "user:telegram:1")!.id }]);
});

test("Telegram forget erases only addressed history, facts and native auto memory", async () => {
  globalThis.fetch = (async () =>
    Response.json({ ok: true, result: { message_id: 1 } })) as unknown as typeof fetch;
  await runUserMessage("telegram", "my deployment port is 8123", target(), undefined, "telegram");
  await runUserMessage("telegram", "my deployment port is 9000", target(2), undefined, "telegram");
  const args = claudeSessionArgs(target());
  const memoryDir = JSON.parse(args[args.indexOf("--settings") + 1]).autoMemoryDirectory;
  await mkdir(memoryDir, { recursive: true });
  await writeFile(join(memoryDir, "MEMORY.md"), "secret");
  await handleTelegramMessage({
    message_id: 1,
    from: { id: 1, first_name: "Alice" },
    chat: { id: 1, type: "private" },
    text: "/forget",
  });
  expect(await Bun.file(join(memoryDir, "MEMORY.md")).exists()).toBe(false);
  const db = await getSharedDb();
  expect(getByKey(db, target().key)).toBeNull();
  expect(db.query("SELECT value FROM memory_entries").all()).toEqual([{ value: "9000" }]);
  expect(db.query("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 2 });
});

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

test("model fallback never replays a task after a partial execution", async () => {
  const path = join(cwd, ".claude/hermes/settings.json");
  const settings = JSON.parse(await readFile(path, "utf8"));
  settings.model = "primary";
  settings.fallback = { model: "fallback", api: "different-provider" };
  await writeFile(path, JSON.stringify(settings));
  await reloadSettings();
  const calls = join(cwd, "side-effects.txt");
  const script = join(cwd, "partial-claude.ts");
  await writeFile(
    script,
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(calls)}, "effect\\n");
console.log(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "partial", result: "You've hit your limit" }));
process.exit(1);`
  );
  process.env.HERMES_CLAUDE_BIN = `bun run ${script}`;
  const result = await runUserMessage("telegram", "perform once", target(), undefined, "telegram");
  expect(result.exitCode).not.toBe(0);
  expect(await readFile(calls, "utf8")).toBe("effect\n");
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

test("successful turns save attributed explicit facts and none skips automatic memory writes", async () => {
  await runUserMessage("telegram", "my deployment port is 8123", target(), undefined, "telegram");
  const db = await getSharedDb();
  const facts = db.query("SELECT key, value, source_session_id FROM memory_entries").all() as {
    key: string;
    value: string;
    source_session_id: number;
  }[];
  expect(facts).toHaveLength(1);
  expect(facts[0].value).toBe("8123");
  expect(facts[0].source_session_id).toBe(getByKey(db, target().key)!.id);
  await runUserMessage(
    "telegram",
    "my secret is private",
    { ...target(2), memoryScope: "none" },
    undefined,
    "telegram"
  );
  expect(db.query("SELECT count(*) AS n FROM memory_entries").get()).toEqual({ n: 1 });
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
