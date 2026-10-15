import { describe, expect, test } from "bun:test";
import { CronParseError, cronMatches, matchesBetween, nextCronMatch, parseCron } from "./cron";

describe("cronMatches - exact minute/hour", () => {
  test("matches 12:30:00 UTC for '30 12 * * *'", () => {
    const d = new Date(Date.UTC(2026, 3, 16, 12, 30, 0));
    expect(cronMatches("30 12 * * *", d)).toBe(true);
  });

  test("does not match 12:29 for '30 12 * * *'", () => {
    const d = new Date(Date.UTC(2026, 3, 16, 12, 29, 0));
    expect(cronMatches("30 12 * * *", d)).toBe(false);
  });

  test("does not match 13:30 for '30 12 * * *'", () => {
    const d = new Date(Date.UTC(2026, 3, 16, 13, 30, 0));
    expect(cronMatches("30 12 * * *", d)).toBe(false);
  });
});

describe("cronMatches - star field", () => {
  test("'* * * * *' matches arbitrary times", () => {
    const a = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    const b = new Date(Date.UTC(2026, 6, 15, 7, 42, 0));
    const c = new Date(Date.UTC(2026, 11, 31, 23, 59, 0));
    expect(cronMatches("* * * * *", a)).toBe(true);
    expect(cronMatches("* * * * *", b)).toBe(true);
    expect(cronMatches("* * * * *", c)).toBe(true);
  });
});

describe("cronMatches - step values in star", () => {
  test("'*/15 * * * *' matches 00, 15, 30, 45", () => {
    for (const minute of [0, 15, 30, 45]) {
      const d = new Date(Date.UTC(2026, 3, 16, 10, minute, 0));
      expect(cronMatches("*/15 * * * *", d)).toBe(true);
    }
  });

  test("'*/15 * * * *' does not match 7 or 22", () => {
    const d7 = new Date(Date.UTC(2026, 3, 16, 10, 7, 0));
    const d22 = new Date(Date.UTC(2026, 3, 16, 10, 22, 0));
    expect(cronMatches("*/15 * * * *", d7)).toBe(false);
    expect(cronMatches("*/15 * * * *", d22)).toBe(false);
  });
});

describe("cronMatches - range with step", () => {
  test("'10-50/10 * * * *' matches 10,20,30,40,50", () => {
    for (const minute of [10, 20, 30, 40, 50]) {
      const d = new Date(Date.UTC(2026, 3, 16, 10, minute, 0));
      expect(cronMatches("10-50/10 * * * *", d)).toBe(true);
    }
  });

  test("'10-50/10 * * * *' does not match 0 or 5", () => {
    const d0 = new Date(Date.UTC(2026, 3, 16, 10, 0, 0));
    const d5 = new Date(Date.UTC(2026, 3, 16, 10, 5, 0));
    expect(cronMatches("10-50/10 * * * *", d0)).toBe(false);
    expect(cronMatches("10-50/10 * * * *", d5)).toBe(false);
  });
});

describe("cronMatches - comma list", () => {
  test("'0,30 * * * *' matches 0 and 30", () => {
    const d0 = new Date(Date.UTC(2026, 3, 16, 10, 0, 0));
    const d30 = new Date(Date.UTC(2026, 3, 16, 10, 30, 0));
    expect(cronMatches("0,30 * * * *", d0)).toBe(true);
    expect(cronMatches("0,30 * * * *", d30)).toBe(true);
  });

  test("'0,30 * * * *' does not match 15", () => {
    const d15 = new Date(Date.UTC(2026, 3, 16, 10, 15, 0));
    expect(cronMatches("0,30 * * * *", d15)).toBe(false);
  });
});

describe("cronMatches - day-of-week field", () => {
  test("'0 9 * * 1' matches Monday 09:00 only", () => {
    // 2026-04-13 is a Monday
    const monday = new Date(Date.UTC(2026, 3, 13, 9, 0, 0));
    expect(cronMatches("0 9 * * 1", monday)).toBe(true);

    // 2026-04-14 is a Tuesday
    const tuesday = new Date(Date.UTC(2026, 3, 14, 9, 0, 0));
    expect(cronMatches("0 9 * * 1", tuesday)).toBe(false);

    // Same Monday at the wrong hour
    const mondayWrongHour = new Date(Date.UTC(2026, 3, 13, 10, 0, 0));
    expect(cronMatches("0 9 * * 1", mondayWrongHour)).toBe(false);
  });
});

describe("cronMatches - day-of-month field", () => {
  test("'0 0 15 * *' matches the 15th of any month", () => {
    const jan15 = new Date(Date.UTC(2026, 0, 15, 0, 0, 0));
    const jul15 = new Date(Date.UTC(2026, 6, 15, 0, 0, 0));
    expect(cronMatches("0 0 15 * *", jan15)).toBe(true);
    expect(cronMatches("0 0 15 * *", jul15)).toBe(true);

    const jan16 = new Date(Date.UTC(2026, 0, 16, 0, 0, 0));
    expect(cronMatches("0 0 15 * *", jan16)).toBe(false);
  });
});

describe("cronMatches - month field", () => {
  test("'0 0 1 6 *' matches June 1st only", () => {
    const jun1 = new Date(Date.UTC(2026, 5, 1, 0, 0, 0));
    expect(cronMatches("0 0 1 6 *", jun1)).toBe(true);

    const may1 = new Date(Date.UTC(2026, 4, 1, 0, 0, 0));
    expect(cronMatches("0 0 1 6 *", may1)).toBe(false);

    const jun2 = new Date(Date.UTC(2026, 5, 2, 0, 0, 0));
    expect(cronMatches("0 0 1 6 *", jun2)).toBe(false);
  });
});

describe("cronMatches - timezone shift", () => {
  test("with offset +120min, '0 10 * * *' matches 08:00 UTC", () => {
    const d = new Date(Date.UTC(2026, 3, 16, 8, 0, 0));
    expect(cronMatches("0 10 * * *", d, 120)).toBe(true);
  });

  test("with offset +120min, '0 10 * * *' does not match 10:00 UTC", () => {
    const d = new Date(Date.UTC(2026, 3, 16, 10, 0, 0));
    expect(cronMatches("0 10 * * *", d, 120)).toBe(false);
  });
});

describe("nextCronMatch", () => {
  test("midnight daily after 2026-04-16T12:00:00Z yields 2026-04-17T00:00:00Z", () => {
    const start = new Date(Date.UTC(2026, 3, 16, 12, 0, 0));
    const next = nextCronMatch("0 0 * * *", start);
    expect(next?.toISOString()).toBe("2026-04-17T00:00:00.000Z");
  });

  test("midnight daily in UTC-5 after 2026-04-16T12:00:00Z yields 2026-04-17T05:00:00Z", () => {
    const start = new Date(Date.UTC(2026, 3, 16, 12, 0, 0));
    const next = nextCronMatch("0 0 * * *", start, -300);
    expect(next?.toISOString()).toBe("2026-04-17T05:00:00.000Z");
  });

  test("monthly '0 0 1 * *' at 2026-04-16T12:00 yields 2026-05-01T00:00 (beyond old 48h window)", () => {
    const start = new Date(Date.UTC(2026, 3, 16, 12, 0, 0));
    const next = nextCronMatch("0 0 1 * *", start);
    expect(next?.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });

  test("yearly '0 0 1 1 *' at 2026-04-16T12:00 yields 2027-01-01T00:00", () => {
    const start = new Date(Date.UTC(2026, 3, 16, 12, 0, 0));
    const next = nextCronMatch("0 0 1 1 *", start);
    expect(next?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  test("unsatisfiable schedule returns null, not an arbitrary date", () => {
    // Hour 25 is never valid — parseCron will reject, so nextCronMatch throws.
    // For a genuinely unsatisfiable but syntactically-valid expression use
    // day-30 in February: '0 0 30 2 *' matches nothing.
    const start = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    const next = nextCronMatch("0 0 30 2 *", start);
    expect(next).toBeNull();
  });
});

describe("parseCron", () => {
  test("accepts a valid 5-field expression", () => {
    const fields = parseCron("30 12 * * *");
    expect(fields).toBeDefined();
  });

  test("throws CronParseError on 4 fields", () => {
    expect(() => parseCron("30 12 * *")).toThrow(CronParseError);
  });

  test("throws CronParseError on 6 fields", () => {
    expect(() => parseCron("* 30 12 * * *")).toThrow(CronParseError);
  });

  test("throws CronParseError on hour 25", () => {
    expect(() => parseCron("0 25 * * *")).toThrow(CronParseError);
  });

  test("throws CronParseError on minute 60", () => {
    expect(() => parseCron("60 0 * * *")).toThrow(CronParseError);
  });

  test("throws CronParseError on day-of-month 0", () => {
    expect(() => parseCron("0 0 0 * *")).toThrow(CronParseError);
  });

  test("throws CronParseError on month 13", () => {
    expect(() => parseCron("0 0 1 13 *")).toThrow(CronParseError);
  });

  test("throws CronParseError on day-of-week 7 (valid range is 0-6)", () => {
    expect(() => parseCron("0 0 * * 7")).toThrow(CronParseError);
  });

  test("throws CronParseError on garbage inside a field", () => {
    expect(() => parseCron("abc * * * *")).toThrow(CronParseError);
  });

  test("accepts step in every numeric field", () => {
    expect(() => parseCron("*/5 */2 * * *")).not.toThrow();
  });

  test("throws CronParseError on empty string", () => {
    expect(() => parseCron("")).toThrow(CronParseError);
  });

  test("throws CronParseError on pure whitespace", () => {
    expect(() => parseCron("   \t  ")).toThrow(CronParseError);
  });
});

describe("cronMatches surface does not crash on invalid input", () => {
  test("cronMatches returns false (not throws) on a malformed expression", () => {
    // Old code threw TypeError because splitting undefined fields.
    // New contract: cronMatches swallows and returns false so callers never
    // blow up statusline/updateState.
    const d = new Date(Date.UTC(2026, 3, 16, 0, 0, 0));
    expect(cronMatches("not a cron", d)).toBe(false);
  });

  test("nextCronMatch throws on malformed expression (caller must validate)", () => {
    // Scheduler entry-point validates via parseCron; nextCronMatch is allowed
    // to throw so bad configs surface loudly instead of silently drifting.
    const d = new Date(Date.UTC(2026, 3, 16, 0, 0, 0));
    expect(() => nextCronMatch("nope", d)).toThrow(CronParseError);
  });
});

describe("matchesBetween — catch-up window", () => {
  test("returns every minute that matches between (from, to]", () => {
    // Every 15 minutes between 10:00 (exclusive) and 10:45 (inclusive).
    const from = new Date(Date.UTC(2026, 3, 16, 10, 0, 0));
    const to = new Date(Date.UTC(2026, 3, 16, 10, 45, 0));
    const hits = matchesBetween("*/15 * * * *", from, to);
    expect(hits.map((d) => d.toISOString())).toEqual([
      "2026-04-16T10:15:00.000Z",
      "2026-04-16T10:30:00.000Z",
      "2026-04-16T10:45:00.000Z",
    ]);
  });

  test("returns an empty array if from >= to", () => {
    const t = new Date(Date.UTC(2026, 3, 16, 10, 0, 0));
    expect(matchesBetween("* * * * *", t, t)).toEqual([]);
  });

  test("caps the scan at ~24h to protect against clock-skew abuse", () => {
    const from = new Date(Date.UTC(2026, 3, 16, 10, 0, 0));
    const to = new Date(Date.UTC(2027, 3, 16, 10, 0, 0)); // 1 year later
    const hits = matchesBetween("* * * * *", from, to);
    // Should not return 525k results; hard cap keeps it safe.
    expect(hits.length).toBeLessThanOrEqual(24 * 60 + 1);
  });
});

describe("cron grammar boundaries", () => {
  for (const minute of ["*/2/3", "1-2-3", "1/2/3", `*/${"9".repeat(400)}`]) {
    test(`rejects malformed minute ${minute.slice(0, 24)}`, () => {
      expect(() => parseCron(`${minute} * * * *`)).toThrow(CronParseError);
      expect(cronMatches(`${minute} * * * *`, new Date("2026-01-01T00:00:00Z"))).toBe(false);
    });
  }
});

test("cron iteration uses absolute minutes across host DST fall-back", () => {
  const script = `import {nextCronMatch,matchesBetween} from ${JSON.stringify(import.meta.dir + "/cron.ts")};
    const from = new Date("2026-11-01T05:59:00Z");
    console.log(JSON.stringify([nextCronMatch("* * * * *",from),matchesBetween("* * * * *",from,new Date("2026-11-01T06:01:00Z"))]));`;
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    env: { ...process.env, TZ: "America/New_York" },
  });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual([
    "2026-11-01T06:00:00.000Z",
    ["2026-11-01T06:00:00.000Z", "2026-11-01T06:01:00.000Z"],
  ]);
});

test("compiled scan membership matches individual evaluation over offset calendars", () => {
  const from = new Date("2026-04-13T00:00:00Z");
  const to = new Date("2026-04-14T00:00:00Z");
  for (const expr of ["*/7 * * * *", "1,17,59 2-22/3 * * *", "0 0 13-15 4 1-5", "*/10 9-17 * * 1-5"]) {
    for (const offset of [-330, 0, 345]) {
      const expected: number[] = [];
      for (let time = +from + 60_000; time <= +to; time += 60_000) {
        if (cronMatches(expr, new Date(time), offset)) expected.push(time);
      }
      expect(matchesBetween(expr, from, to, offset).map(Number)).toEqual(expected);
    }
  }
});

describe("cron calendar field semantics", () => {
  // Cronie treats * as the field's full range, whose lower bound is 1 here.
  for (const [field, wildcard, range, count] of [
    ["month", "0 0 1 */2 *", "0 0 1 1-12/2 *", 12],
    ["day of month", "0 0 */2 * *", "0 0 1-31/2 * *", 31],
  ] as const) {
    test(`${field} wildcard steps originate at 1, like an explicit range`, () => {
      for (let value = 1; value <= count; value++) {
        const date =
          field === "month" ? new Date(Date.UTC(2026, value - 1, 1)) : new Date(Date.UTC(2026, 4, value));
        expect(cronMatches(range, date)).toBe(value % 2 === 1);
        expect(cronMatches(wildcard, date)).toBe(value % 2 === 1);
      }
    });
  }

  // The STAR flag follows the first character, including */n and lists.
  // A full numeric range has no STAR flag; restricted DOM/DOW use OR.
  const cases = [
    ["0 0 1 * 1", "2026-04-13T00:00:00Z", true],
    ["0 0 1 * 1", "2026-04-01T00:00:00Z", true],
    ["0 0 1 * 1", "2026-04-14T00:00:00Z", false],
    ["0 0 1 5 1", "2026-04-13T00:00:00Z", false],
    ["1 0 1 * 1", "2026-04-13T00:00:00Z", false],
    ["0 1 1 * 1", "2026-04-13T00:00:00Z", false],
    ["0 0 * * 1", "2026-05-03T00:00:00Z", false],
    ["0 0 1 * *", "2026-05-04T00:00:00Z", false],
    ["0 0 */2 * 1", "2026-05-04T00:00:00Z", false],
    ["0 0 */2 * 1", "2026-05-11T00:00:00Z", true],
    ["0 0 */2 * 1", "2026-05-03T00:00:00Z", false],
    ["0 0 1 * */2", "2026-05-01T00:00:00Z", false],
    ["0 0 1 * */2", "2026-09-01T00:00:00Z", true],
    ["0 0 1 * */2", "2026-09-03T00:00:00Z", false],
    ["0 0 1-31 * 1", "2026-05-05T00:00:00Z", true],
    ["0 0 1,*/2 * 1", "2026-05-04T00:00:00Z", true],
    ["0 0 1,*/2 * 1", "2026-05-03T00:00:00Z", true],
    ["0 0 */2,2 * 1", "2026-05-03T00:00:00Z", false],
    ["0 0 */2,2 * 1", "2026-05-04T00:00:00Z", false],
    ["0 0 1 * 1,*/2", "2026-05-04T00:00:00Z", true],
    ["0 0 1 * 1,*/2", "2026-05-05T00:00:00Z", true],
    ["0 0 1 * */2,1", "2026-05-04T00:00:00Z", false],
    ["0 0 1 * */2,1", "2026-06-01T00:00:00Z", true],
    ["0 0 */2 * *", "2026-05-01T00:00:00Z", true],
    ["0 0 1 */2 *", "2026-03-01T00:00:00Z", true],
  ] as const;

  for (const [expr, localTime, expected] of cases) {
    test(`${expr} at ${localTime} is ${expected} across all matching paths`, () => {
      for (const offset of [-330, 0, 345]) {
        const date = new Date(Date.parse(localTime) - offset * 60_000);
        const fields = parseCron(expr);
        for (const input of [expr, fields]) {
          const next = nextCronMatch(input, new Date(+date - 60_000), offset);
          expect({
            direct: cronMatches(input, date, offset),
            shortScan: matchesBetween(input, new Date(+date - 60_000), date, offset).map(Number),
            compiledScan: matchesBetween(input, new Date(+date - 20 * 60_000), date, offset).map(Number),
            nextIsCandidate: next?.getTime() === +date,
          }).toEqual({
            direct: expected,
            shortScan: expected ? [+date] : [],
            compiledScan: expected ? [+date] : [],
            nextIsCandidate: expected,
          });
        }
      }
    });
  }
});

describe("matchesBetween newest 24-hour catch-up window", () => {
  // start.ts dispatches once when hits.length > 0, coalescing missed slots.
  // These tests pin the slots without starting a daemon or external services.
  for (const from of ["2026-04-15T10:00:00Z", "2026-04-15T09:59:00Z", "2025-04-16T10:00:00Z"]) {
    for (const to of ["2026-04-16T10:00:00Z", "2026-04-16T10:00:30Z"]) {
      test(`returns at most 1440 newest slots in (${from}, ${to}]`, () => {
        const hits = matchesBetween("* * * * *", new Date(from), new Date(to));
        expect(hits).toHaveLength(1440);
        expect(hits[0].toISOString()).toBe("2026-04-15T10:01:00.000Z");
        expect(hits.at(-1)?.toISOString()).toBe("2026-04-16T10:00:00.000Z");
        expect(new Set(hits.map(Number)).size).toBe(hits.length);
      });
    }
  }

  test("excludes from and includes to only at complete minute boundaries", () => {
    const expr = "* * * * *";
    const iso = (from: string, to: string) => matchesBetween(expr, new Date(from), new Date(to)).map(Number);
    const start = Date.parse("2026-04-16T10:00:00Z");
    expect(iso("2026-04-16T10:00:00Z", "2026-04-16T10:01:00Z")).toEqual([start + 60_000]);
    expect(iso("2026-04-16T10:00:30Z", "2026-04-16T10:01:00Z")).toEqual([start + 60_000]);
    expect(iso("2026-04-16T10:00:00Z", "2026-04-16T10:00:59.999Z")).toEqual([]);
    expect(iso("2026-04-16T09:59:59.999Z", "2026-04-16T10:00:00Z")).toEqual([start]);
    expect(iso("2026-04-16T10:01:00Z", "2026-04-16T10:00:00Z")).toEqual([]);
  });

  for (const [offset, expected] of [
    [345, "2026-04-15T18:15:00.000Z"],
    [-330, "2026-04-15T05:30:00.000Z"],
  ] as const) {
    test(`keeps UTC window bounds while matching local midnight at offset ${offset}`, () => {
      const hits = matchesBetween(
        "0 0 * * *",
        new Date("2026-04-13T00:00:00Z"),
        new Date("2026-04-16T00:00:00Z"),
        offset
      );
      expect(hits.map((date) => date.toISOString())).toEqual([expected]);
    });
  }
});
