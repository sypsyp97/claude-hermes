import { expect, test } from "bun:test";
import { deliverJobResult } from "./job-delivery";
const job = {
  name: "report",
  schedule: "* * * * *",
  prompt: "report",
  recurring: true,
  notify: true as const,
};
const result = { stdout: "report contents", stderr: "", exitCode: 0 };
test("explicit job targets bypass defaults and preserve Telegram topic", async () => {
  const sent: unknown[] = [];
  await deliverJobResult(
    { ...job, notifyChannel: "123", notifyTelegramChat: -100, notifyTelegramTopic: 42 },
    result,
    {
      discord: async (...args) => {
        sent.push(args);
      },
      telegram: async (...args) => {
        sent.push(args);
      },
      defaults: () => {
        throw new Error("must not broadcast");
      },
    }
  );
  expect(sent).toEqual([
    ["123", "[report]\nreport contents"],
    [-100, "[report]\nreport contents", 42],
  ]);
});
test("missing target transport never falls back to other recipients", async () => {
  let fallback = false;
  await expect(
    deliverJobResult({ ...job, notifyChannel: "123" }, result, {
      defaults: () => {
        fallback = true;
      },
    })
  ).rejects.toThrow("Discord");
  expect(fallback).toBe(false);
});
