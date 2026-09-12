import { expect, test } from "bun:test";
import { telegramApi } from "./telegram-api";

test("stopping during retry_after cancels the wait without another request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const request = telegramApi("fake", "getMe", undefined, {
    signal: controller.signal,
    fetch: async () => {
      calls++;
      setTimeout(() => controller.abort(new Error("stopped")), 10);
      return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 1 } });
    },
  });
  const outcome = await Promise.race([
    request.then(
      () => "resolved",
      (error: Error) => error.message
    ),
    Bun.sleep(100).then(() => "still waiting"),
  ]);
  expect(outcome).toBe("stopped");
  expect(calls).toBe(1);
});

test("429 honors retry_after and keeps the original request body", async () => {
  const delays: number[] = [];
  const bodies: unknown[] = [];
  const result = await telegramApi(
    "fake",
    "sendMessage",
    { chat_id: 1, text: "hi" },
    {
      sleep: async (ms) => {
        delays.push(ms);
      },
      fetch: async (_url, init) => {
        bodies.push(init.body);
        return bodies.length === 1
          ? Response.json({ ok: false, error_code: 429, parameters: { retry_after: 2 } }, { status: 429 })
          : Response.json({ ok: true, result: 1 });
      },
    }
  );
  expect(result).toEqual({ ok: true, result: 1 });
  expect(delays).toEqual([2000]);
  expect(bodies[0]).toBe(bodies[1]);
});

test("long polls abort when the transport hangs", async () => {
  await expect(
    telegramApi(
      "fake",
      "getUpdates",
      {},
      {
        timeoutMs: 10,
        maxRetries: 0,
        fetch: async (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
          }),
      }
    )
  ).rejects.toThrow();
});

test("safe reads retry transient failures with a bounded budget", async () => {
  let calls = 0;
  await expect(
    telegramApi(
      "fake",
      "getMe",
      {},
      {
        maxRetries: 2,
        sleep: async () => {},
        fetch: async () => {
          calls++;
          return Response.json({ ok: false }, { status: 503 });
        },
      }
    )
  ).rejects.toThrow("503");
  expect(calls).toBe(3);
});
