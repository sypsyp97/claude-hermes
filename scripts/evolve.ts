#!/usr/bin/env bun
/**
 * One-shot evolve driver. Opens the state DB, runs a single iteration, closes
 * the DB, prints a structured summary. Designed to be invoked by a cron
 * (GitHub Actions or local scheduler).
 *
 * Exit codes:
 *   0 — committed (or no tasks)
 *   1 — verify failed / subagent failed (details in stderr + journal)
 */

import { applyMigrations, closeDb, openDb } from "../src/state";
import { evolveOnce } from "../src/evolve";

const db = openDb();
await applyMigrations(db);

try {
  const result = await evolveOnce(db);
  process.stdout.write(
    JSON.stringify(
      {
        outcome: result.outcome,
        taskId: result.task?.id ?? null,
        sha: result.sha ?? null,
        verifyOk: result.verify?.ok ?? null,
        execOk: result.exec?.ok ?? null,
      },
      null,
      2
    ) + "\n"
  );
  if (result.outcome === "verify-failed" || result.outcome === "exec-failed") {
    process.exit(1);
  }
} finally {
  closeDb(db);
}
