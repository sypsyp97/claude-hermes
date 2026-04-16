import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { applyMigrations, closeDb, openDb, policiesRepo, type Database } from "../../state";
import { resolveDiscordPolicy } from "./channel-policy";

let db: Database;

beforeAll(async () => {
  db = openDb({ path: ":memory:" });
  await applyMigrations(db);
});

afterAll(() => {
  closeDb(db);
});

describe("resolveDiscordPolicy", () => {
  test("DM defaults to per-user + user memory", () => {
    const policy = resolveDiscordPolicy(db, { isDm: true });
    expect(policy.sessionScope).toBe("per-user");
    expect(policy.memoryScope).toBe("user");
    expect(policy.deliveryRole).toBe("interactive");
  });

  test("plain server channel defaults to per-channel-user + channel memory", () => {
    const policy = resolveDiscordPolicy(db, {
      guild: "G1",
      channel: "C1",
      channelName: "general",
    });
    expect(policy.sessionScope).toBe("per-channel-user");
    expect(policy.memoryScope).toBe("channel");
    expect(policy.mode).toBe("mention");
  });

  test("ask-* channel gets free-response mode", () => {
    const policy = resolveDiscordPolicy(db, {
      guild: "G1",
      channel: "Cask",
      channelName: "ask-hermes",
    });
    expect(policy.mode).toBe("free-response");
  });

  test("delivery-* channel disables interactive replies", () => {
    const policy = resolveDiscordPolicy(db, {
      guild: "G1",
      channel: "Cdel",
      channelName: "deliver-hermes",
    });
    expect(policy.deliveryRole).toBe("delivery");
    expect(policy.mode).toBe("delivery-only");
  });

  test("DB override wins over name-based defaults", () => {
    policiesRepo.upsertPolicy(
      db,
      { source: "discord", guild: "G1", channel: "Cmix" },
      { mode: "listen", sessionScope: "per-thread", allowedSkills: ["summarise"] }
    );
    const policy = resolveDiscordPolicy(db, {
      guild: "G1",
      channel: "Cmix",
      channelName: "random",
    });
    expect(policy.mode).toBe("listen");
    expect(policy.sessionScope).toBe("per-thread");
    expect(policy.allowedSkills).toEqual(["summarise"]);
  });
});
