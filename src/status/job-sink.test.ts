import { describe, expect, test } from "bun:test";
import type { Settings } from "../config";
import { createJobStatusSink } from "./job-sink";

/**
 * Minimal-but-type-complete Settings fixture. Builds a full Settings so
 * tests can pass the object directly without `as Settings` casts, then
 * individual tests override only what they care about.
 */
function makeSettings(overrides: Partial<Settings["discord"]> = {}): Settings {
  return {
    model: "",
    api: "",
    fallback: { model: "", api: "" },
    agentic: { enabled: false, defaultMode: "implementation", modes: [] },
    timezone: "UTC",
    timezoneOffsetMinutes: 0,
    heartbeat: {
      enabled: false,
      interval: 15,
      prompt: "",
      excludeWindows: [],
      forwardToTelegram: false,
      forwardToDiscord: false,
    },
    telegram: { token: "", allowedUserIds: [] },
    discord: {
      token: "",
      allowedUserIds: [],
      listenChannels: [],
      ...overrides,
    } as Settings["discord"],
    security: {
      level: "moderate",
      allowedTools: [],
      disallowedTools: [],
      bypassPermissions: false,
    },
    stt: { baseUrl: "", model: "" },
    plugins: { preflightOnStart: false },
    logging: { includeBodies: false },
  };
}

describe("createJobStatusSink", () => {
  test("returns undefined when discord.token is empty", () => {
    const s = makeSettings({ token: "", statusChannelId: "c" } as any);
    expect(createJobStatusSink("heartbeat", s)).toBeUndefined();
  });

  test("returns undefined when statusChannelId is missing", () => {
    const s = makeSettings({ token: "t" });
    // no statusChannelId set on discord
    expect(createJobStatusSink("heartbeat", s)).toBeUndefined();
  });

  test("returns a StatusSink when both token and statusChannelId are set", () => {
    const s = makeSettings({ token: "t", statusChannelId: "c" } as any);
    const sink = createJobStatusSink("heartbeat", s);
    expect(sink).toBeDefined();
    expect(typeof sink!.open).toBe("function");
    expect(typeof sink!.update).toBe("function");
    expect(typeof sink!.close).toBe("function");
  });

  test("returns undefined when statusChannelId is an empty string", () => {
    const s = makeSettings({ token: "t", statusChannelId: "" } as any);
    expect(createJobStatusSink("heartbeat", s)).toBeUndefined();
  });
});
