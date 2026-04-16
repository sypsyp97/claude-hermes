import { describe, expect, test } from "bun:test";
import type { Envelope } from "./envelope";
import { route, type RouteEnv } from "./route";

function baseEnvelope(overrides: Partial<Envelope> = {}): Envelope {
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

function makeEnv(overrides: Partial<RouteEnv> = {}): RouteEnv {
  return {
    auth: { allowedUserIds: [] },
    defaultAllowedTools: ["Read", "Edit", "Write", "Bash", "Grep"],
    policyFor: () => ({
      sessionScope: "per-user",
      allowedTools: "*",
      memoryScope: "user",
    }),
    promptLayers: () => ["SOUL", "IDENTITY"],
    ...overrides,
  };
}

describe("route", () => {
  test("denies when user not in non-empty allowlist", () => {
    const env = makeEnv({ auth: { allowedUserIds: ["admin"] } });
    const result = route(baseEnvelope(), env);
    expect(result.auth.allow).toBe(false);
    expect(result.auth.reason).toBe("user-not-in-allowlist");
  });

  test("allows admins regardless of allowlist", () => {
    const env = makeEnv({
      auth: { allowedUserIds: ["someone-else"], allowedAdmins: ["U1"] },
    });
    const result = route(baseEnvelope(), env);
    expect(result.auth.allow).toBe(true);
    expect(result.auth.isAdmin).toBe(true);
  });

  test("intersects channel tool allowlist with global default", () => {
    const env = makeEnv({
      policyFor: () => ({
        sessionScope: "per-user",
        allowedTools: ["Read", "Bash", "NoSuchTool"],
        memoryScope: "user",
      }),
    });
    const result = route(baseEnvelope(), env);
    expect(result.decision.allowedTools.sort()).toEqual(["Bash", "Read"]);
  });

  test("wildcard policy passes through default tools", () => {
    const env = makeEnv();
    const result = route(baseEnvelope(), env);
    expect(result.decision.allowedTools).toContain("Write");
    expect(result.decision.allowedTools).toContain("Edit");
  });

  test("policy model overrides default", () => {
    const env = makeEnv({
      defaultModel: "sonnet",
      defaultFallbackModel: "haiku",
      policyFor: () => ({
        sessionScope: "per-user",
        allowedTools: "*",
        memoryScope: "user",
        model: "opus",
      }),
    });
    const result = route(baseEnvelope(), env);
    expect(result.decision.model).toBe("opus");
    expect(result.decision.fallbackModel).toBe("haiku");
  });

  test("session key reflects policy scope", () => {
    const env = makeEnv({
      policyFor: () => ({
        sessionScope: "per-channel-user",
        allowedTools: "*",
        memoryScope: "channel",
      }),
    });
    const result = route(baseEnvelope({ guild: "G", channel: "C" }), env);
    expect(result.decision.sessionKey).toBe("channel-user:discord:G:C:U1");
    expect(result.decision.sessionScope).toBe("per-channel-user");
  });

  test("prompt layers are composed in caller-specified order", () => {
    const env = makeEnv({
      promptLayers: () => ["SOUL", "IDENTITY", "USER", "MEMORY", "CHANNEL"],
    });
    const result = route(baseEnvelope(), env);
    expect(result.decision.systemPromptLayers).toEqual(["SOUL", "IDENTITY", "USER", "MEMORY", "CHANNEL"]);
  });
});
