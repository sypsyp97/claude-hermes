import { expect, test } from "bun:test";
import { createRenderer } from "./render";
import { createDiscordStatusSink } from "./sinks/discord";
test("answer preview is bounded, strips directives and keeps final output separate", () => {
  const renderer = createRenderer("chat", 0, { preview: true, verbose: false });
  renderer.apply({ kind: "text_delta", text: "The answer is 42 [send-file:/private/output" });
  expect(renderer.render(0)).toContain("The answer is 42");
  expect(renderer.render(0)).not.toContain("/private");
  renderer.apply({ kind: "text_delta", text: "]" + "x".repeat(8000) });
  expect(renderer.render(0).length).toBeLessThan(1900);
  expect(renderer.renderFinal({ ok: true }, 0)).not.toContain("The answer");
});
test("sink close waits for in-flight preview before its final edit", async () => {
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((r) => {
    started = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const edits: string[] = [];
  const sink = createDiscordStatusSink({
    channelId: "c",
    windowMs: 1,
    heartbeatMs: 0,
    preview: true,
    transport: {
      async postMessage() {
        return { id: "m" };
      },
      async deleteMessage() {},
      async patchMessage(_c, _m, text) {
        if (!text.includes("Done")) {
          started();
          await gate;
        }
        edits.push(text);
      },
    },
  });
  await sink.open("t", "chat");
  await sink.update({ kind: "text_delta", text: "draft answer" });
  await ready;
  const close = sink.close({ ok: true });
  await Bun.sleep(5);
  release();
  await close;
  expect(edits.at(-1)).toContain("Done");
});

test("cancellation during initial status posting closes the sink before returning", async () => {
  const { runClaudeStreaming } = await import("../runtime/claude-stream");
  const controller = new AbortController();
  let closed = false;
  const result = await runClaudeStreaming({
    args: [],
    cwd: process.cwd(),
    claudeBin: process.execPath,
    signal: controller.signal,
    taskId: "test",
    label: "cancel",
    sink: {
      async open() {
        controller.abort();
      },
      async update() {},
      async close() {
        closed = true;
      },
    },
  }).catch(() => ({ exitCode: -99 }));
  expect(closed).toBe(true);
  expect(result.exitCode).toBe(130);
});
