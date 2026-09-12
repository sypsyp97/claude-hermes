/** Long polling owns input admission; conversation queues own agent execution. */
export async function pollUpdates<T extends { update_id: number }>(options: {
  signal: AbortSignal;
  request(offset: number): Promise<T[]>;
  handle(update: T): Promise<void>;
  onError(error: unknown): void;
  initialOffset?: number;
  onOffset?(offset: number): void;
}): Promise<void> {
  let offset = options.initialOffset ?? 0;
  let failures = 0;
  while (!options.signal.aborted) {
    try {
      const updates = await options.request(offset);
      if (options.signal.aborted) break;
      failures = 0;
      for (const update of updates) {
        if (!Number.isSafeInteger(update.update_id) || update.update_id < offset) continue;
        offset = update.update_id + 1;
        options.onOffset?.(offset);
        // Handlers admit work synchronously; slow agent turns must not block polling.
        void options.handle(update).catch(options.onError);
      }
    } catch (error) {
      if (options.signal.aborted) break;
      options.onError(error);
      if (options.signal.aborted) break;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)) * (1 + Math.random() * 0.5);
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          options.signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, delay);
        options.signal.addEventListener("abort", done, { once: true });
      });
    }
  }
}
