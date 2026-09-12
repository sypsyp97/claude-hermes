/** Long polling owns input admission; conversation queues own agent execution. */
import { TelegramApiError } from "../../commands/telegram-api";
import { waitForRetry } from "../../runtime/http";

export async function pollUpdates<T extends { update_id: number }>(options: {
  signal: AbortSignal;
  request(offset: number): Promise<T[]>;
  handle(update: T): Promise<void>;
  onError(error: unknown): void;
  initialOffset?: number;
  getOffset?(): number;
  admit?(update: T): void | Promise<void>;
  onOffset?(offset: number): void;
  sleep?(ms: number): Promise<void>;
}): Promise<void> {
  let offset = options.initialOffset ?? 0;
  let failures = 0;
  while (!options.signal.aborted) {
    try {
      offset = options.getOffset?.() ?? offset;
      const updates = await options.request(offset);
      if (options.signal.aborted) break;
      failures = 0;
      for (const update of updates) {
        if (!Number.isSafeInteger(update.update_id) || update.update_id < offset) continue;
        await options.admit?.(update);
        if (options.signal.aborted) break;
        offset = update.update_id + 1;
        options.onOffset?.(offset);
        // Handlers admit work synchronously; slow agent turns must not block polling.
        void options.handle(update).catch(options.onError);
      }
    } catch (error) {
      if (options.signal.aborted) break;
      options.onError(error);
      if (options.signal.aborted) break;
      if (error instanceof TelegramApiError && [401, 403, 409].includes(error.code)) break;
      const delay =
        error instanceof TelegramApiError && error.retryAfterMs !== undefined
          ? error.retryAfterMs
          : Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)) * (1 + Math.random() * 0.5);
      try {
        await (options.sleep ?? ((ms) => waitForRetry(ms, options.signal)))(delay);
      } catch (error) {
        if (!options.signal.aborted) throw error;
      }
    }
  }
}
