import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, closeDb, type Database, eventsRepo, openDb } from "../state";
import { journalFile, recordEvent } from "./journal";

const ORIG_CWD = process.cwd();
let tempRoot: string;
let db: Database;

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "hermes-evolve-journal-"));
  process.chdir(tempRoot);
  db = openDb({ path: ":memory:" });
  await applyMigrations(db);
});

afterAll(async () => {
  closeDb(db);
  process.chdir(ORIG_CWD);
  await rm(tempRoot, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec("DELETE FROM learn_events");
});

describe("journalFile", () => {
  test("produces an ISO-dated markdown path under memory/journal", () => {
    const date = new Date("2026-04-16T12:34:56Z");
    const path = journalFile(date, tempRoot);
    expect(path.endsWith(`${"2026-04-16"}.md`)).toBe(true);
    expect(path).toContain("memory");
    expect(path).toContain("journal");
  });

  test("uses the provided cwd when given", () => {
    const date = new Date("2026-04-16T00:00:00Z");
    const path = journalFile(date, "/custom/cwd");
    expect(path.startsWith("/custom/cwd") || path.startsWith("\\custom\\cwd")).toBe(true);
  });

  test("different dates produce different filenames", () => {
    const a = journalFile(new Date("2026-01-01T00:00:00Z"), tempRoot);
    const b = journalFile(new Date("2026-12-31T23:59:59Z"), tempRoot);
    expect(a).not.toBe(b);
  });
});

describe("recordEvent", () => {
  test("appends an evolve.* event to the events table", async () => {
    await recordEvent(
      db,
      { kind: "evolve.plan", slot: "task-1", summary: "planning task-1", details: { votes: 3 } },
      tempRoot
    );

    const rows = eventsRepo.listEvents<{ slot: string; summary: string; details: { votes: number } }>(db, {
      kindPrefix: "evolve.",
    });
    expect(rows.length).toBe(1);
    expect(rows[0]?.kind).toBe("evolve.plan");
    expect(rows[0]?.payload.slot).toBe("task-1");
    expect(rows[0]?.payload.summary).toBe("planning task-1");
    expect(rows[0]?.payload.details).toEqual({ votes: 3 });
  });

  test("listEvents with kindPrefix 'evolve.' returns every appended kind", async () => {
    await recordEvent(db, { kind: "evolve.plan", slot: "s", summary: "p" }, tempRoot);
    await recordEvent(db, { kind: "evolve.exec.start", slot: "s", summary: "e1" }, tempRoot);
    await recordEvent(db, { kind: "evolve.exec.done", slot: "s", summary: "e2" }, tempRoot);
    await recordEvent(db, { kind: "evolve.commit", slot: "s", summary: "c" }, tempRoot);
    await recordEvent(db, { kind: "evolve.revert", slot: "s", summary: "r" }, tempRoot);
    await recordEvent(db, { kind: "evolve.skip", slot: "idle", summary: "x" }, tempRoot);

    const rows = eventsRepo.listEvents(db, { kindPrefix: "evolve.", limit: 100 });
    const kinds = rows.map((r) => r.kind).sort();
    expect(kinds).toEqual([
      "evolve.commit",
      "evolve.exec.done",
      "evolve.exec.start",
      "evolve.plan",
      "evolve.revert",
      "evolve.skip",
    ]);
  });

  test("writes a markdown journal under memoryDir(cwd)/journal/<date>.md", async () => {
    await recordEvent(db, { kind: "evolve.plan", slot: "task-99", summary: "plan summary text" }, tempRoot);

    const path = journalFile(new Date(), tempRoot);
    expect(existsSync(path)).toBe(true);

    const body = await readFile(path, "utf8");
    expect(body).toContain("Evolve journal");
    expect(body).toContain("evolve.plan");
    expect(body).toContain("task-99");
    expect(body).toContain("plan summary text");
  });

  test("second event appends to the same daily journal without a second header", async () => {
    await recordEvent(db, { kind: "evolve.plan", slot: "s1", summary: "first entry" }, tempRoot);
    await recordEvent(db, { kind: "evolve.commit", slot: "s1", summary: "second entry" }, tempRoot);

    const path = journalFile(new Date(), tempRoot);
    const body = await readFile(path, "utf8");

    expect(body).toContain("first entry");
    expect(body).toContain("second entry");
    const headerMatches = body.match(/# Evolve journal/g) ?? [];
    expect(headerMatches.length).toBe(1);
  });

  test("payload round-trips the full event shape (slot + summary + details)", async () => {
    await recordEvent(
      db,
      {
        kind: "evolve.commit",
        slot: "task-xyz",
        summary: "green",
        details: { sha: "deadbeef", durationMs: 1234 },
      },
      tempRoot
    );

    const rows = eventsRepo.listEvents<{
      slot: string;
      summary: string;
      details: { sha: string; durationMs: number };
    }>(db, { kindPrefix: "evolve.commit" });
    expect(rows.length).toBe(1);
    expect(rows[0]?.payload).toEqual({
      slot: "task-xyz",
      summary: "green",
      details: { sha: "deadbeef", durationMs: 1234 },
    });
  });

  test("details default to undefined when not provided", async () => {
    await recordEvent(db, { kind: "evolve.skip", slot: "idle", summary: "nothing to do" }, tempRoot);
    const rows = eventsRepo.listEvents<{ slot: string; summary: string; details?: unknown }>(db, {
      kindPrefix: "evolve.skip",
    });
    expect(rows.length).toBe(1);
    // `appendEvent` wraps the payload as-is, so "details" is serialised as missing when undefined.
    expect(rows[0]?.payload.slot).toBe("idle");
    expect(rows[0]?.payload.summary).toBe("nothing to do");
    expect(rows[0]?.payload.details).toBeUndefined();
  });
});
