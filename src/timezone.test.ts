import { describe, expect, test } from "bun:test";
import {
  buildClockPromptPrefix,
  clampTimezoneOffsetMinutes,
  formatUtcOffsetLabel,
  getDayAndMinuteAtOffset,
  normalizeTimezoneName,
  parseUtcOffsetMinutes,
  resolveTimezoneOffsetMinutes,
  shiftDateToOffset,
} from "./timezone";

describe("parseUtcOffsetMinutes", () => {
  test("accepts UTC and GMT aliases", () => {
    expect(parseUtcOffsetMinutes("UTC")).toBe(0);
    expect(parseUtcOffsetMinutes(" gmt ")).toBe(0);
  });

  test("handles positive and negative offsets with and without colon", () => {
    expect(parseUtcOffsetMinutes("UTC+8")).toBe(8 * 60);
    expect(parseUtcOffsetMinutes("UTC-5:30")).toBe(-(5 * 60 + 30));
    expect(parseUtcOffsetMinutes("GMT+0530")).toBe(5 * 60 + 30);
  });

  test("rejects malformed inputs and hours > 14", () => {
    expect(parseUtcOffsetMinutes("GMT+15")).toBeNull();
    expect(parseUtcOffsetMinutes("Asia/Tokyo")).toBeNull();
    expect(parseUtcOffsetMinutes(42 as unknown as string)).toBeNull();
  });
});

describe("clampTimezoneOffsetMinutes", () => {
  test("clamps above +14h and below -12h", () => {
    expect(clampTimezoneOffsetMinutes(999)).toBe(14 * 60);
    expect(clampTimezoneOffsetMinutes(-999)).toBe(-12 * 60);
  });

  test("rounds non-integers and returns 0 for non-finite", () => {
    expect(clampTimezoneOffsetMinutes(60.4)).toBe(60);
    expect(clampTimezoneOffsetMinutes(Number.NaN)).toBe(0);
  });
});

describe("normalizeTimezoneName", () => {
  test("returns normalized UTC-offset form", () => {
    expect(normalizeTimezoneName("utc+8")).toBe("UTC+8");
    expect(normalizeTimezoneName("  gmt-05:30 ")).toBe("GMT-05:30");
  });

  test("returns original IANA name if Intl accepts it", () => {
    expect(normalizeTimezoneName("Europe/Berlin")).toBe("Europe/Berlin");
  });

  test("returns empty string for garbage", () => {
    expect(normalizeTimezoneName("not-a-tz")).toBe("");
    expect(normalizeTimezoneName(undefined)).toBe("");
  });
});

describe("resolveTimezoneOffsetMinutes", () => {
  test("prefers explicit numeric value", () => {
    expect(resolveTimezoneOffsetMinutes(120)).toBe(120);
    expect(resolveTimezoneOffsetMinutes("90")).toBe(90);
  });

  test("falls back to UTC-offset string", () => {
    expect(resolveTimezoneOffsetMinutes(undefined, "UTC+02:00")).toBe(120);
  });

  test("returns 0 when all fallbacks fail", () => {
    expect(resolveTimezoneOffsetMinutes(undefined, "nope")).toBe(0);
  });
});

describe("shiftDateToOffset", () => {
  test("adds the offset minutes", () => {
    const d = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    const shifted = shiftDateToOffset(d, 180);
    expect(shifted.getTime() - d.getTime()).toBe(180 * 60_000);
  });
});

describe("formatUtcOffsetLabel", () => {
  test("omits minutes when zero", () => {
    expect(formatUtcOffsetLabel(8 * 60)).toBe("UTC+8");
    expect(formatUtcOffsetLabel(-5 * 60)).toBe("UTC-5");
  });

  test("prints minutes when non-zero", () => {
    expect(formatUtcOffsetLabel(330)).toBe("UTC+5:30");
  });
});

describe("buildClockPromptPrefix", () => {
  test("formats timestamp with offset label", () => {
    const d = new Date(Date.UTC(2026, 3, 16, 12, 34, 56));
    expect(buildClockPromptPrefix(d, 0)).toBe("[2026-04-16 12:34:56 UTC+0]");
    expect(buildClockPromptPrefix(d, 120)).toBe("[2026-04-16 14:34:56 UTC+2]");
  });
});

describe("getDayAndMinuteAtOffset", () => {
  test("returns UTC day + minute shifted by offset", () => {
    const d = new Date(Date.UTC(2026, 3, 16, 23, 0, 0)); // Thu 23:00 UTC
    const { day, minute } = getDayAndMinuteAtOffset(d, 120); // UTC+2 -> Fri 01:00
    expect(day).toBe(5);
    expect(minute).toBe(60);
  });
});
