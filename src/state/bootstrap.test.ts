import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "./bootstrap";
import { closeDb, openDb } from "./db";

test("concurrent migration handles apply each version exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "hermes-concurrent-migrations-"));
  const path = join(root, "state.db");
  const first = openDb({ path });
  const second = openDb({ path });
  try {
    const results = await Promise.allSettled([applyMigrations(first), applyMigrations(second)]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    const versions = first.query<{ version: string }, []>("SELECT version FROM schema_migrations").all();
    expect(versions.length).toBeGreaterThan(0);
    const applied = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
    expect(applied.length).toBe(versions.length);
    expect(new Set(applied).size).toBe(versions.length);
    expect(await applyMigrations(first)).toEqual([]);
  } finally {
    closeDb(first);
    closeDb(second);
    await rm(root, { recursive: true, force: true });
  }
});
