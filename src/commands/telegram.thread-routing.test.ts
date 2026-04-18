import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * TDD red-phase test for Finding #1: Telegram forum-topic threads must
 * persist into distinct sessions. Currently `src/commands/telegram.ts:870`
 * hardcodes the `threadId` argument to `undefined` when calling
 * `runUserMessage`, so `message.message_thread_id` (already parsed at
 * line 603) is silently dropped. Two topics in the same supergroup end up
 * sharing the daemon's workspace-level session.
 *
 * Source-inspection test: we don't have an exported handler to spy on yet,
 * so we assert on the literal source so the red state is unambiguous for
 * the fix agent. Once the fix wires `threadId` through, this test flips
 * green (the `undefined` positional argument disappears and `threadId` is
 * the 3rd argument instead).
 *
 * Fix agent: either
 *   (a) replace the 3rd argument of `runUserMessage("telegram", prefixedPrompt, undefined, statusSink, "telegram")`
 *       with `threadId !== undefined ? String(threadId) : undefined`, or
 *   (b) export `handleTelegramMessage` (or a helper) from `src/commands/telegram.ts`
 *       and write a direct unit test; either approach turns this red suite green
 *       because the undefined-literal assertion checks the source file text.
 */

const TELEGRAM_SRC = join(import.meta.dir, "telegram.ts");

describe("telegram forum-topic thread routing (Finding #1)", () => {
  test("runUserMessage call does not hardcode the threadId argument to undefined", async () => {
    const src = await readFile(TELEGRAM_SRC, "utf8");
    // The current red state looks exactly like this — the 3rd positional
    // arg is the bare literal `undefined`, which throws away
    // `message.message_thread_id`. A proper fix replaces that literal with
    // a real value (threadId, String(threadId), threadArg, etc).
    expect(src).not.toContain(
      'runUserMessage("telegram", prefixedPrompt, undefined, statusSink, "telegram")'
    );
  });

  test("telegram source threads `message_thread_id` into runUserMessage's 3rd arg", async () => {
    const src = await readFile(TELEGRAM_SRC, "utf8");
    // `threadId` is already parsed at line ~603 as `message.message_thread_id`.
    // After the fix, the runUserMessage call site must reference it (in any
    // form: `threadId`, `String(threadId)`, a `threadArg` local, etc.) in
    // the 3rd positional slot. We assert by locating the call and checking
    // the arg slot does not remain `undefined` literal.
    const idx = src.indexOf('runUserMessage("telegram",');
    expect(idx).toBeGreaterThan(-1);
    // Grab the slice from the call site to the closing paren of the call.
    const tail = src.slice(idx, idx + 400);
    // The 3rd argument sits between the 2nd and 3rd commas. The bug is
    // exactly `prefixedPrompt, undefined, statusSink`. Fix replaces the
    // `undefined` with a real expression.
    expect(tail).not.toMatch(/prefixedPrompt,\s*undefined,\s*statusSink/);
  });
});
