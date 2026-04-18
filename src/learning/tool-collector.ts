/**
 * Tool collector — observes the StatusEvent stream from the Claude CLI's
 * stream-json parser, tracks tool_use_start / tool_use_end pairs by
 * `toolUseId`, and snapshots the result as `TrajectoryToolCall[]` for the
 * closed learning loop (see `./closed-loop`).
 *
 * Contract:
 *   - Snapshot order follows `tool_use_start` arrival, not `tool_use_end`.
 *   - An unmatched start is ok:false (pessimistic).
 *   - A `tool_use_end` for an unknown id is dropped.
 *   - First `tool_use_end` wins; later ones for the same id are ignored.
 *   - Non-tool events never mutate state.
 *   - `toolCalls()` returns a fresh array each call.
 */

import type { StatusEvent } from "../status/stream";
import type { TrajectoryToolCall } from "./closed-loop";

export interface ToolCollector {
  handleEvent(event: StatusEvent): void;
  toolCalls(): TrajectoryToolCall[];
}

interface Entry {
  id: string;
  name: string;
  ended: boolean;
  ok: boolean;
}

export function createToolCollector(): ToolCollector {
  const entries: Entry[] = [];

  return {
    handleEvent(event: StatusEvent): void {
      if (event.kind === "tool_use_start") {
        entries.push({
          id: event.toolUseId,
          name: event.name,
          ended: false,
          ok: false,
        });
        return;
      }
      if (event.kind === "tool_use_end") {
        const entry = entries.find((e) => e.id === event.toolUseId && !e.ended);
        if (!entry) return;
        entry.ended = true;
        entry.ok = event.ok;
      }
    },
    toolCalls(): TrajectoryToolCall[] {
      return entries.map((e) => ({ name: e.name, ok: e.ok }));
    },
  };
}
