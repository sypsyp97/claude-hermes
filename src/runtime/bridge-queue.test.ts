import { expect, test } from "bun:test";
import { enqueueBridge, prepareBridgeTransfer } from "./bridge-queue";

test("failed creation releases every observed destination without running the first turn", async () => {
  let ran = false;
  const transfer = prepareBridgeTransfer("test", async () => {
    ran = true;
  });
  transfer.reserve("failed-topic");
  const control = enqueueBridge("test", "failed-topic", async () => "control");
  transfer.cancel();
  expect(await control).toBe("control");
  expect(ran).toBe(false);
});

test("only the confirmed destination executes the first turn ahead of its controls", async () => {
  const events: string[] = [];
  const transfer = prepareBridgeTransfer<string>("test", async (value) => {
    events.push(value);
  });
  transfer.reserve("unrelated-topic");
  transfer.reserve("new-topic");
  const control = enqueueBridge("test", "new-topic", async () => {
    events.push("control");
  });
  await transfer.complete("new-topic", "first");
  await control;
  await enqueueBridge("test", "unrelated-topic", async () => {});
  expect(events).toEqual(["first", "control"]);
});
