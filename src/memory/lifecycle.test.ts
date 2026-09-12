import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, symlink, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCrossSessionMemory } from "./files";
import { sessionAccess } from "../runtime/session-target";
import { getSharedDb, resetSharedDbCache } from "../state/shared-db";
import { getByKey } from "../state/repos/sessions";
import { appendMessage } from "../state/repos/messages";
import { buildRuntimeMemoryDigest } from "./runtime-digest";
import { runDream } from "./dream";
import { nudgeAndPersist } from "./nudge";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hermes-memory-lifecycle-"));
});
afterEach(async () => {
  await resetSharedDbCache();
  await rm(root, { recursive: true, force: true });
});

test("concurrent memory appends preserve every entry", async () => {
  await Promise.all(Array.from({ length: 20 }, (_, i) => appendCrossSessionMemory(`entry-${i}`, root)));
  const contents = await readFile(join(root, "memory/MEMORY.md"), "utf8");
  expect(new Set(contents.match(/entry-\d+/g)).size).toBe(20);
});

test("workspace aliases retain recall across cache restart", async () => {
  const workspace = join(root, "workspace");
  const alias = join(root, "alias");
  await mkdir(workspace);
  await symlink(workspace, alias, "junction");
  const target = {
    key: "user:telegram:alice",
    scope: "per-user",
    source: "telegram",
    workspace: alias,
    user: "alice",
    memoryScope: "user",
  } as const;
  await sessionAccess(target).create("session");
  const db = await getSharedDb(alias);
  appendMessage(db, { sessionId: getByKey(db, target.key)!.id, role: "user", content: "Orion port 8123" });
  await resetSharedDbCache();
  const reopened = await getSharedDb(workspace);
  expect(buildRuntimeMemoryDigest(reopened, { target: { ...target, workspace }, query: "Orion" })).toContain(
    "8123"
  );
});

test("Dream summaries enter recall only for their originating conversation", async () => {
  const target = {
    key: "user:telegram:a",
    scope: "per-user",
    source: "telegram",
    workspace: root,
    user: "a",
    memoryScope: "user",
  } as const;
  await sessionAccess(target).create("a");
  const db = await getSharedDb(root);
  const sessionId = getByKey(db, target.key)!.id;
  appendMessage(db, { sessionId, role: "user", content: "remember ORION deployment" });
  db.exec("UPDATE messages SET ts = '2020-01-01T00:00:00.000Z'");
  await runDream(db, { cwd: root });
  db.exec("UPDATE digests SET summary = 'ORION consolidated plan'");
  expect(buildRuntimeMemoryDigest(db, { target })).toContain("ORION consolidated plan");
  expect(buildRuntimeMemoryDigest(db, { target: { ...target, key: "user:telegram:b" } })).not.toContain(
    "ORION consolidated plan"
  );
});

test("explicit Chinese facts are attributed, deduplicated and disabled by none", async () => {
  const target = {
    key: "user:telegram:a",
    scope: "per-user",
    source: "telegram",
    workspace: root,
    user: "a",
    memoryScope: "user",
  } as const;
  await sessionAccess(target).create("a");
  const db = await getSharedDb(root);
  const opts = { cwd: root, sourceSessionId: getByKey(db, target.key)!.id };
  const turns = [{ role: "user", content: "记住：部署端口是 8123" }] as const;
  await nudgeAndPersist([...turns], opts);
  await nudgeAndPersist([...turns], opts);
  await nudgeAndPersist([{ role: "user", content: "记住：秘密" }], { ...opts, memoryScope: "none" });
  expect(db.query("SELECT value FROM memory_entries").all()).toEqual([{ value: "部署端口是 8123" }]);
});

test("independent remember statements remain durable after later conversations", async () => {
  const target = {
    key: "user:telegram:a",
    scope: "per-user",
    source: "telegram",
    workspace: root,
    user: "a",
    memoryScope: "user",
  } as const;
  await sessionAccess(target).create("a");
  const db = await getSharedDb(root);
  const opts = { cwd: root, sourceSessionId: getByKey(db, target.key)!.id };
  await nudgeAndPersist([{ role: "user", content: "记住：Orion port 8123" }], opts);
  await nudgeAndPersist([{ role: "user", content: "记住：Atlas uses blue" }], opts);
  const digest = buildRuntimeMemoryDigest(db, { target });
  expect(digest).toContain("Orion port 8123");
  expect(digest).toContain("Atlas uses blue");
});
