import { describe, expect, test } from "bun:test";

import { extractSessionAndResult, extractSessionAndResultFromText } from "./claude-output";

describe("extractSessionAndResult", () => {
  test("parses a single result envelope", () => {
    expect(
      extractSessionAndResult({
        type: "result",
        subtype: "success",
        session_id: "sess-1",
        result: "hello",
      })
    ).toEqual({ sessionId: "sess-1", result: "hello" });
  });

  test("parses an array of envelopes and prefers the result envelope's session", () => {
    expect(
      extractSessionAndResult([
        { type: "system", subtype: "init", session_id: "init-sid" },
        { type: "result", subtype: "success", session_id: "final-sid", result: "done" },
      ])
    ).toEqual({ sessionId: "final-sid", result: "done" });
  });
});

describe("extractSessionAndResultFromText", () => {
  test("parses NDJSON and returns only the final result text", () => {
    const raw = [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "partial" }],
          usage: {
            output_tokens: 1,
            cache_creation: { ephemeral_1h_input_tokens: 156, ephemeral_5m_input_tokens: 0 },
          },
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess-ndjson",
        uuid: "abc",
        total_cost_usd: 1.07,
        modelUsage: {
          "claude-sonnet-4-6": { outputTokens: 4295 },
        },
        result: "final visible reply",
      }),
    ].join("\n");

    expect(extractSessionAndResultFromText(raw)).toEqual({
      sessionId: "sess-ndjson",
      result: "final visible reply",
    });
  });

  test("parses a streaming line that contains a JSON array of envelopes", () => {
    const raw = JSON.stringify([
      { type: "system", subtype: "init", session_id: "sess-array" },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "thinking" }] } },
      { type: "result", subtype: "success", session_id: "sess-array", result: "array reply" },
    ]);

    expect(extractSessionAndResultFromText(raw)).toEqual({
      sessionId: "sess-array",
      result: "array reply",
    });
  });
});
