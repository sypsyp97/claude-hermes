import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSharedDb, resetSharedDbCache } from "./shared-db";

test("concurrent opens through workspace aliases share one initialized database", async () => {
  const root = await mkdtemp(join(tmpdir(), "hermes-db-alias-"));
  const workspace = join(root, "workspace");
  const alias = join(root, "alias");
  try {
    await mkdir(workspace);
    await symlink(workspace, alias, "junction");
    const results = await Promise.allSettled([getSharedDb(workspace), getSharedDb(alias)]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    const [first, second] = await Promise.all([getSharedDb(workspace), getSharedDb(alias)]);
    expect(second).toBe(first);
    expect(first.query("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  } finally {
    await resetSharedDbCache();
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed initialization can be retried after the database is repaired", async () => {
  const root = await mkdtemp(join(tmpdir(), "hermes-db-retry-"));
  const { openDb, closeDb } = await import("./db");
  const { stateDbFile } = await import("../paths");
  const broken = openDb({ path: stateDbFile(root) });
  try {
    // A malformed pre-existing table causes migration 001 to fail.
    broken.exec("CREATE TABLE sessions (id INTEGER PRIMARY KEY)");
    const attempt = getSharedDb(root);
    expect(getSharedDb(root)).toBe(attempt);
    await expect(attempt).rejects.toThrow();
    broken.exec("DROP TABLE sessions");
    const recovered = await getSharedDb(root);
    expect(recovered.query("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    expect(await getSharedDb(root)).toBe(recovered);
  } finally {
    closeDb(broken);
    await resetSharedDbCache();
    await rm(root, { recursive: true, force: true });
  }
});
