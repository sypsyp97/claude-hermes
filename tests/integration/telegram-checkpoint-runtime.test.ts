import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { poll, handleMyChatMember, stopPolling } from "../../src/commands/telegram";
import { telegramCheckpoint } from "../../src/adapters/telegram/checkpoint";
import { getSharedDb, resetSharedDbCache } from "../../src/state/shared-db";
import { upsertPolicy } from "../../src/state/repos/policies";
import { reloadSettings } from "../../src/config";
import { withBridgeSignal } from "../../src/runtime/bridge-context";

const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;
const originalBin = process.env.HERMES_CLAUDE_BIN;
let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "hermes-telegram-recovery-"));
  await mkdir(join(cwd, ".claude/hermes"), { recursive: true });
  await writeFile(
    join(cwd, ".claude/hermes/settings.json"),
    JSON.stringify({ telegram: { token: "123:fake", allowedUserIds: [1] } })
  );
  process.chdir(cwd);
  process.env.HERMES_CLAUDE_BIN = "must-not-execute-recovered-requests";
  await reloadSettings();
});
afterEach(async () => {
  stopPolling();
  globalThis.fetch = originalFetch;
  if (originalBin === undefined) delete process.env.HERMES_CLAUDE_BIN;
  else process.env.HERMES_CLAUDE_BIN = originalBin;
  await resetSharedDbCache();
  process.chdir(originalCwd);
  await rm(cwd, { recursive: true, force: true });
});

test("poll restart reports uncertain delivery and resumes its durable offset without agent replay", async () => {
  let db = await getSharedDb();
  const receipt = { updateId: 41, chatId: 1, userId: 1, messageId: 5, isDm: true };
  telegramCheckpoint(db, "123").admit(receipt);
  telegramCheckpoint(db, "123").admit({ updateId: 42, chatId: 9, userId: 9, messageId: 6, isDm: true });
  telegramCheckpoint(db, "123").admit({ updateId: 43, chatId: -10, userId: 1, messageId: 7, isDm: false });
  await resetSharedDbCache();
  db = await getSharedDb();
  const sent: Record<string, unknown>[] = [];
  const offsets: number[] = [];
  const controller = new AbortController();
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (String(url).endsWith("/getMe"))
      return Response.json({ ok: true, result: { id: 123, username: "hermes" } });
    if (String(url).endsWith("/sendMessage")) sent.push(body);
    if (String(url).endsWith("/getUpdates")) {
      offsets.push(body.offset);
      controller.abort();
      return Response.json({ ok: true, result: [] });
    }
    return Response.json({ ok: true, result: { message_id: 10 } });
  }) as typeof fetch;
  await withBridgeSignal(controller.signal, () => poll(controller.signal));
  expect(offsets).toEqual([44]);
  expect(sent).toHaveLength(1);
  expect(sent[0].chat_id).toBe(1);
  expect(sent[0].text).toContain("may have partially run");
  expect(sent[0].reply_parameters).toEqual({ message_id: 5, allow_sending_without_reply: true });
  expect(telegramCheckpoint(db, "123").pending()).toEqual([]);
  expect(db.query("SELECT * FROM messages").all()).toEqual([]);
});

test("group membership events honor sender authorization and delivery-only policy", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    requests.push(String(url));
    return Response.json({ ok: true });
  }) as typeof fetch;
  const update = {
    chat: { id: -1, type: "supergroup", title: "Group" },
    from: { id: 9, first_name: "Unlisted" },
    old_chat_member: { status: "left" as const, user: { id: 123, first_name: "Bot" } },
    new_chat_member: { status: "member" as const, user: { id: 123, first_name: "Bot" } },
  };
  await handleMyChatMember(update);
  upsertPolicy(await getSharedDb(), { source: "telegram", channel: "-1" }, { mode: "delivery-only" });
  await handleMyChatMember({ ...update, from: { id: 1, first_name: "Allowed" } });
  expect(requests).toEqual([]);
  expect((await getSharedDb()).query("SELECT * FROM sessions").all()).toEqual([]);
});
