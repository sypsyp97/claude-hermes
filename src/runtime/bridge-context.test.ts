import { expect, test } from "bun:test";
import { withBridgeSignal } from "./bridge-context";
import { telegramApi } from "../commands/telegram-api";

test("lifecycle cancellation reaches an in-flight API body without threading every call", async () => {
  const controller = new AbortController();
  const result = withBridgeSignal(controller.signal, () =>
    telegramApi(
      "fake",
      "sendMessage",
      {},
      {
        timeoutMs: 100,
        maxRetries: 0,
        fetch: async () => {
          controller.abort(new Error("token rotated"));
          return { ok: true, json: () => new Promise(() => {}) } as unknown as Response;
        },
      }
    )
  );
  await expect(result).rejects.toThrow("token rotated");
});
