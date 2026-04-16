import { describe, expect, test } from "bun:test";
import type { Envelope } from "./envelope";
import { sessionKeyFor } from "./session-key";

function makeEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    source: "discord",
    workspace: "/tmp/proj",
    user: { id: "U1", isAdmin: false },
    message: { text: "hi" },
    attachments: [],
    trigger: "mention",
    receivedAt: new Date("2026-04-16T00:00:00Z"),
    ...overrides,
  };
}

describe("sessionKeyFor", () => {
  test("dm scope keys on source + user id", () => {
    const key = sessionKeyFor({ envelope: makeEnvelope({ trigger: "dm" }), scope: "dm" });
    expect(key).toBe("dm:discord:U1");
  });

  test("per-user scope is transport-aware but channel-agnostic", () => {
    const a = sessionKeyFor({
      envelope: makeEnvelope({ guild: "G", channel: "C1" }),
      scope: "per-user",
    });
    const b = sessionKeyFor({
      envelope: makeEnvelope({ guild: "G", channel: "C2" }),
      scope: "per-user",
    });
    expect(a).toBe(b);
    expect(a).toBe("user:discord:U1");
  });

  test("per-channel-user distinguishes channels", () => {
    const a = sessionKeyFor({
      envelope: makeEnvelope({ guild: "G", channel: "C1" }),
      scope: "per-channel-user",
    });
    const b = sessionKeyFor({
      envelope: makeEnvelope({ guild: "G", channel: "C2" }),
      scope: "per-channel-user",
    });
    expect(a).not.toBe(b);
    expect(a).toBe("channel-user:discord:G:C1:U1");
  });

  test("per-channel-user fills missing guild/channel with underscore", () => {
    const env = makeEnvelope({ source: "telegram" });
    const key = sessionKeyFor({ envelope: env, scope: "per-channel-user" });
    expect(key).toBe("channel-user:telegram:_:_:U1");
  });

  test("per-thread requires a thread", () => {
    expect(() => sessionKeyFor({ envelope: makeEnvelope(), scope: "per-thread" })).toThrow(
      /requires envelope.thread/
    );
  });

  test("per-thread keys on source + thread id", () => {
    const env = makeEnvelope({ thread: "T42", guild: "G", channel: "C1" });
    expect(sessionKeyFor({ envelope: env, scope: "per-thread" })).toBe("thread:discord:T42");
  });

  test("shared scope collapses users in the same channel", () => {
    const a = sessionKeyFor({
      envelope: makeEnvelope({ guild: "G", channel: "C1", user: { id: "alice", isAdmin: false } }),
      scope: "shared",
    });
    const b = sessionKeyFor({
      envelope: makeEnvelope({ guild: "G", channel: "C1", user: { id: "bob", isAdmin: false } }),
      scope: "shared",
    });
    expect(a).toBe(b);
    expect(a).toBe("shared:discord:G:C1");
  });

  test("workspace scope hashes the workspace path deterministically", () => {
    const a = sessionKeyFor({
      envelope: makeEnvelope({ source: "cron", workspace: "/home/proj" }),
      scope: "workspace",
    });
    const b = sessionKeyFor({
      envelope: makeEnvelope({ source: "cron", workspace: "/home/proj" }),
      scope: "workspace",
    });
    const other = sessionKeyFor({
      envelope: makeEnvelope({ source: "cron", workspace: "/home/other" }),
      scope: "workspace",
    });
    expect(a).toBe(b);
    expect(a).not.toBe(other);
    expect(a.startsWith("workspace:")).toBe(true);
    expect(a.length).toBe("workspace:".length + 12);
  });

  test("per-user is stable across multiple trigger values", () => {
    const triggers: Array<Envelope["trigger"]> = ["mention", "reply", "command", "voice"];
    const keys = triggers.map((trigger) =>
      sessionKeyFor({ envelope: makeEnvelope({ trigger }), scope: "per-user" })
    );
    expect(new Set(keys).size).toBe(1);
  });

  test("telegram vs discord never collide on per-user", () => {
    const discord = sessionKeyFor({
      envelope: makeEnvelope({ source: "discord" }),
      scope: "per-user",
    });
    const telegram = sessionKeyFor({
      envelope: makeEnvelope({ source: "telegram" }),
      scope: "per-user",
    });
    expect(discord).not.toBe(telegram);
  });

  test("dm vs per-user keys differ even when the user is the same", () => {
    const dm = sessionKeyFor({ envelope: makeEnvelope({ trigger: "dm" }), scope: "dm" });
    const user = sessionKeyFor({ envelope: makeEnvelope(), scope: "per-user" });
    expect(dm).not.toBe(user);
  });
});
