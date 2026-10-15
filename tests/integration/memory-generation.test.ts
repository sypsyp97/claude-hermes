import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nudgeAndPersist, resetExtractor, setExtractor, type ExtractedFact } from "../../src/memory/nudge";
import { crossSessionMemoryFile } from "../../src/paths";
import { workspaceKey } from "../../src/router/session-key";
import { sessionAccess, type SessionTarget } from "../../src/runtime/session-target";
import { createSession, resetSession } from "../../src/sessions";
import { insertMemory } from "../../src/state/repos/memory";
import { getByKey } from "../../src/state/repos/sessions";
import { getSharedDb, resetSharedDbCache } from "../../src/state/shared-db";

const originalCwd = process.cwd();
const sharedNote = "Existing shared note.\n";
const fact: ExtractedFact = {
  scope: "user",
  key: "extraction-boundary",
  value: "EXTRACTION_BOUNDARY_SENTINEL_8123",
};
let cwd: string;
let releaseExtraction: (() => void) | undefined;
let completion: Promise<ExtractedFact[]> | undefined;

beforeEach(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), "hermes-memory-generation-")));
  process.chdir(cwd);
  await mkdir(join(cwd, "memory"));
  await writeFile(crossSessionMemoryFile(cwd), sharedNote);
  await getSharedDb(cwd);
  resetExtractor();
});

afterEach(async () => {
  // Release on assertion failure too, before closing the source database.
  releaseExtraction?.();
  if (completion) await Promise.allSettled([completion]);
  releaseExtraction = undefined;
  completion = undefined;
  resetExtractor();
  process.chdir(originalCwd);
  await resetSharedDbCache();
  await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

function target(): SessionTarget {
  return {
    key: "user:telegram:extraction-owner",
    scope: "per-user",
    source: "telegram",
    workspace: cwd,
    user: "extraction-owner",
    memoryScope: "user",
  };
}

async function beginExtraction(key: string): Promise<number> {
  const db = await getSharedDb(cwd);
  const source = getByKey(db, key)!;
  insertMemory(db, { scope: "user", key: "existing", value: "prior fact", sourceSessionId: source.id });
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  releaseExtraction = released.resolve;
  setExtractor(async () => {
    entered.resolve();
    await released.promise;
    return [fact];
  });
  // Use the existing public options: the writer must capture its own fence
  // before it awaits extraction, even when callers supply no generation.
  completion = nudgeAndPersist([{ role: "user", content: `remember that ${fact.value}` }], {
    cwd,
    sourceSessionId: source.id,
    memoryScope: source.scope === "workspace" ? "workspace" : "user",
  });
  await entered.promise;
  expect(db.query("SELECT value FROM memory_entries WHERE value = ?").all(fact.value)).toEqual([]);
  return source.id;
}

async function finishStaleExtraction(): Promise<void> {
  releaseExtraction!();
  await completion;
  const db = await getSharedDb(cwd);
  expect(db.query("SELECT value FROM memory_entries WHERE value = ?").all(fact.value)).toEqual([]);
  expect(await readFile(crossSessionMemoryFile(cwd), "utf8")).toBe(sharedNote);
}

test("CLI reset during extraction prevents its late fact from becoming memory", async () => {
  await createSession("cli-before-reset");
  const key = workspaceKey(cwd);
  await beginExtraction(key);
  await resetSession();
  expect(getByKey(await getSharedDb(cwd), key)?.claude_session_id ?? null).toBeNull();
  await finishStaleExtraction();
}, 30_000);

test("scoped reset during extraction fences a late fact even when the source ID survives", async () => {
  const access = sessionAccess(target());
  await access.create("scoped-before-reset");
  const sourceId = await beginExtraction(access.target.key);
  await access.reset();
  const source = getByKey(await getSharedDb(cwd), access.target.key)!;
  expect(source.id).toBe(sourceId);
  expect(source.claude_session_id).toBeNull();
  await finishStaleExtraction();
}, 30_000);

test("forget and recreate during extraction cannot attach the old fact to the same conversation key", async () => {
  const access = sessionAccess(target());
  await access.create("scoped-before-forget");
  const sourceId = await beginExtraction(access.target.key);
  await access.forget();
  expect(getByKey(await getSharedDb(cwd), access.target.key)).toBeNull();
  await access.create("scoped-after-forget");
  const replacement = getByKey(await getSharedDb(cwd), access.target.key)!;
  expect(replacement.key).toBe(access.target.key);
  expect(replacement.id).not.toBe(sourceId);
  expect(replacement.claude_session_id).toBe("scoped-after-forget");
  await finishStaleExtraction();
}, 30_000);

test("a released extractor still persists its fact when the source conversation remains current", async () => {
  const access = sessionAccess(target());
  await access.create("scoped-still-current");
  const sourceId = await beginExtraction(access.target.key);
  releaseExtraction!();
  expect(await completion).toEqual([fact]);
  const db = await getSharedDb(cwd);
  expect(getByKey(db, access.target.key)?.id).toBe(sourceId);
  expect(
    db
      .query("SELECT scope, key, value, source_session_id FROM memory_entries WHERE value = ?")
      .all(fact.value)
  ).toEqual([{ ...fact, source_session_id: sourceId }]);
  expect(await readFile(crossSessionMemoryFile(cwd), "utf8")).toBe(sharedNote);
}, 30_000);
