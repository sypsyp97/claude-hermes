import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { applyMigrations, closeDb, type Database, openDb } from "../index";
import { finishRun, listRuns, startRun, statsFor, statsSinceRunId } from "./skillRuns";

let db: Database;

beforeAll(async () => {
  db = openDb({ path: ":memory:" });
  await applyMigrations(db);
});

afterAll(() => {
  closeDb(db);
});

beforeEach(() => {
  db.exec("DELETE FROM skill_runs");
});

describe("startRun", () => {
  test("inserts with defaults and returns a positive id", () => {
    const id = startRun(db, { skillName: "summarise", version: 1 });
    expect(id).toBeGreaterThan(0);

    const rows = db
      .query<
        { skill_name: string; version: number; session_id: number | null; tools_used_json: string | null },
        []
      >("SELECT skill_name, version, session_id, tools_used_json FROM skill_runs")
      .all();
    expect(rows.length).toBe(1);
    expect(rows[0].skill_name).toBe("summarise");
    expect(rows[0].version).toBe(1);
    expect(rows[0].session_id).toBeNull();
    expect(rows[0].tools_used_json).toBeNull();
  });

  test("sessionId=null stays null", () => {
    startRun(db, { skillName: "x", version: 1, sessionId: null });
    const row = db.query<{ session_id: number | null }, []>("SELECT session_id FROM skill_runs").get();
    expect(row?.session_id).toBeNull();
  });

  test("toolsUsed round-trips as JSON", () => {
    startRun(db, { skillName: "y", version: 2, toolsUsed: ["Bash", "Read", "Edit"] });
    const row = db.query<{ tools_used_json: string }, []>("SELECT tools_used_json FROM skill_runs").get();
    expect(JSON.parse(row!.tools_used_json)).toEqual(["Bash", "Read", "Edit"]);
  });

  test("consecutive startRun produces monotonically increasing ids", () => {
    const a = startRun(db, { skillName: "m", version: 1 });
    const b = startRun(db, { skillName: "m", version: 1 });
    const c = startRun(db, { skillName: "m", version: 1 });
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });
});

describe("finishRun", () => {
  test("sets ended_at, success (1), turns_saved, user_feedback", () => {
    const id = startRun(db, { skillName: "f", version: 1 });
    finishRun(db, { id, success: true, turnsSaved: 2.5, userFeedback: "nice" });

    const row = db
      .query<
        {
          ended_at: string | null;
          success: number | null;
          turns_saved: number | null;
          user_feedback: string | null;
        },
        [number]
      >("SELECT ended_at, success, turns_saved, user_feedback FROM skill_runs WHERE id = ?")
      .get(id);
    expect(row?.ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(row?.success).toBe(1);
    expect(row?.turns_saved).toBe(2.5);
    expect(row?.user_feedback).toBe("nice");
  });

  test("success=false stored as 0", () => {
    const id = startRun(db, { skillName: "f", version: 1 });
    finishRun(db, { id, success: false });
    const row = db
      .query<{ success: number | null }, [number]>("SELECT success FROM skill_runs WHERE id = ?")
      .get(id);
    expect(row?.success).toBe(0);
  });

  test("optional fields default to null", () => {
    const id = startRun(db, { skillName: "f", version: 1 });
    finishRun(db, { id, success: true });
    const row = db
      .query<{ turns_saved: number | null; user_feedback: string | null }, [number]>(
        "SELECT turns_saved, user_feedback FROM skill_runs WHERE id = ?"
      )
      .get(id);
    expect(row?.turns_saved).toBeNull();
    expect(row?.user_feedback).toBeNull();
  });
});

describe("statsFor", () => {
  test("empty for unknown skill", () => {
    const s = statsFor(db, "ghost", 7);
    expect(s).toEqual({ runs: 0, hits: 0, successes: 0, avgTurnsSaved: 0 });
  });

  test("counts started and ended runs separately (runs vs hits)", () => {
    const a = startRun(db, { skillName: "k", version: 1 });
    const b = startRun(db, { skillName: "k", version: 1 });
    startRun(db, { skillName: "k", version: 1 }); // never finished
    finishRun(db, { id: a, success: true, turnsSaved: 1 });
    finishRun(db, { id: b, success: false, turnsSaved: 3 });

    const s = statsFor(db, "k", 7);
    expect(s.runs).toBe(3);
    expect(s.hits).toBe(2); // only finished runs count for hits
    expect(s.successes).toBe(1);
    expect(s.avgTurnsSaved).toBe(2); // (1 + 3) / 2
  });

  test("scoped by skillName", () => {
    startRun(db, { skillName: "a", version: 1 });
    startRun(db, { skillName: "a", version: 1 });
    startRun(db, { skillName: "b", version: 1 });

    expect(statsFor(db, "a", 7).runs).toBe(2);
    expect(statsFor(db, "b", 7).runs).toBe(1);
  });

  test("windowDays=0 returns no rows (cutoff is now)", () => {
    // Seed a run with a slightly past timestamp to simulate normal workflow.
    db.prepare("INSERT INTO skill_runs (skill_name, version, started_at) VALUES (?, ?, ?)").run(
      "w",
      1,
      new Date(Date.now() - 5000).toISOString()
    );
    const s = statsFor(db, "w", 0);
    expect(s.runs).toBe(0);
  });

  test("windowDays excludes rows older than cutoff", () => {
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    db.prepare("INSERT INTO skill_runs (skill_name, version, started_at) VALUES (?, ?, ?)").run(
      "win",
      1,
      old
    );
    // Seed a recent row too.
    startRun(db, { skillName: "win", version: 1 });

    expect(statsFor(db, "win", 7).runs).toBe(1);
    expect(statsFor(db, "win", 60).runs).toBe(2);
  });
});

describe("statsSinceRunId", () => {
  test("sinceRunId=0 includes every row (inclusive of all ids)", () => {
    startRun(db, { skillName: "s", version: 1 });
    startRun(db, { skillName: "s", version: 1 });
    startRun(db, { skillName: "s", version: 1 });
    expect(statsSinceRunId(db, "s", 0).runs).toBe(3);
  });

  test("filters rows with id > sinceRunId (strictly greater)", () => {
    const a = startRun(db, { skillName: "p", version: 1 });
    const b = startRun(db, { skillName: "p", version: 1 });
    const c = startRun(db, { skillName: "p", version: 1 });

    // after id = a should exclude a itself
    expect(statsSinceRunId(db, "p", a).runs).toBe(2);
    expect(statsSinceRunId(db, "p", b).runs).toBe(1);
    expect(statsSinceRunId(db, "p", c).runs).toBe(0);
  });

  test("tallies successes and avgTurnsSaved over the open window", () => {
    const a = startRun(db, { skillName: "t", version: 1 });
    const b = startRun(db, { skillName: "t", version: 1 });
    const c = startRun(db, { skillName: "t", version: 1 });
    finishRun(db, { id: a, success: true, turnsSaved: 1 });
    finishRun(db, { id: b, success: false, turnsSaved: 2 });
    finishRun(db, { id: c, success: true, turnsSaved: 3 });

    const all = statsSinceRunId(db, "t", 0);
    expect(all.runs).toBe(3);
    expect(all.hits).toBe(3);
    expect(all.successes).toBe(2);
    expect(all.avgTurnsSaved).toBe(2);
  });

  test("returns zeros for empty selection", () => {
    const s = statsSinceRunId(db, "empty", 0);
    expect(s).toEqual({ runs: 0, hits: 0, successes: 0, avgTurnsSaved: 0 });
  });
});

describe("listRuns", () => {
  test("empty for unknown skill", () => {
    expect(listRuns(db, "ghost")).toEqual([]);
  });

  test("orders by started_at DESC and honours the limit", () => {
    for (let i = 0; i < 5; i++) {
      db.prepare("INSERT INTO skill_runs (skill_name, version, started_at) VALUES (?, ?, ?)").run(
        "ord",
        1,
        `2024-0${i + 1}-01T00:00:00.000Z`
      );
    }
    const rows = listRuns(db, "ord", 3);
    expect(rows.length).toBe(3);
    expect(rows[0].started_at).toBe("2024-05-01T00:00:00.000Z");
    expect(rows[2].started_at).toBe("2024-03-01T00:00:00.000Z");
  });

  test("scoped by skill_name", () => {
    startRun(db, { skillName: "a", version: 1 });
    startRun(db, { skillName: "b", version: 1 });
    const rows = listRuns(db, "a");
    expect(rows.length).toBe(1);
    expect(rows[0].skill_name).toBe("a");
  });
});
