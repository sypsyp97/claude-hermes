import { expect, test } from "bun:test";
import { pollUpdates } from "./polling";
import { telegramApi } from "../../commands/telegram-api";

test("failed durable admission never acknowledges or handles the update", async () => {
  const controller = new AbortController();
  const handled: number[] = [];
  const offsets: number[] = [];
  await pollUpdates({
    signal: controller.signal,
    request: async () => [{ update_id: 1 }],
    admit: async () => {
      throw new Error("disk full");
    },
    handle: async (u) => {
      handled.push(u.update_id);
      controller.abort();
    },
    onOffset: (offset) => {
      offsets.push(offset);
    },
    onError: () => controller.abort(),
  });
  expect(offsets).toEqual([]);
  expect(handled).toEqual([]);
});

test("polling honors retry_after even when API retries are disabled", async () => {
  const controller = new AbortController();
  const delays: number[] = [];
  await pollUpdates({
    signal: controller.signal,
    request: async () => {
      const data = await telegramApi<{ result: { update_id: number }[] }>(
        "fake",
        "getUpdates",
        {},
        {
          maxRetries: 0,
          fetch: async () =>
            Response.json({ ok: false, error_code: 429, parameters: { retry_after: 60 } }, { status: 429 }),
        }
      );
      return data.result;
    },
    handle: async () => {},
    onError: () => {},
    sleep: async (ms: number) => {
      delays.push(ms);
      controller.abort();
    },
  });
  expect(delays).toEqual([60_000]);
}, 2000);

test("polling advances monotonically, ignores duplicate updates and does not wait for agent work", async () => {
  const controller = new AbortController();
  const offsets: number[] = [];
  const handled: number[] = [];
  await pollUpdates({
    signal: controller.signal,
    request: async (offset) => {
      offsets.push(offset);
      if (offsets.length === 1) return [{ update_id: 2 }, { update_id: 2 }, { update_id: 1 }];
      controller.abort();
      return [{ update_id: 3 }];
    },
    handle: (update) => {
      handled.push(update.update_id);
      return new Promise(() => {});
    },
    onError: () => {},
  });
  expect(offsets).toEqual([0, 3]);
  expect(handled).toEqual([2]);
});

test("stop interrupts retry backoff and prevents another poll", async () => {
  const controller = new AbortController();
  let calls = 0;
  const task = pollUpdates({
    signal: controller.signal,
    request: async () => {
      calls++;
      throw new Error("offline");
    },
    handle: async () => {},
    onError: () => controller.abort(),
  });
  await task;
  expect(calls).toBe(1);
});
