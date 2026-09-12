import { expect, test } from "bun:test";
import { formatContextUsage } from "./context-usage";

test("context uses the active model's reported window and deduplicates usage blocks", () => {
  const line = {
    message: {
      id: "m1",
      model: "opus",
      usage: { input_tokens: 1000, cache_read_input_tokens: 2000, output_tokens: 25 },
    },
  };
  const raw = [
    line,
    line,
    { modelUsage: { opus: { contextWindow: 1000000 }, haiku: { contextWindow: 200000 } } },
  ]
    .map((x) => JSON.stringify(x))
    .join("\n");
  const report = formatContextUsage(raw, 2);
  expect(report).toContain("3,000 / 1,000,000");
  expect(report).toContain("Output (cumulative): 25");
  expect(report).toContain("Turns: 2");
});

test("absent capacity stays unknown instead of inventing a percentage", () => {
  const report = formatContextUsage(
    JSON.stringify({ message: { usage: { input_tokens: 500, output_tokens: 5 } } }),
    1
  );
  expect(report).toContain("not reported");
  expect(report).not.toContain("200,000");
  expect(report).not.toContain("%");
  expect(formatContextUsage("{partial", 0)).toBe("No usage data found.");
});
