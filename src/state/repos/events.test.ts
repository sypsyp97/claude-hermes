import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { applyMigrations, closeDb, type Database, openDb } from "../index";
import { appendEvent, countEvents, listEvents } from "./events";

let db: Database;

beforeAll(async () => {
  db = openDb({ path: ":memory:" });
  await applyMigrations(db);
});

afterAll(() => {
  closeDb(db);
});

beforeEach(() => {
  db.exec("DELETE FROM learn_events");
});

describe("appendEvent", () => {
  test("returns a positive id and persists the row", () => {
    const id = appendEvent(db, "skill.promote", { name: "summarise" });
    expect(id).toBeGreaterThan(0);

    const rows = db
      .query<{ kind: string; payload_json: string }, []>(
        "SELECT kind, payload_json FROM learn_events ORDER BY id ASC"
      )
      .all();
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("skill.promote");
    expect(JSON.parse(rows[0].payload_json)).toEqual({ name: "summarise" });
  });

  test("round-trips JSON payloads of several shapes", () => {
    appendEvent(db, "obj", { a: 1, b: [2, 3], c: { d: "e" } });
    appendEvent(db, "arr", [1, 2, 3]);
    appendEvent(db, "str", "plain-string");
    appendEvent(db, "num", 42);
    appendEvent(db, "bool", true);

    const events = listEvents(db, { limit: 10 });
    const byKind = Object.fromEntries(events.map((e) => [e.kind, e.payload]));
    expect(byKind.obj).toEqual({ a: 1, b: [2, 3], c: { d: "e" } });
    expect(byKind.arr).toEqual([1, 2, 3]);
    expect(byKind.str).toBe("plain-string");
    expect(byKind.num).toBe(42);
    expect(byKind.bool).toBe(true);
  });

  test("null and undefined payloads fall back to {}", () => {
    appendEvent(db, "nullish", null);
    appendEvent(db, "undef", undefined);
    const events = listEvents(db, { limit: 10 });
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.payload).toEqual({});
    }
  });

  test("ids increase monotonically", () => {
    const a = appendEvent(db, "a", {});
    const b = appendEvent(db, "b", {});
    const c = appendEvent(db, "c", {});
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });
});

describe("listEvents", () => {
  test("returns empty array when table is empty", () => {
    expect(listEvents(db)).toEqual([]);
  });

  test("orders results by ts DESC and honours limit", () => {
    appendEvent(db, "k", { i: 1 });
    appendEvent(db, "k", { i: 2 });
    appendEvent(db, "k", { i: 3 });
    appendEvent(db, "k", { i: 4 });

    const all = listEvents<{ i: number }>(db);
    expect(all.length).toBe(4);
    // DESC order by ts (insert order) — newest first.
    expect(all[0].payload.i).toBe(4);
    expect(all[all.length - 1].payload.i).toBe(1);

    const limited = listEvents<{ i: number }>(db, { limit: 2 });
    expect(limited.length).toBe(2);
    expect(limited[0].payload.i).toBe(4);
  });

  test("kindPrefix filters with LIKE semantics", () => {
    appendEvent(db, "skill.promote", { n: "a" });
    appendEvent(db, "skill.demote", { n: "b" });
    appendEvent(db, "evolve.plan", { n: "c" });
    appendEvent(db, "skill", { n: "d" });

    const skillOnly = listEvents(db, { kindPrefix: "skill." });
    expect(skillOnly.map((e) => e.kind).sort()).toEqual(["skill.demote", "skill.promote"]);

    const skillBroad = listEvents(db, { kindPrefix: "skill" });
    expect(skillBroad.length).toBe(3);

    const noMatch = listEvents(db, { kindPrefix: "nope." });
    expect(noMatch).toEqual([]);
  });

  test("since filters rows by ts lower bound", () => {
    // Sneak older rows directly into the table with explicit timestamps so the
    // since filter has something meaningful to exclude.
    const oldTs = "2000-01-01T00:00:00.000Z";
    const newTs = "2099-12-31T00:00:00.000Z";
    db.prepare("INSERT INTO learn_events (ts, kind, payload_json) VALUES (?, ?, ?)").run(oldTs, "old", "{}");
    db.prepare("INSERT INTO learn_events (ts, kind, payload_json) VALUES (?, ?, ?)").run(newTs, "new", "{}");

    const recent = listEvents(db, { since: "2050-01-01T00:00:00.000Z" });
    expect(recent.map((e) => e.kind)).toEqual(["new"]);

    const ancient = listEvents(db, { since: "1990-01-01T00:00:00.000Z" });
    expect(ancient.map((e) => e.kind).sort()).toEqual(["new", "old"]);
  });

  test("combines kindPrefix and since filters", () => {
    const past = "2000-01-01T00:00:00.000Z";
    const future = "2099-12-31T00:00:00.000Z";
    db.prepare("INSERT INTO learn_events (ts, kind, payload_json) VALUES (?, ?, ?)").run(
      past,
      "skill.promote",
      "{}"
    );
    db.prepare("INSERT INTO learn_events (ts, kind, payload_json) VALUES (?, ?, ?)").run(
      future,
      "skill.promote",
      "{}"
    );
    db.prepare("INSERT INTO learn_events (ts, kind, payload_json) VALUES (?, ?, ?)").run(
      future,
      "evolve.plan",
      "{}"
    );

    const filtered = listEvents(db, { kindPrefix: "skill.", since: "2050-01-01T00:00:00.000Z" });
    expect(filtered.length).toBe(1);
    expect(filtered[0].kind).toBe("skill.promote");
    expect(filtered[0].ts).toBe(future);
  });
});

describe("countEvents", () => {
  test("returns 0 on empty table", () => {
    expect(countEvents(db)).toBe(0);
  });

  test("counts all rows without filters", () => {
    appendEvent(db, "a", {});
    appendEvent(db, "b", {});
    appendEvent(db, "c", {});
    expect(countEvents(db)).toBe(3);
  });

  test("counts by kindPrefix", () => {
    appendEvent(db, "skill.promote", {});
    appendEvent(db, "skill.demote", {});
    appendEvent(db, "evolve.plan", {});
    expect(countEvents(db, { kindPrefix: "skill." })).toBe(2);
    expect(countEvents(db, { kindPrefix: "evolve." })).toBe(1);
    expect(countEvents(db, { kindPrefix: "missing." })).toBe(0);
  });

  test("counts by since", () => {
    const past = "2000-01-01T00:00:00.000Z";
    const future = "2099-12-31T00:00:00.000Z";
    db.prepare("INSERT INTO learn_events (ts, kind, payload_json) VALUES (?, ?, ?)").run(past, "a", "{}");
    db.prepare("INSERT INTO learn_events (ts, kind, payload_json) VALUES (?, ?, ?)").run(future, "b", "{}");
    expect(countEvents(db, { since: "2050-01-01T00:00:00.000Z" })).toBe(1);
  });
});
