import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { applyMigrations, closeDb, type Database, eventsRepo, openDb, skillsRepo } from "../state";
import { finishCollect, startCollect } from "./collector";
import { detectCandidates } from "./detector";

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
  db.exec("DELETE FROM skill_runs");
  db.exec("DELETE FROM skills");
});

function seedShadowRuns(name: string, count: number, successes = count): void {
  for (let i = 0; i < count; i++) {
    const runId = startCollect(db, { skillName: name, version: 1, shadow: true });
    finishCollect(db, {
      runId,
      skillName: name,
      success: i < successes,
      turnsSaved: 1.0,
      shadow: true,
    });
  }
}

describe("detectCandidates", () => {
  test("returns [] when there are no shadow runs", () => {
    expect(detectCandidates(db)).toEqual([]);
  });

  test("returns [] when skill was run as active, not shadow", () => {
    const runId = startCollect(db, { skillName: "active-only", version: 1, shadow: false });
    finishCollect(db, { runId, skillName: "active-only", success: true, shadow: false });
    expect(detectCandidates(db)).toEqual([]);
  });

  test("surfaces a skill that hits minObservations", () => {
    seedShadowRuns("popular", 3);
    const candidates = detectCandidates(db, { minObservations: 3, sinceHours: 48 });
    expect(candidates.map((c) => c.skillName)).toContain("popular");
    const p = candidates.find((c) => c.skillName === "popular")!;
    expect(p.seenCount).toBe(3);
    expect(p.suggestedStatus).toBe("shadow");
    expect(typeof p.firstSeen).toBe("string");
    expect(typeof p.lastSeen).toBe("string");
  });

  test("minObservations threshold is respected — 2 observations with min=3 → []", () => {
    seedShadowRuns("barely", 2);
    const candidates = detectCandidates(db, { minObservations: 3, sinceHours: 48 });
    expect(candidates.find((c) => c.skillName === "barely")).toBeUndefined();
  });

  test("default minObservations is 3", () => {
    seedShadowRuns("use-default", 2);
    expect(detectCandidates(db).find((c) => c.skillName === "use-default")).toBeUndefined();

    seedShadowRuns("use-default", 1);
    const got = detectCandidates(db);
    expect(got.find((c) => c.skillName === "use-default")).toBeDefined();
  });

  test("sinceHours window is respected — negative window pushes cutoff into the future", () => {
    seedShadowRuns("ancient", 5);
    // sinceHours=-1 pushes the cutoff one hour into the future; all existing
    // events are strictly older → listEvents filters them out.
    const candidates = detectCandidates(db, { sinceHours: -1, minObservations: 1 });
    expect(candidates).toEqual([]);
  });

  test("failed shadow runs are excluded from the count", () => {
    // 5 runs total, only 2 successes. With minObservations=3 and only 2 successes,
    // the candidate must NOT surface.
    seedShadowRuns("mostly-fail", 5, 2);
    const candidates = detectCandidates(db, { minObservations: 3, sinceHours: 48 });
    expect(candidates.find((c) => c.skillName === "mostly-fail")).toBeUndefined();
  });

  test("events without skillName in payload are skipped (defensive)", () => {
    // Hand-craft a malformed shadow.finish event.
    eventsRepo.appendEvent(db, "skill.shadow.finish", { success: true });
    const candidates = detectCandidates(db, { minObservations: 1, sinceHours: 48 });
    expect(candidates).toEqual([]);
  });

  test("skill already promoted to active is NOT surfaced again", () => {
    seedShadowRuns("already-active", 5);
    skillsRepo.upsertSkill(db, {
      name: "already-active",
      path: "/tmp/SKILL.md",
      status: "active",
    });
    const candidates = detectCandidates(db, { minObservations: 3, sinceHours: 48 });
    expect(candidates.find((c) => c.skillName === "already-active")).toBeUndefined();
  });

  test("candidate-status skill IS still surfaced (status 'candidate' is allowed)", () => {
    seedShadowRuns("still-candidate", 5);
    skillsRepo.upsertSkill(db, {
      name: "still-candidate",
      path: "/tmp/SKILL.md",
      status: "candidate",
    });
    const candidates = detectCandidates(db, { minObservations: 3, sinceHours: 48 });
    expect(candidates.map((c) => c.skillName)).toContain("still-candidate");
  });

  test("groups observations per skillName (no cross-contamination)", () => {
    seedShadowRuns("alpha", 3);
    seedShadowRuns("beta", 4);
    const candidates = detectCandidates(db, { minObservations: 3, sinceHours: 48 });
    const byName = Object.fromEntries(candidates.map((c) => [c.skillName, c.seenCount]));
    expect(byName.alpha).toBe(3);
    expect(byName.beta).toBe(4);
  });
});
