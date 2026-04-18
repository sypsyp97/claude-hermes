/**
 * Tests for the tool-collector helper.
 *
 * Target module: `./tool-collector` (does not yet exist — these tests drive
 * its impl). The collector observes `StatusEvent`s coming off the status
 * stream parser, tracks `tool_use_start` / `tool_use_end` pairs, and snapshots
 * the resulting list as `TrajectoryToolCall[]` for the closed learning loop.
 *
 * Contract highlights:
 *   - Snapshot order follows `tool_use_start` arrival, not `tool_use_end`.
 *   - An unmatched start is ok:false (pessimistic).
 *   - An `tool_use_end` for an unknown id is dropped.
 *   - First `tool_use_end` wins; later ones for the same id are ignored.
 *   - Non-tool events never mutate state.
 *   - `toolCalls()` returns a fresh array each call.
 *
 * The impl agent fills in `src/learning/tool-collector.ts` later. Since the
 * module does not exist yet, we dynamic-import it in `beforeAll` via a
 * template-literal specifier (mirrors the pattern used in the other learning
 * tests) so biome's lint pass doesn't suggest a static import of a file that
 * isn't on disk.
 */

import { beforeAll, describe, expect, test } from "bun:test";

import type { StatusEvent } from "../status/stream";
import type { TrajectoryToolCall } from "./closed-loop";

let mod: any;

beforeAll(async () => {
  const specifier = `./tool-collector`;
  mod = await import(specifier);
});

function startEvent(
  toolUseId: string,
  name: string,
  input: unknown = {},
  label?: string
): Extract<StatusEvent, { kind: "tool_use_start" }> {
  return {
    kind: "tool_use_start",
    toolUseId,
    name,
    input,
    label: label ?? name,
  };
}

function endEvent(
  toolUseId: string,
  ok: boolean,
  errorShort?: string
): Extract<StatusEvent, { kind: "tool_use_end" }> {
  const event: Extract<StatusEvent, { kind: "tool_use_end" }> = {
    kind: "tool_use_end",
    toolUseId,
    ok,
  };
  if (errorShort !== undefined) event.errorShort = errorShort;
  return event;
}

describe("createToolCollector", () => {
  test("fresh collector has no tool calls", () => {
    const c = mod.createToolCollector();
    expect(c.toolCalls()).toEqual([] as TrajectoryToolCall[]);
  });

  test("tool_use_start + matching tool_use_end (ok=true) yields one ok entry", () => {
    const c = mod.createToolCollector();
    c.handleEvent(startEvent("u1", "Read"));
    c.handleEvent(endEvent("u1", true));
    expect(c.toolCalls()).toEqual([{ name: "Read", ok: true }]);
  });

  test("tool_use_start + matching tool_use_end (ok=false) yields one fail entry", () => {
    const c = mod.createToolCollector();
    c.handleEvent(startEvent("u1", "Bash"));
    c.handleEvent(endEvent("u1", false, "nonzero exit"));
    expect(c.toolCalls()).toEqual([{ name: "Bash", ok: false }]);
  });

  test("tool_use_start without matching end is pessimistically ok:false", () => {
    const c = mod.createToolCollector();
    c.handleEvent(startEvent("u1", "Grep"));
    expect(c.toolCalls()).toEqual([{ name: "Grep", ok: false }]);
  });

  test("tool_use_end with unknown toolUseId is ignored (no phantom entry)", () => {
    const c = mod.createToolCollector();
    c.handleEvent(endEvent("ghost", true));
    expect(c.toolCalls()).toEqual([]);
    // And it shouldn't leak into the next start either.
    c.handleEvent(startEvent("u1", "Read"));
    c.handleEvent(endEvent("u1", true));
    expect(c.toolCalls()).toEqual([{ name: "Read", ok: true }]);
  });

  test("order preserved by start order, not end order", () => {
    const c = mod.createToolCollector();
    c.handleEvent(startEvent("a", "Read"));
    c.handleEvent(startEvent("b", "Grep"));
    c.handleEvent(startEvent("c", "Bash"));
    // Ends arrive out of start-order: C, then B, then A.
    c.handleEvent(endEvent("c", true));
    c.handleEvent(endEvent("b", false));
    c.handleEvent(endEvent("a", true));
    expect(c.toolCalls()).toEqual([
      { name: "Read", ok: true },
      { name: "Grep", ok: false },
      { name: "Bash", ok: true },
    ]);
  });

  test("two tools with same name but different ids produce two entries", () => {
    const c = mod.createToolCollector();
    c.handleEvent(startEvent("u1", "Read"));
    c.handleEvent(startEvent("u2", "Read"));
    c.handleEvent(endEvent("u1", true));
    c.handleEvent(endEvent("u2", false));
    expect(c.toolCalls()).toEqual([
      { name: "Read", ok: true },
      { name: "Read", ok: false },
    ]);
  });

  test("duplicate tool_use_end for an already-ended call is ignored (first ok wins)", () => {
    const c = mod.createToolCollector();
    c.handleEvent(startEvent("u1", "Read"));
    c.handleEvent(endEvent("u1", true));
    // Later flip attempt — should be ignored.
    c.handleEvent(endEvent("u1", false, "late failure"));
    expect(c.toolCalls()).toEqual([{ name: "Read", ok: true }]);

    // And the reverse direction: first=false sticks even if a later true arrives.
    const c2 = mod.createToolCollector();
    c2.handleEvent(startEvent("u2", "Bash"));
    c2.handleEvent(endEvent("u2", false));
    c2.handleEvent(endEvent("u2", true));
    expect(c2.toolCalls()).toEqual([{ name: "Bash", ok: false }]);
  });

  test("non-tool events do not create entries or mutate state", () => {
    const c = mod.createToolCollector();
    const nonToolEvents: StatusEvent[] = [
      { kind: "task_start", sessionId: "s1", model: "sonnet" },
      { kind: "text_delta", text: "hello world" },
      { kind: "task_complete", result: "done", numTurns: 2, sessionId: "s1" },
      { kind: "error", message: "boom" },
    ];
    for (const ev of nonToolEvents) c.handleEvent(ev);
    expect(c.toolCalls()).toEqual([]);

    // Non-tool events interleaved with tool events don't nudge the list.
    c.handleEvent(startEvent("u1", "Read"));
    c.handleEvent({ kind: "text_delta", text: "reading..." });
    c.handleEvent(endEvent("u1", true));
    c.handleEvent({ kind: "task_complete", result: "done" });
    expect(c.toolCalls()).toEqual([{ name: "Read", ok: true }]);
  });

  test("toolCalls() returns a fresh array — mutating the return value does not leak", () => {
    const c = mod.createToolCollector();
    c.handleEvent(startEvent("u1", "Read"));
    c.handleEvent(endEvent("u1", true));

    const snap1 = c.toolCalls();
    expect(snap1).toEqual([{ name: "Read", ok: true }]);
    // Mutate the returned array aggressively.
    snap1.pop();
    snap1.push({ name: "Injected", ok: false });
    (snap1[0] as TrajectoryToolCall | undefined) && ((snap1[0] as TrajectoryToolCall).name = "Stomped");

    const snap2 = c.toolCalls();
    expect(snap2).toEqual([{ name: "Read", ok: true }]);
    // Also ensure snap2 is not the same reference as snap1.
    expect(snap2).not.toBe(snap1);
  });
});
