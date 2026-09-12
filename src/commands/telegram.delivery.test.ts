import { afterEach, expect, test } from "bun:test";
import { sendMessage } from "./telegram";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("an uncertain send failure is surfaced without resending as plain text", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error("connection reset");
  }) as unknown as typeof fetch;
  await expect(sendMessage("fake-token", 1, "hello")).rejects.toThrow();
  expect(calls).toBe(1);
});

test("an explicit Telegram formatting rejection falls back to plain text", async () => {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    if (bodies.length === 1)
      return new Response(
        JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }),
        { status: 400 }
      );
    return Response.json({ ok: true, result: { message_id: 1 } });
  }) as unknown as typeof fetch;
  await sendMessage("fake-token", 1, "**hello**");
  expect(bodies).toHaveLength(2);
  expect(bodies[1].parse_mode).toBeUndefined();
});

test("Telegram API errors inside HTTP 200 are surfaced", async () => {
  globalThis.fetch = (async () =>
    Response.json({ ok: false, error_code: 403, description: "Forbidden" })) as unknown as typeof fetch;
  await expect(sendMessage("fake-token", 1, "hello")).rejects.toThrow("403");
});
