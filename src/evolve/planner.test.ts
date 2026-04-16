import { describe, expect, test } from "bun:test";
import type { PendingTask } from "./input";
import { pickNext, rank } from "./planner";

function task(overrides: Partial<PendingTask>): PendingTask {
  return {
    id: "t",
    source: "local",
    title: "t",
    body: "",
    votes: 0,
    createdAt: "2026-04-16T00:00:00Z",
    ...overrides,
  };
}

describe("pickNext", () => {
  test("returns null on empty input", () => {
    expect(pickNext([])).toBeNull();
  });

  test("returns null when every task has negative votes", () => {
    const tasks = [task({ id: "a", votes: -1 }), task({ id: "b", votes: -2 })];
    expect(pickNext(tasks)).toBeNull();
  });

  test("picks the task with the highest votes", () => {
    const tasks = [
      task({ id: "low", votes: 1 }),
      task({ id: "high", votes: 10 }),
      task({ id: "mid", votes: 5 }),
    ];
    expect(pickNext(tasks)?.id).toBe("high");
  });

  test("skips tasks with negative votes even when they would otherwise rank first", () => {
    const tasks = [task({ id: "toxic", votes: -5 }), task({ id: "ok", votes: 0 })];
    expect(pickNext(tasks)?.id).toBe("ok");
  });

  test("zero-vote tasks are eligible (>= 0 threshold)", () => {
    const tasks = [task({ id: "only", votes: 0 })];
    expect(pickNext(tasks)?.id).toBe("only");
  });

  test("breaks ties by earliest createdAt", () => {
    const tasks = [
      task({ id: "late", votes: 3, createdAt: "2026-04-16T12:00:00Z" }),
      task({ id: "early", votes: 3, createdAt: "2026-04-10T00:00:00Z" }),
      task({ id: "mid", votes: 3, createdAt: "2026-04-14T00:00:00Z" }),
    ];
    expect(pickNext(tasks)?.id).toBe("early");
  });

  test("votes dominate createdAt ordering", () => {
    const tasks = [
      task({ id: "old-low", votes: 1, createdAt: "2020-01-01T00:00:00Z" }),
      task({ id: "new-high", votes: 9, createdAt: "2030-01-01T00:00:00Z" }),
    ];
    expect(pickNext(tasks)?.id).toBe("new-high");
  });

  test("does not mutate the input array", () => {
    const tasks = [task({ id: "a", votes: 1 }), task({ id: "b", votes: 5 }), task({ id: "c", votes: 3 })];
    const snapshot = tasks.map((t) => t.id);
    pickNext(tasks);
    expect(tasks.map((t) => t.id)).toEqual(snapshot);
  });
});

describe("rank", () => {
  test("returns empty array on empty input", () => {
    expect(rank([])).toEqual([]);
  });

  test("filters out negative-vote tasks", () => {
    const ranked = rank([
      task({ id: "neg", votes: -1 }),
      task({ id: "pos", votes: 2 }),
      task({ id: "zero", votes: 0 }),
    ]);
    expect(ranked.map((t) => t.id)).toEqual(["pos", "zero"]);
  });

  test("orders by votes DESC then createdAt ASC", () => {
    const ranked = rank([
      task({ id: "b3-late", votes: 3, createdAt: "2026-04-20T00:00:00Z" }),
      task({ id: "a5", votes: 5, createdAt: "2026-04-16T00:00:00Z" }),
      task({ id: "b3-early", votes: 3, createdAt: "2026-04-10T00:00:00Z" }),
      task({ id: "c0", votes: 0, createdAt: "2026-04-01T00:00:00Z" }),
    ]);
    expect(ranked.map((t) => t.id)).toEqual(["a5", "b3-early", "b3-late", "c0"]);
  });

  test("pickNext returns the same item as rank()[0]", () => {
    const tasks = [
      task({ id: "a", votes: 4, createdAt: "2026-04-16T10:00:00Z" }),
      task({ id: "b", votes: 4, createdAt: "2026-04-16T09:00:00Z" }),
      task({ id: "c", votes: 7, createdAt: "2026-04-16T11:00:00Z" }),
    ];
    expect(pickNext(tasks)?.id).toBe(rank(tasks)[0]?.id);
  });
});
