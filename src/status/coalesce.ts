/**
 * Coalescer — wraps a `flush` function behind a leading-debounce timer so
 * rapid bursts of `schedule()` calls produce at most one flush per window.
 *
 * Used by Discord/Telegram sinks to cap message-edit rate well below their
 * per-route limits (Discord ~5 edits/5s per channel, Telegram ~1/s per chat).
 *
 * Semantics:
 *
 *   - First `schedule()` arms a timer for `windowMs` ms.
 *   - Further `schedule()` calls while armed do nothing — the existing timer
 *     continues to its deadline and then fires exactly once.
 *   - On fire, `flush()` runs. Updates during a slow flush are coalesced into
 *     one later window; flushes never overlap or build an edit backlog.
 *     Exceptions are swallowed so one failed edit doesn't poison later events.
 *   - `forceFlush()` cancels the timer, waits for an in-flight flush, and sends
 *     any newer pending state. If nothing is pending or active, it's a no-op.
 *   - `dispose()` cancels without running.
 */

const DEFAULT_WINDOW_MS = 750;

export interface Coalescer {
  schedule(): void;
  forceFlush(): Promise<void>;
  dispose(): void;
}

export interface CoalescerOptions {
  windowMs?: number;
}

export function createCoalescer(
  flush: () => Promise<void>,
  options: CoalescerOptions = {},
): Coalescer {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let inFlight: Promise<void> | null = null;

  function arm(): void {
    if (timer !== null || inFlight !== null || !pending) return;
    timer = setTimeout(() => {
      timer = null;
      void runFlush();
    }, windowMs);
  }

  function cancelTimer(): void {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  }

  function runFlush(): Promise<void> {
    if (inFlight) return inFlight;
    if (!pending) return Promise.resolve();
    pending = false;
    // Start in a microtask so even a synchronous throw is tracked before the
    // completion handler clears inFlight and considers the next window.
    const task = Promise.resolve()
      .then(flush)
      .catch(() => {
        // Status display failures must never mask the underlying task result.
      })
      .finally(() => {
        inFlight = null;
        arm();
      });
    inFlight = task;
    return task;
  }

  return {
    schedule(): void {
      pending = true;
      arm();
    },

    async forceFlush(): Promise<void> {
      cancelTimer();
      if (inFlight) await inFlight;
      // Completion may have armed a trailing window while we were waiting.
      cancelTimer();
      await runFlush();
    },

    dispose(): void {
      cancelTimer();
      pending = false;
    },
  };
}
