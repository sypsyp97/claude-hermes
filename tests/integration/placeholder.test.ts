import { describe, expect, test } from "bun:test";

/**
 * Phase 0 sentinel.
 *
 * Real integration tests arrive with Phase 1 (migration), Phase 2 (SQLite),
 * Phase 3 (envelope routing), Phase 6 (learned-skill pipeline). Keeping a
 * trivial test here so `bun test tests/integration` never fails with
 * "no tests matched" — that would make the verify pipeline red for the
 * wrong reason.
 */
describe("integration harness", () => {
  test("placeholder stays green until Phase 1", () => {
    expect(true).toBe(true);
  });
});
