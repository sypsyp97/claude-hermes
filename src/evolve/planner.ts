/**
 * Planner — picks the next task to work on. Ordering rules (stable):
 *   1. Highest net votes first.
 *   2. Ties broken by earliest createdAt.
 *   3. Tasks with < 0 votes are skipped (community immune system).
 */

import type { PendingTask } from "./input";

export function pickNext(tasks: PendingTask[]): PendingTask | null {
  const candidates = tasks.filter((t) => t.votes >= 0);
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => {
    if (a.votes !== b.votes) return b.votes - a.votes;
    return a.createdAt.localeCompare(b.createdAt);
  });
  return sorted[0] ?? null;
}

export function rank(tasks: PendingTask[]): PendingTask[] {
  return tasks
    .filter((t) => t.votes >= 0)
    .sort((a, b) => {
      if (a.votes !== b.votes) return b.votes - a.votes;
      return a.createdAt.localeCompare(b.createdAt);
    });
}
