import { describe, expect, test } from "bun:test";
import { route, type ChannelPolicy, type RouteEnv } from "../../src/router";
import type { Envelope } from "../../src/router";

function env(overrides: Partial<RouteEnv> = {}): RouteEnv {
  return {
    auth: { allowedUserIds: [] },
    defaultAllowedTools: ["Read", "Write", "Bash"],
    defaultModel: "sonnet",
    defaultFallbackModel: "haiku",
    policyFor: () => ({ sessionScope: "per-user", allowedTools: "*", memoryScope: "user" }),
    promptLayers: () => ["SOUL"],
    ...overrides,
  };
}

function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    source: "discord",
    workspace: "/tmp/proj",
    user: { id: "U", isAdmin: false },
    message: { text: "hi" },
    attachments: [],
    trigger: "mention",
    receivedAt: new Date(),
    ...overrides,
  };
}

describe("envelope routing across sources", () => {
  test("discord DM → dm key", () => {
    const r = route(
      envelope({ trigger: "dm", user: { id: "alice", isAdmin: false } }),
      env({ policyFor: () => policy("dm") })
    );
    expect(r.decision.sessionKey).toBe("dm:discord:alice");
  });

  test("discord channel mention → per-channel-user key", () => {
    const r = route(
      envelope({ guild: "G", channel: "C", user: { id: "alice", isAdmin: false } }),
      env({ policyFor: () => policy("per-channel-user") })
    );
    expect(r.decision.sessionKey).toBe("channel-user:discord:G:C:alice");
  });

  test("discord thread → per-thread key", () => {
    const r = route(
      envelope({ thread: "T1", guild: "G", channel: "C" }),
      env({ policyFor: () => policy("per-thread") })
    );
    expect(r.decision.sessionKey).toBe("thread:discord:T1");
  });

  test("discord listen channel → shared key", () => {
    const r = route(
      envelope({ guild: "G", channel: "listen", trigger: "listen" }),
      env({ policyFor: () => policy("shared") })
    );
    expect(r.decision.sessionKey).toBe("shared:discord:G:listen");
  });

  test("telegram DM → dm key", () => {
    const r = route(
      envelope({ source: "telegram", trigger: "dm", user: { id: "tg-42", isAdmin: false } }),
      env({ policyFor: () => policy("dm") })
    );
    expect(r.decision.sessionKey).toBe("dm:telegram:tg-42");
  });

  test("cron heartbeat → workspace key", () => {
    const r = route(
      envelope({ source: "cron", trigger: "heartbeat", workspace: "/home/proj" }),
      env({ policyFor: () => policy("workspace") })
    );
    expect(r.decision.sessionKey.startsWith("workspace:")).toBe(true);
  });

  test("voice attachment preserves the transcription on the envelope", () => {
    const r = route(
      envelope({
        trigger: "voice",
        attachments: [{ kind: "voice", transcription: "deploy main" }],
      }),
      env()
    );
    expect(r.envelope.attachments[0]?.transcription).toBe("deploy main");
    expect(r.decision.sessionKey).toBeDefined();
  });
});

function policy(scope: ChannelPolicy["sessionScope"]): ChannelPolicy {
  return { sessionScope: scope, allowedTools: "*", memoryScope: "channel" };
}
