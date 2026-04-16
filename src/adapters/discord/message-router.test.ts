import { describe, expect, test } from "bun:test";
import { toEnvelope, type DiscordContext, type DiscordMessageEvent } from "./message-router";

function makeEvent(overrides: Partial<DiscordMessageEvent> = {}): DiscordMessageEvent {
  return {
    id: "M1",
    channel_id: "C1",
    guild_id: "G1",
    author: { id: "U1", username: "alice" },
    content: "<@BOT> hello",
    mentions: [],
    attachments: [],
    ...overrides,
  };
}

function makeCtx(overrides: Partial<DiscordContext> = {}): DiscordContext {
  return {
    botUserId: "BOT",
    adminIds: [],
    workspace: "/tmp/proj",
    channelIsThread: false,
    isDm: false,
    ...overrides,
  };
}

describe("discord message-router", () => {
  test("DM event marks trigger as dm and skips guild", () => {
    const env = toEnvelope(makeEvent({ guild_id: undefined }), makeCtx({ isDm: true }));
    expect(env.source).toBe("discord");
    expect(env.trigger).toBe("dm");
    expect(env.guild).toBeUndefined();
  });

  test("mention event uses mention trigger", () => {
    const env = toEnvelope(makeEvent({ mentions: [{ id: "BOT" }] }), makeCtx());
    expect(env.trigger).toBe("mention");
  });

  test("reply to bot uses reply trigger", () => {
    const env = toEnvelope(makeEvent({ referenced_message: { id: "X", author: { id: "BOT" } } }), makeCtx());
    expect(env.trigger).toBe("reply");
  });

  test("free-response channel uses listen trigger", () => {
    const env = toEnvelope(
      makeEvent({ content: "thinking out loud" }),
      makeCtx({ channelMode: "free-response" })
    );
    expect(env.trigger).toBe("listen");
  });

  test("bot mention is stripped from message text", () => {
    const env = toEnvelope(makeEvent({ content: "<@BOT> deploy main" }), makeCtx());
    expect(env.message.text).toBe("deploy main");
  });

  test("attachments are classified by mime type", () => {
    const env = toEnvelope(
      makeEvent({
        attachments: [
          { url: "u1", content_type: "image/png" },
          { url: "u2", content_type: "audio/ogg" },
          { url: "u3", content_type: "application/pdf" },
          { url: "u4" },
        ],
      }),
      makeCtx()
    );
    expect(env.attachments.map((a) => a.kind)).toEqual(["image", "voice", "document", "document"]);
  });

  test("admin flag is set from ctx", () => {
    const env = toEnvelope(makeEvent({ author: { id: "U1" } }), makeCtx({ adminIds: ["U1"] }));
    expect(env.user.isAdmin).toBe(true);
  });

  test("thread channel keeps thread id on envelope", () => {
    const env = toEnvelope(makeEvent({ channel_id: "T1" }), makeCtx({ channelIsThread: true }));
    expect(env.thread).toBe("T1");
  });
});
