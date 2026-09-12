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
