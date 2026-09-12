import { expect, test } from "bun:test";
import { runProcess } from "./process";

test("long subprocess work leaves the event loop responsive and is bounded", async () => {
  let ticked = false;
  const timer = setTimeout(() => {
    ticked = true;
  }, 10);
  const result = await runProcess([process.execPath, "-e", "await Bun.sleep(10000)"], { timeoutMs: 60 });
  clearTimeout(timer);
  expect(ticked).toBe(true);
  expect(result.exitCode).toBe(124);
});
