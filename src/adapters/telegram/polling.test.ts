import { expect, test } from "bun:test";
import { pollUpdates } from "./polling";

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
