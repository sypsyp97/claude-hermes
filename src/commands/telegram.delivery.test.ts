import { afterEach, expect, test } from "bun:test";
import { sendMessage } from "./telegram";

const originalFetch = globalThis.fetch;
test("split boundaries do not reinterpret literal Markdown as formatting", async () => {
  const delivered: string[] = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    delivered.push(body.text);
    return Response.json({ ok: true, result: { message_id: delivered.length } });
  }) as unknown as typeof fetch;
  const input = "a".repeat(4000) + "> literal";
  await sendMessage("fake", 1, input);
  expect(delivered.join("")).toBe(input);
});
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

test("long messages retain every source character through formatting rejection", async () => {
  const delivered: string[] = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (body.parse_mode)
      return Response.json(
        { ok: false, error_code: 400, description: "can't parse entities" },
        { status: 400 }
      );
    delivered.push(body.text);
    return Response.json({ ok: true, result: { message_id: delivered.length } });
  }) as unknown as typeof fetch;
  const input = "<&>".repeat(2000) + "END";
  await sendMessage("fake", 1, input);
  expect(delivered.join("")).toBe(input);
  expect(delivered.every((chunk) => chunk.length > 0 && chunk.length <= 4096)).toBe(true);
});
