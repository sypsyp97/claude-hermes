import { describe, expect, test } from "bun:test";
import { type ChannelPolicy, defaultPolicy, deliveryPolicy, listenPolicy, mergePolicy } from "./channel";

describe("defaultPolicy", () => {
  test("DM default is per-user with user memory scope", () => {
    const p = defaultPolicy({ source: "discord", isDm: true });
    expect(p.mode).toBe("mention");
    expect(p.sessionScope).toBe("per-user");
    expect(p.memoryScope).toBe("user");
    expect(p.autoThread).toBe(false);
    expect(p.deliveryRole).toBe("interactive");
    expect(p.allowedSkills).toBe("*");
  });

  test("server default is per-channel-user with channel memory scope", () => {
    const p = defaultPolicy({ source: "discord", guild: "g1", channel: "c1" });
    expect(p.mode).toBe("mention");
    expect(p.sessionScope).toBe("per-channel-user");
    expect(p.memoryScope).toBe("channel");
    expect(p.autoThread).toBe(false);
    expect(p.deliveryRole).toBe("interactive");
  });

  test("returns a fresh copy each call (no shared references)", () => {
    const a = defaultPolicy({ source: "discord", isDm: true });
    const b = defaultPolicy({ source: "discord", isDm: true });
    expect(a).not.toBe(b); // different object identities
    a.mode = "listen";
    expect(b.mode).toBe("mention");
  });

  test("isDm=false falls to server default regardless of source", () => {
    const tg = defaultPolicy({ source: "telegram", isDm: false });
    expect(tg.sessionScope).toBe("per-channel-user");
    const web = defaultPolicy({ source: "web" });
    expect(web.sessionScope).toBe("per-channel-user");
  });

  test("isDm=true wins over channel/guild fields", () => {
    const p = defaultPolicy({ source: "telegram", isDm: true, guild: "g", channel: "c" });
    expect(p.sessionScope).toBe("per-user");
    expect(p.memoryScope).toBe("user");
  });
});

describe("listenPolicy / deliveryPolicy", () => {
  test("listenPolicy has mode=free-response", () => {
    const p = listenPolicy();
    expect(p.mode).toBe("free-response");
    expect(p.sessionScope).toBe("per-channel-user");
    expect(p.memoryScope).toBe("channel");
    expect(p.deliveryRole).toBe("interactive");
    expect(p.allowedSkills).toBe("*");
  });

  test("deliveryPolicy locks down skills and memory", () => {
    const p = deliveryPolicy();
    expect(p.mode).toBe("delivery-only");
    expect(p.sessionScope).toBe("shared");
    expect(p.memoryScope).toBe("none");
    expect(p.deliveryRole).toBe("delivery");
    expect(p.allowedSkills).toEqual([]);
  });

  test("each call returns a fresh top-level object (shallow)", () => {
    const a = listenPolicy();
    const b = listenPolicy();
    expect(a).not.toBe(b);
    a.mode = "mention";
    expect(b.mode).toBe("free-response");

    const d1 = deliveryPolicy();
    const d2 = deliveryPolicy();
    expect(d1).not.toBe(d2);
    // Note: nested arrays (e.g. allowedSkills) are shared by reference because
    // the helpers use a shallow spread. That's a production-code observation,
    // not asserted here — we only verify top-level independence.
    d1.mode = "mention";
    expect(d2.mode).toBe("delivery-only");
  });
});

describe("mergePolicy", () => {
  test("override wins field-by-field, base untouched", () => {
    const base = defaultPolicy({ source: "discord", isDm: true });
    const merged = mergePolicy(base, { mode: "listen", autoThread: true });
    expect(merged.mode).toBe("listen");
    expect(merged.autoThread).toBe(true);
    // Untouched fields carry over.
    expect(merged.sessionScope).toBe(base.sessionScope);
    expect(merged.memoryScope).toBe(base.memoryScope);

    // Base is not mutated.
    expect(base.mode).toBe("mention");
    expect(base.autoThread).toBe(false);
  });

  test("empty override returns an equivalent but independent object", () => {
    const base = listenPolicy();
    const merged = mergePolicy(base, {});
    expect(merged).toEqual(base);
    expect(merged).not.toBe(base);
  });

  test("can override allowedSkills to a concrete list", () => {
    const base = listenPolicy();
    const merged = mergePolicy(base, { allowedSkills: ["summarise"] });
    expect(merged.allowedSkills).toEqual(["summarise"]);
    expect(base.allowedSkills).toBe("*");
  });

  test("modelPolicy override carries nested model + fallback", () => {
    const base: ChannelPolicy = listenPolicy();
    const merged = mergePolicy(base, { modelPolicy: { model: "opus-4", fallback: "sonnet-4" } });
    expect(merged.modelPolicy?.model).toBe("opus-4");
    expect(merged.modelPolicy?.fallback).toBe("sonnet-4");
    expect(base.modelPolicy).toBeUndefined();
  });

  test("deliveryRole can be flipped via override", () => {
    const base = listenPolicy();
    const merged = mergePolicy(base, { deliveryRole: "delivery" });
    expect(merged.deliveryRole).toBe("delivery");
    expect(base.deliveryRole).toBe("interactive");
  });
});
