import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  withActiveConversation,
  cancelConversation,
  conversationPreference,
  setConversationPreference,
} from "./conversation-controls";
import { bridgeSignal, withBridgeSignal } from "./bridge-context";
import { telegramSessionTarget } from "../router/bridge-session";
import { resetSharedDbCache } from "../state/shared-db";
let cwd: string;
afterEach(async () => {
  await resetSharedDbCache();
  if (cwd) await rm(cwd, { recursive: true, force: true });
});
test("cancellation reaches only the active target and releases registration", async () => {
  cwd = await mkdtemp(join(tmpdir(), "hermes-control-"));
  const a = telegramSessionTarget({ workspace: cwd, chatId: 1, userId: 1, isDm: true });
  const b = telegramSessionTarget({ workspace: cwd, chatId: 2, userId: 2, isDm: true });
  const parent = new AbortController();
  await withBridgeSignal(parent.signal, () =>
    withActiveConversation(a, async () => {
      const signalA = bridgeSignal()!;
      await withActiveConversation(b, async () => {
        const signalB = bridgeSignal()!;
        expect(cancelConversation(b)).toBe(true);
        expect(signalB.aborted).toBe(true);
        expect(signalA.aborted).toBe(false);
        expect(parent.signal.aborted).toBe(false);
      });
      expect(cancelConversation(b)).toBe(false);
    })
  );
  expect(cancelConversation(a)).toBe(false);
});
test("model and verbosity persist per canonical conversation across DB reopen", async () => {
  cwd = await mkdtemp(join(tmpdir(), "hermes-control-"));
  const a = telegramSessionTarget({ workspace: cwd, chatId: 1, userId: 1, isDm: true });
  const b = telegramSessionTarget({ workspace: cwd, chatId: 2, userId: 2, isDm: true });
  await setConversationPreference(a, { model: "sonnet", verbose: true });
  await resetSharedDbCache();
  expect(await conversationPreference(a)).toEqual({ model: "sonnet", verbose: true });
  expect(await conversationPreference(b)).toEqual({});
  await setConversationPreference(a, { model: undefined });
  expect(await conversationPreference(a)).toEqual({ verbose: true });
});
