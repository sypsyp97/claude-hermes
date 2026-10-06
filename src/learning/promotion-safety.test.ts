import { afterEach, beforeEach, expect, test } from "bun:test";
import { applyMigrations, closeDb, type Database, openDb } from "../state";
import { getSkill, setStatus, upsertSkill } from "../state/repos/skills";
import { finishRun, startRun } from "../state/repos/skillRuns";
import { promoteIfVerified } from "./closed-loop";
import { applyPromotion } from "./promoter";

let db: Database;
const candidate = {
  name: "guarded-skill",
  description: "Use this skill to inspect local fixtures.",
  body: "Read the fixtures.",
};
beforeEach(async () => {
  db = openDb({ path: ":memory:" });
  await applyMigrations(db);
});
afterEach(() => closeDb(db));

test("disabled skills remain disabled even when promotion metrics are strong", () => {
  upsertSkill(db, { name: candidate.name, path: "original", status: "disabled" });
  for (let i = 0; i < 25; i++) {
    const id = startRun(db, { skillName: candidate.name, version: 1 });
    finishRun(db, { id, success: true, turnsSaved: 2 });
  }
  const decision = applyPromotion(db, candidate.name);
  expect(decision.action).toBe("noop");
  expect(decision.to).toBe("disabled");
  expect(getSkill(db, candidate.name)?.status).toBe("disabled");
});

test("verification cannot reactivate a disabled skill or overwrite its metadata", async () => {
  upsertSkill(db, { name: candidate.name, path: "original", status: "disabled", allowedTools: ["Read"] });
  let runs = 0;
  const result = await promoteIfVerified(db, candidate, {
    runVerify: async () => {
      runs++;
      return true;
    },
  });
  expect(result.finalStatus).toBe("disabled");
  expect(runs).toBe(0);
  expect(getSkill(db, candidate.name)?.path).toBe("original");
  expect(getSkill(db, candidate.name)?.allowed_tools_json).toBe('["Read"]');
});

for (const status of ["disabled", "active"] as const) {
  test(`a skill changed to ${status} during verification keeps that status`, async () => {
    const result = await promoteIfVerified(db, candidate, {
      runVerify: async () => {
        setStatus(db, candidate.name, status);
        return true;
      },
    });
    expect(result.finalStatus).toBe(status);
    expect(getSkill(db, candidate.name)?.status).toBe(status);
  });
}

test("a rejected verifier reports the disabled status established while it ran", async () => {
  const result = await promoteIfVerified(db, candidate, {
    runVerify: async () => {
      setStatus(db, candidate.name, "disabled");
      throw new Error("verification stopped");
    },
  });
  expect(result.finalStatus).toBe("disabled");
  expect(getSkill(db, candidate.name)?.status).toBe("disabled");
});
