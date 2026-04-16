import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { applyMigrations, closeDb, eventsRepo, openDb, skillsRepo, type Database } from "../../src/state";
import {
  applyPromotion,
  DEFAULT_PROMOTION_THRESHOLDS,
  detectCandidates,
  evaluatePromotion,
  startCollect,
  finishCollect,
} from "../../src/learning";

let db: Database;

beforeAll(async () => {
  db = openDb({ path: ":memory:" });
  await applyMigrations(db);
});

afterAll(() => {
  closeDb(db);
});

function seedShadowRuns(db: Database, skill: string, count: number, successes: number) {
  for (let i = 0; i < count; i++) {
    const runId = startCollect(db, {
      skillName: skill,
      version: 1,
      shadow: true,
    });
    finishCollect(db, {
      runId,
      skillName: skill,
      success: i < successes,
      turnsSaved: 1.5,
      shadow: true,
    });
  }
}

describe("learning pipeline", () => {
  test("detector surfaces repeated successful shadow skills", () => {
    seedShadowRuns(db, "summarise", 5, 5);
    const candidates = detectCandidates(db, { sinceHours: 48, minObservations: 3 });
    expect(candidates.map((c) => c.skillName)).toContain("summarise");
  });

  test("evaluatePromotion is noop below minRuns", () => {
    skillsRepo.upsertSkill(db, { name: "weekly-digest", path: "/tmp/w/SKILL.md" });
    seedShadowRuns(db, "weekly-digest", 5, 5);
    const decision = evaluatePromotion(db, "weekly-digest");
    expect(decision.action).toBe("noop");
    expect(decision.reason).toContain("minRuns");
  });

  test("applyPromotion promotes when all thresholds met", () => {
    const name = "auto-reviewer";
    skillsRepo.upsertSkill(db, { name, path: "/tmp/auto/SKILL.md" });
    seedShadowRuns(db, name, 25, 24);
    const decision = applyPromotion(db, name);
    expect(decision.action).toBe("promote");
    expect(decision.to).toBe("active");
    expect(skillsRepo.getSkill(db, name)?.status).toBe("active");
    expect(skillsRepo.getSkill(db, name)?.promoted_at).not.toBeNull();

    const events = eventsRepo.listEvents(db, { kindPrefix: "skill.promote" });
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  test("regression inside rollback window demotes active skill", () => {
    const name = "flaky-suggestor";
    skillsRepo.upsertSkill(db, { name, path: "/tmp/flaky/SKILL.md" });
    seedShadowRuns(db, name, 25, 25);
    applyPromotion(db, name);
    expect(skillsRepo.getSkill(db, name)?.status).toBe("active");

    seedShadowRuns(db, name, 10, 0);
    const rollback = applyPromotion(db, name, DEFAULT_PROMOTION_THRESHOLDS);
    expect(rollback.action).toBe("demote");
    expect(rollback.to).toBe("shadow");
    expect(skillsRepo.getSkill(db, name)?.status).toBe("shadow");
  });
});
