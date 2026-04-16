import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { applyMigrations, closeDb, type Database, openDb } from "../index";
import { deleteJob, getJob, listJobs, pruneMissing, recordRun, upsertJob } from "./jobs";

let db: Database;

beforeAll(async () => {
  db = openDb({ path: ":memory:" });
  await applyMigrations(db);
});

afterAll(() => {
  closeDb(db);
});

beforeEach(() => {
  db.exec("DELETE FROM jobs");
});

describe("upsertJob", () => {
  test("inserts a job and returns the row", () => {
    const row = upsertJob(db, {
      name: "daily",
      path: "jobs/daily.md",
      schedule: "0 9 * * *",
    });
    expect(row.name).toBe("daily");
    expect(row.path).toBe("jobs/daily.md");
    expect(row.schedule).toBe("0 9 * * *");
    expect(row.recurring).toBe(0);
    expect(row.notify).toBe(0);
    expect(row.last_run_at).toBeNull();
    expect(row.last_result).toBeNull();
  });

  test("preserves schedule string verbatim including whitespace and cron DSL", () => {
    const schedules = ["* * * * *", "0 0 * * *", "*/15 9-17 * * 1-5", "@daily", "in 5m", "  0  9  *  *  *  "];
    for (const [i, schedule] of schedules.entries()) {
      upsertJob(db, { name: `job-${i}`, path: `jobs/${i}.md`, schedule });
    }
    for (const [i, schedule] of schedules.entries()) {
      expect(getJob(db, `job-${i}`)?.schedule).toBe(schedule);
    }
  });

  test("recurring and notify booleans persist as 1/0", () => {
    const r = upsertJob(db, {
      name: "recur",
      path: "p.md",
      schedule: "* * * * *",
      recurring: true,
      notify: true,
    });
    expect(r.recurring).toBe(1);
    expect(r.notify).toBe(1);

    const noBools = upsertJob(db, { name: "plain", path: "q.md", schedule: "0 9 * * *" });
    expect(noBools.recurring).toBe(0);
    expect(noBools.notify).toBe(0);
  });

  test("upsert on existing name overwrites path/schedule/recurring/notify", () => {
    upsertJob(db, { name: "x", path: "old.md", schedule: "0 0 * * *", recurring: false });
    const updated = upsertJob(db, {
      name: "x",
      path: "new.md",
      schedule: "*/5 * * * *",
      recurring: true,
      notify: true,
    });
    expect(updated.path).toBe("new.md");
    expect(updated.schedule).toBe("*/5 * * * *");
    expect(updated.recurring).toBe(1);
    expect(updated.notify).toBe(1);

    // Should still be exactly one row.
    expect(listJobs(db).length).toBe(1);
  });

  test("upsert preserves last_run_at / last_result across updates", () => {
    upsertJob(db, { name: "keepme", path: "a.md", schedule: "0 9 * * *" });
    recordRun(db, "keepme", "ok");
    const before = getJob(db, "keepme");
    expect(before?.last_run_at).not.toBeNull();
    expect(before?.last_result).toBe("ok");

    upsertJob(db, { name: "keepme", path: "b.md", schedule: "0 10 * * *" });
    const after = getJob(db, "keepme");
    expect(after?.path).toBe("b.md");
    expect(after?.last_run_at).toBe(before?.last_run_at ?? null);
    expect(after?.last_result).toBe("ok");
  });
});

describe("getJob", () => {
  test("returns null when job does not exist", () => {
    expect(getJob(db, "ghost")).toBeNull();
  });

  test("returns the stored row", () => {
    upsertJob(db, { name: "hello", path: "h.md", schedule: "0 * * * *" });
    const row = getJob(db, "hello");
    expect(row?.name).toBe("hello");
  });
});

describe("listJobs", () => {
  test("empty db returns []", () => {
    expect(listJobs(db)).toEqual([]);
  });

  test("returns jobs sorted by name ASC", () => {
    upsertJob(db, { name: "charlie", path: "c.md", schedule: "* * * * *" });
    upsertJob(db, { name: "alpha", path: "a.md", schedule: "* * * * *" });
    upsertJob(db, { name: "bravo", path: "b.md", schedule: "* * * * *" });
    const names = listJobs(db).map((j) => j.name);
    expect(names).toEqual(["alpha", "bravo", "charlie"]);
  });
});

describe("recordRun", () => {
  test("sets last_run_at and last_result on existing job", () => {
    upsertJob(db, { name: "r", path: "r.md", schedule: "* * * * *" });
    recordRun(db, "r", "failure: boom");
    const row = getJob(db, "r");
    expect(row?.last_result).toBe("failure: boom");
    expect(row?.last_run_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("no-op on non-existent job (no error)", () => {
    expect(() => recordRun(db, "nonexistent", "x")).not.toThrow();
  });
});

describe("deleteJob", () => {
  test("removes a job and reports true", () => {
    upsertJob(db, { name: "gone", path: "g.md", schedule: "* * * * *" });
    expect(deleteJob(db, "gone")).toBe(true);
    expect(getJob(db, "gone")).toBeNull();
  });

  test("returns false when job does not exist", () => {
    expect(deleteJob(db, "absent")).toBe(false);
  });
});

describe("pruneMissing", () => {
  test("deletes all rows when list is empty", () => {
    upsertJob(db, { name: "a", path: "a.md", schedule: "* * * * *" });
    upsertJob(db, { name: "b", path: "b.md", schedule: "* * * * *" });
    const deleted = pruneMissing(db, []);
    expect(deleted).toBe(2);
    expect(listJobs(db)).toEqual([]);
  });

  test("keeps only rows whose name is in the present list", () => {
    upsertJob(db, { name: "keep1", path: "k1.md", schedule: "* * * * *" });
    upsertJob(db, { name: "keep2", path: "k2.md", schedule: "* * * * *" });
    upsertJob(db, { name: "drop1", path: "d1.md", schedule: "* * * * *" });
    upsertJob(db, { name: "drop2", path: "d2.md", schedule: "* * * * *" });

    const deleted = pruneMissing(db, ["keep1", "keep2"]);
    expect(deleted).toBe(2);
    const names = listJobs(db).map((j) => j.name);
    expect(names.sort()).toEqual(["keep1", "keep2"]);
  });

  test("noop when every job is present", () => {
    upsertJob(db, { name: "a", path: "a.md", schedule: "* * * * *" });
    const deleted = pruneMissing(db, ["a"]);
    expect(deleted).toBe(0);
    expect(getJob(db, "a")).not.toBeNull();
  });
});
