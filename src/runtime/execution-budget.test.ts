import { expect, test } from "bun:test";
import { withExecutionSlot } from "./execution-budget";
import { runProcess } from "./process";
import { runClaudeStreaming } from "./claude-stream";
import { createFakeSink } from "../status/sink";

test("cancelled budget waiters settle before unrelated running work finishes", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;
  const holders = Array.from({ length: 4 }, () =>
    withExecutionSlot(async () => {
      entered++;
      await blocked;
    })
  );
  await Promise.resolve();
  expect(entered).toBe(4);
  const controller = new AbortController();
  let settled = 0;
  const work = [
    runProcess([process.execPath, "-e", "process.exit(99)"], { timeoutMs: 50, signal: controller.signal }),
    runClaudeStreaming({
      args: [],
      cwd: process.cwd(),
      sink: createFakeSink(),
      taskId: "cancelled",
      label: "cancelled",
      signal: controller.signal,
    }),
  ].map((p) =>
    p.then(
      () => {
        throw new Error("Cancelled work ran");
      },
      () => {
        settled++;
      }
    )
  );
  controller.abort();
  try {
    await Bun.sleep(30);
    expect(settled).toBe(2);
  } finally {
    release();
    await Promise.all([...holders, ...work]);
  }
  expect(await withExecutionSlot(async () => "next")).toBe("next");
});
