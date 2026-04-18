import { describe, expect, test } from "bun:test";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ForwardDiscordResultOptions {
  allowedUserIds: string[];
  label: string;
  result: CommandResult;
  sendToChannel?: (channelId: string, text: string) => Promise<void>;
  sendToUser?: (userId: string, text: string) => Promise<void>;
  statusChannelId?: string;
}

interface StartModule {
  forwardDiscordResult?: (options: ForwardDiscordResultOptions) => Promise<"channel" | "dm" | "skip">;
}

async function loadForwardDiscordResult() {
  const mod = (await import("./start")) as unknown as StartModule;
  expect(typeof mod.forwardDiscordResult).toBe("function");
  if (typeof mod.forwardDiscordResult !== "function") {
    throw new Error("src/commands/start.ts must export forwardDiscordResult()");
  }
  return mod.forwardDiscordResult;
}

function success(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

describe("start discord forwarding regression", () => {
  test("statusChannelId forwards to the configured channel exactly once", async () => {
    const forwardDiscordResult = await loadForwardDiscordResult();
    const channelCalls: Array<{ channelId: string; text: string }> = [];
    const dmCalls: Array<{ userId: string; text: string }> = [];

    await forwardDiscordResult({
      allowedUserIds: ["user-1", "user-2"],
      label: "heartbeat",
      result: success("all green"),
      sendToChannel: async (channelId, text) => {
        channelCalls.push({ channelId, text });
      },
      sendToUser: async (userId, text) => {
        dmCalls.push({ userId, text });
      },
      statusChannelId: "channel-123",
    });

    expect(channelCalls).toEqual([{ channelId: "channel-123", text: "[heartbeat]\nall green" }]);
    expect(dmCalls).toEqual([]);
  });

  test("missing statusChannelId falls back to DMing every allowed user", async () => {
    const forwardDiscordResult = await loadForwardDiscordResult();
    const channelCalls: Array<{ channelId: string; text: string }> = [];
    const dmCalls: Array<{ userId: string; text: string }> = [];

    await forwardDiscordResult({
      allowedUserIds: ["user-1", "user-2"],
      label: "job/demo",
      result: success("done"),
      sendToChannel: async (channelId, text) => {
        channelCalls.push({ channelId, text });
      },
      sendToUser: async (userId, text) => {
        dmCalls.push({ userId, text });
      },
    });

    expect(channelCalls).toEqual([]);
    expect(dmCalls).toEqual([
      { userId: "user-1", text: "[job/demo]\ndone" },
      { userId: "user-2", text: "[job/demo]\ndone" },
    ]);
  });

  test("unavailable Discord delivery paths skip forwarding", async () => {
    const forwardDiscordResult = await loadForwardDiscordResult();
    const channelCalls: Array<{ channelId: string; text: string }> = [];
    const dmCalls: Array<{ userId: string; text: string }> = [];

    await Promise.resolve(
      forwardDiscordResult({
        allowedUserIds: [],
        label: "status",
        result: success("idle"),
        sendToChannel: async (channelId, text) => {
          channelCalls.push({ channelId, text });
        },
        sendToUser: async (userId, text) => {
          dmCalls.push({ userId, text });
        },
      })
    );

    expect(channelCalls).toEqual([]);
    expect(dmCalls).toEqual([]);
  });
});
