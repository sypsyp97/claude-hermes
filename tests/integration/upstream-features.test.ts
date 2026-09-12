import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reloadSettings } from "../../src/config";
import { resetSharedDbCache } from "../../src/state/shared-db";
import { handleMessage as telegram } from "../../src/commands/telegram";
import { handleMessageCreate as discord, stopGateway } from "../../src/commands/discord";
const originalCwd = process.cwd();
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
let cwd: string;
let requests: Array<{ url: string; body: any }>;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "hermes-upstream-"));
  await mkdir(join(cwd, ".claude/hermes"), { recursive: true });
  await writeFile(
    join(cwd, ".claude/hermes/settings.json"),
    JSON.stringify({
      agentic: { enabled: false },
      learning: { captureCandidateSkills: false },
      telegram: { token: "fake", allowedUserIds: [1] },
      discord: { token: "fake", allowedUserIds: ["a"] },
    })
  );
  process.chdir(cwd);
  process.env.HERMES_CLAUDE_BIN = `bun run ${join(originalCwd, "tests/fixtures/fake-claude.ts")}`;
  process.env.HERMES_FAKE_ECHO_PROMPT = "1";
  requests = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const address = String(url);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    requests.push({ url: address, body });
    if (address.includes("/files/")) return new Response("file content");
    if (address.endsWith("/getFile"))
      return Response.json({ ok: true, result: { file_path: "files/report.json" } });
    return Response.json({ ok: true, result: { message_id: 1 }, id: "sent" });
  }) as typeof fetch;
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
const tg = { message_id: 1, from: { id: 1, first_name: "Alice" }, chat: { id: 1, type: "private" } };
const dc = {
  id: "m",
  channel_id: "dm",
  author: { id: "a", username: "Alice", discriminator: "0" },
  content: "Compare these",
  attachments: [],
  mentions: [],
  type: 0,
};
function responses() {
  return requests.map((r) => r.body?.text ?? r.body?.content ?? "").join("\n");
}

test("Telegram includes quoted text with source without replacing the current request", async () => {
  await telegram({
    ...tg,
    text: "Choose this one",
    reply_to_message: { message_id: 9, from: { id: 2, first_name: "Bob" }, text: "Option A is blue" },
    quote: { text: "Option A" },
  });
  expect(responses()).toContain("Option A");
  expect(responses()).toContain("Choose this one");
  expect(responses()).toContain("9");
});
test.each(["application/json", undefined])("Telegram accepts a document with MIME %s", async (mime_type) => {
  await telegram({ ...tg, document: { file_id: "doc", file_name: "report.json", mime_type } });
  expect(requests.some((r) => r.url.endsWith("/getFile"))).toBe(true);
  expect(responses()).toContain("Document path:");
});
test("Discord downloads every image and generic document", async () => {
  const attachments = ["a.png", "b.png", "report.txt"].map((filename, i) => ({
    id: String(i),
    filename,
    content_type: i < 2 ? "image/png" : "text/plain",
    url: `https://cdn.discordapp.com/files/${filename}`,
    proxy_url: "",
    size: 12,
  }));
  await discord("fake", { ...dc, attachments });
  expect(requests.filter((r) => r.url.includes("/files/")).length).toBe(3);
  expect(responses()).toContain("Document path:");
});
test("Discord supplies reply text and forwarded snapshots", async () => {
  await discord("fake", {
    ...dc,
    referenced_message: { ...dc, id: "old", content: "the earlier option" },
    message_snapshots: [{ message: { content: "the forwarded proposal", attachments: [] } }],
  });
  expect(responses()).toContain("the earlier option");
  expect(responses()).toContain("the forwarded proposal");
});
test("Discord ignores thread creation system messages", async () => {
  await discord("fake", { ...dc, type: 18 });
  expect(requests).toEqual([]);
});

test("Telegram forwards are contextual data even when their text is a control command", async () => {
  await telegram({
    ...tg,
    text: "/forget",
    forward_origin: { type: "hidden_user", sender_user_name: "Bob" },
  });
  expect(responses()).toContain("Referenced message");
  expect(responses()).toContain("/forget");
  expect(responses()).not.toContain("were erased");
});

test("channel allowlist grants only the named guild channel, including slash commands", async () => {
  const { getSharedDb } = await import("../../src/state/shared-db");
  const { upsertPolicy } = await import("../../src/state/repos/policies");
  const { handleInteractionCreate } = await import("../../src/commands/discord");
  upsertPolicy(
    await getSharedDb(),
    { source: "discord", guild: "g", channel: "allowed" },
    { mode: "listen", allowedUserIds: ["guest"] }
  );
  const author = { ...dc.author, id: "guest" };
  await discord("fake", { ...dc, author, guild_id: "g", channel_id: "allowed", content: "hello guest" });
  expect(responses()).toContain("hello guest");
  requests = [];
  await handleInteractionCreate("fake", {
    id: "i",
    application_id: "app",
    type: 2,
    token: "interaction",
    guild_id: "g",
    channel_id: "allowed",
    member: { user: author },
    data: { name: "model" },
  });
  expect(requests.some((r) => JSON.stringify(r.body).includes("conversation's model"))).toBe(true);
  requests = [];
  await discord("fake", { ...dc, author, guild_id: "g", channel_id: "denied", content: "must stay hidden" });
  await discord("fake", { ...dc, author, content: "must stay hidden" });
  expect(responses()).not.toContain("must stay hidden");
});

test("Discord gives current files precedence and keeps original names and contextual audio", async () => {
  const attachment = (id: string, filename: string, content_type: string) => ({
    id,
    filename,
    content_type,
    url: `https://cdn.discordapp.com/files/${filename}`,
    proxy_url: "",
    size: 1,
  });
  const current = attachment("current", "budget.csv", "text/csv");
  const old = Array.from({ length: 10 }, (_, i) => attachment(String(i), `${i}.png`, "image/png"));
  await discord("fake", { ...dc, attachments: [current], referenced_message: { ...dc, attachments: old } });
  expect(requests.some((r) => r.url.endsWith("/files/budget.csv"))).toBe(true);
  expect(responses()).toContain("budget.csv");
  expect(requests.filter((r) => r.url.includes("/files/")).length).toBe(10);
  requests = [];
  await discord("fake", {
    ...dc,
    message_snapshots: [
      { message: { content: "audio", attachments: [attachment("audio", "clip.ogg", "audio/ogg")] } },
    ],
  });
  expect(requests.some((r) => r.url.endsWith("/files/clip.ogg"))).toBe(true);
});

test.each(["discord", "telegram"] as const)(
  "%s cancellation bypasses the occupied bridge lane",
  async (platform) => {
    const { withActiveConversation } = await import("../../src/runtime/conversation-controls");
    const { bridgeSignal, withBridgeSignal } = await import("../../src/runtime/bridge-context");
    const { enqueueBridge } = await import("../../src/runtime/bridge-queue");
    const { telegramSessionTarget, discordSessionTarget } = await import("../../src/router/bridge-session");
    const { defaultPolicy } = await import("../../src/policy/channel");
    const { handleDispatch } = await import("../../src/commands/discord");
    if (platform === "discord") {
      handleDispatch("fake", "READY", {
        user: { id: "bot", username: "Hermes" },
        application: { id: "app" },
        guilds: [],
      });
      await Bun.sleep(10);
    }
    const target =
      platform === "telegram"
        ? telegramSessionTarget({ workspace: cwd, chatId: 1, userId: 1, isDm: true })
        : discordSessionTarget(
            { workspace: cwd, channelId: "dm", userId: "a" },
            defaultPolicy({ source: "discord", isDm: true })
          );
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    await withActiveConversation(target, async () => {
      const signal = bridgeSignal()!;
      const busy = enqueueBridge(platform, platform === "telegram" ? "1:main" : "dm", () => gate);
      const cancel = withBridgeSignal(new AbortController().signal, () =>
        platform === "telegram"
          ? telegram({ ...tg, caption: "/cancel", document: { file_id: "doc" } })
          : discord("fake", { ...dc, content: "<@bot> /cancel" })
      );
      await Promise.race([cancel, Bun.sleep(100)]);
      const cancelled = signal.aborted;
      release();
      await Promise.allSettled([busy, cancel]);
      expect(cancelled).toBe(true);
    });
  }
);

test("ordinary Discord stop prose remains a message", async () => {
  await discord("fake", { ...dc, content: "Stop worrying about formatting" });
  expect(responses()).toContain("Message: Stop worrying about formatting");
});

test("Telegram includes referenced document with message provenance", async () => {
  await telegram({
    ...tg,
    text: "Summarize this",
    reply_to_message: {
      message_id: 12,
      document: { file_id: "doc", file_name: "reference.pdf", mime_type: "application/pdf" },
    },
  });
  expect(requests.some((r) => r.url.endsWith("/getFile"))).toBe(true);
  expect(responses()).toContain("reference.pdf");
  expect(responses()).toContain("12");
});

test.each(["message", "slash"] as const)(
  "Discord %s replies upload artifacts with no visible directives",
  async (kind) => {
    const { artifactDirectory } = await import("../../src/runtime/artifacts");
    const { discordSessionTarget } = await import("../../src/router/bridge-session");
    const { defaultPolicy } = await import("../../src/policy/channel");
    const { handleInteractionCreate } = await import("../../src/commands/discord");
    const target = discordSessionTarget(
      { workspace: cwd, channelId: "dm", userId: "a" },
      defaultPolicy({ source: "discord", isDm: true })
    );
    const dir = artifactDirectory(cwd, target.key);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "report.csv");
    await writeFile(path, "a,b\n1,2");
    delete process.env.HERMES_FAKE_ECHO_PROMPT;
    process.env.HERMES_FAKE_REPLY = `Report ready [send-file:${path}]`;
    if (kind === "message") await discord("fake", dc);
    else {
      await mkdir(join(cwd, ".claude/skills/report"), { recursive: true });
      await writeFile(join(cwd, ".claude/skills/report/SKILL.md"), "Generate report.");
      await handleInteractionCreate("fake", {
        id: "i",
        application_id: "app",
        type: 2,
        token: "interaction",
        channel_id: "dm",
        user: dc.author,
        data: { name: "report" },
      });
    }
    expect(requests.filter((r) => r.body instanceof FormData)).toHaveLength(1);
    expect(responses()).not.toContain("[send-file:");
  }
);

test("a channel-only guest cannot manage other threads through its parent", async () => {
  const { getSharedDb } = await import("../../src/state/shared-db");
  const { upsertPolicy } = await import("../../src/state/repos/policies");
  upsertPolicy(
    await getSharedDb(),
    { source: "discord", guild: "g", channel: "parent" },
    { mode: "listen", allowedUserIds: ["guest"] }
  );
  await discord("fake", {
    ...dc,
    guild_id: "g",
    channel_id: "parent",
    author: { ...dc.author, id: "guest" },
    content: "delete secret",
  });
  expect(responses()).toContain("globally authorized");
  expect(requests.some((r) => r.url.includes("/threads"))).toBe(false);
});

test("status reflects the persisted conversation model", async () => {
  await telegram({ ...tg, text: "hello" });
  await telegram({ ...tg, text: "/model haiku" });
  requests = [];
  await telegram({ ...tg, text: "/status" });
  expect(responses()).toContain("Model: haiku");
});

test("replying to a forwarded Discord message preserves its snapshot context", async () => {
  await discord("fake", {
    ...dc,
    referenced_message: {
      ...dc,
      id: "forwarded",
      content: "",
      message_snapshots: [
        {
          message: {
            content: "original forwarded proposal",
            attachments: [
              {
                id: "nested",
                filename: "forward.png",
                content_type: "image/png",
                url: "https://cdn.discordapp.com/files/forward.png",
                proxy_url: "",
                size: 1,
              },
            ],
          },
        },
      ],
    },
  });
  expect(responses()).toContain("original forwarded proposal");
  expect(requests.some((r) => r.url.endsWith("/files/forward.png"))).toBe(true);
});

test.each(["message", "slash"] as const)(
  "Discord %s cancellation does not wait for another channel's metadata lookup",
  async (kind) => {
    const { withActiveConversation } = await import("../../src/runtime/conversation-controls");
    const { bridgeSignal, withBridgeSignal } = await import("../../src/runtime/bridge-context");
    const { discordSessionTarget } = await import("../../src/router/bridge-session");
    const { defaultPolicy } = await import("../../src/policy/channel");
    const target = discordSessionTarget(
      { workspace: cwd, channelId: "dm", userId: "a" },
      defaultPolicy({ source: "discord", isDm: true })
    );
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const ready = new Promise<void>((r) => {
      started = r;
    });
    const fallback = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/channels/slow")) {
        started();
        await gate;
      }
      return fallback(url as string, init);
    }) as typeof fetch;
    const slow = discord("fake", {
      ...dc,
      guild_id: "g",
      channel_id: "slow",
      author: { ...dc.author, id: "guest" },
    });
    await ready;
    await withActiveConversation(target, async () => {
      const signal = bridgeSignal()!;
      const { handleInteractionCreate } = await import("../../src/commands/discord");
      const cancel = withBridgeSignal(new AbortController().signal, () =>
        kind === "message"
          ? discord("fake", { ...dc, content: "/cancel" })
          : handleInteractionCreate("fake", {
              id: "cancel",
              application_id: "app",
              type: 2,
              token: "interaction",
              channel_id: "dm",
              user: dc.author,
              data: { name: "cancel" },
            })
      );
      await Promise.race([cancel, Bun.sleep(100)]);
      const cancelled = signal.aborted;
      release();
      await Promise.allSettled([slow, cancel]);
      expect(cancelled).toBe(true);
    });
  }
);
