import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getSharedDb, resetSharedDbCache } from "../../state/shared-db";
import { telegramCheckpoint } from "./checkpoint";
let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "hermes-checkpoint-"));
});
afterEach(async () => {
  await resetSharedDbCache();
  await rm(cwd, { recursive: true, force: true });
});

test("receipt and checkpoint survive restart without replaying an uncertain request", async () => {
  const state = telegramCheckpoint(await getSharedDb(cwd), "bot-1");
  state.admit({ updateId: 41, chatId: 1, userId: 1, messageId: 5 });
  expect(state.offset()).toBe(42);
  await resetSharedDbCache();
  const reopened = telegramCheckpoint(await getSharedDb(cwd), "bot-1");
  expect(reopened.offset()).toBe(42);
  expect(reopened.pending()).toEqual([{ updateId: 41, chatId: 1, userId: 1, messageId: 5 }]);
  reopened.complete(41);
  expect(reopened.pending()).toEqual([]);
  expect(telegramCheckpoint(await getSharedDb(cwd), "bot-2").offset()).toBe(0);
});

test("idle checkpoints expire so Telegram's randomized update IDs can restart", async () => {
  const db = await getSharedDb(cwd);
  const state = telegramCheckpoint(db, "bot-1");
  state.admit({ updateId: 900 });
  db.exec("UPDATE kv SET updated_at = '2000-01-01T00:00:00.000Z'");
  expect(state.offset()).toBe(0);
  state.admit({ updateId: 10 });
  expect(state.offset()).toBe(11);
});
