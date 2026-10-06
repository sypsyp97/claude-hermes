import { expect, test } from "bun:test";
import { enqueueBridge, prepareBridgeTransfer } from "../src/runtime/bridge-queue";
import { withExecutionSlot } from "../src/runtime/execution-budget";

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

test("formal trace: abort between admission and continuation never starts work", async () => {
  const controller = new AbortController();
  let ran = false;
  const task = withExecutionSlot(async () => { ran = true; }, controller.signal);
  controller.abort(new Error("trace abort"));
  await expect(task).rejects.toThrow("trace abort");
  expect(ran).toBe(false);
  expect(await withExecutionSlot(async () => "slot recovered")).toBe("slot recovered");
});

test("formal trace: middle waiter cancellation preserves FIFO and capacity", async () => {
  const gates = Array.from({ length: 4 }, deferred);
  const tailGate = deferred();
  let active = 0;
  let highWater = 0;
  const holders = gates.map((gate) => withExecutionSlot(async () => {
    highWater = Math.max(highWater, ++active);
    try { await gate.promise; } finally { active--; }
  }));
  await flush();
  expect(active).toBe(4);
  const events: number[] = [];
  const controller = new AbortController();
  const waiters = [0, 1, 2].map((index) => withExecutionSlot(async () => {
    highWater = Math.max(highWater, ++active);
    events.push(index);
    try { await tailGate.promise; } finally { active--; }
  }, index === 1 ? controller.signal : undefined));
  const cancelled = waiters[1].then(() => "ran", () => "cancelled");
  try {
    controller.abort();
    expect(await cancelled).toBe("cancelled");
    expect(events).toEqual([]);
    gates[0].resolve();
    await flush();
    expect(events).toEqual([0]);
    gates[1].resolve();
    await flush();
    expect(events).toEqual([0, 2]);
    expect(highWater).toBe(4);
  } finally {
    for (const gate of gates) gate.resolve();
    tailGate.resolve();
    await Promise.allSettled([...holders, ...waiters]);
  }
  expect(active).toBe(0);
});

test("formal trace: old failed lane cleanup cannot erase a newer active tail", async () => {
  const firstGate = deferred();
  const secondGate = deferred();
  const events: number[] = [];
  const first = enqueueBridge("formal-replay", "stale-tail", async () => {
    await firstGate.promise;
    throw new Error("first failed");
  });
  const observedFirst = first.catch(() => {});
  const second = enqueueBridge("formal-replay", "stale-tail", async () => {
    events.push(2);
    await secondGate.promise;
  });
  let third: Promise<void> | undefined;
  try {
    firstGate.resolve();
    await observedFirst;
    await flush();
    expect(events).toEqual([2]);
    third = enqueueBridge("formal-replay", "stale-tail", async () => { events.push(3); });
    await flush();
    expect(events).toEqual([2]);
  } finally {
    firstGate.resolve();
    secondGate.resolve();
    await Promise.allSettled([observedFirst, second, ...(third ? [third] : [])]);
  }
  expect(events).toEqual([2, 3]);
});

test("formal trace: first resolution chooses one destination before later controls", async () => {
  const events: string[] = [];
  const transfer = prepareBridgeTransfer<string>("formal-transfer", async (value) => { events.push(value); });
  transfer.reserve("a");
  transfer.reserve("b");
  const aControl = enqueueBridge("formal-transfer", "a", async () => { events.push("control-a"); });
  const bControl = enqueueBridge("formal-transfer", "b", async () => { events.push("control-b"); });
  const a = transfer.complete("a", "first-a");
  const b = transfer.complete("b", "first-b");
  transfer.cancel();
  await Promise.all([a, b, aControl, bControl]);
  expect(events.filter((event) => event.startsWith("first-"))).toEqual(["first-a"]);
  expect(events.indexOf("first-a")).toBeLessThan(events.indexOf("control-a"));
});

test("formal trace: cancellation wins over later completion and releases reservations", async () => {
  let runs = 0;
  const transfer = prepareBridgeTransfer<string>("formal-cancel", async () => { runs++; });
  transfer.reserve("a");
  transfer.reserve("b");
  transfer.cancel();
  await Promise.all([transfer.complete("a", "ignored"), transfer.complete("b", "ignored")]);
  expect(await enqueueBridge("formal-cancel", "a", async () => "released-a")).toBe("released-a");
  expect(await enqueueBridge("formal-cancel", "b", async () => "released-b")).toBe("released-b");
  expect(runs).toBe(0);
});

test("formal trace: failed memory writer does not lose a newer tail", async () => {
  const { withMemoryFileLock } = await import("../src/memory/file-lock");
  const firstGate = deferred();
  const secondGate = deferred();
  const events: number[] = [];
  const first = withMemoryFileLock("formal-memory-lane", async () => {
    await firstGate.promise;
    throw new Error("first writer failed");
  });
  const observedFirst = first.catch(() => {});
  const second = withMemoryFileLock("formal-memory-lane", async () => {
    events.push(2);
    await secondGate.promise;
  });
  let third: Promise<void> | undefined;
  try {
    firstGate.resolve();
    await observedFirst;
    await flush();
    expect(events).toEqual([2]);
    third = withMemoryFileLock("formal-memory-lane", async () => { events.push(3); });
    await flush();
    expect(events).toEqual([2]);
    expect(await withMemoryFileLock("formal-other-memory-lane", async () => "independent")).toBe("independent");
  } finally {
    firstGate.resolve();
    secondGate.resolve();
    await Promise.allSettled([observedFirst, second, ...(third ? [third] : [])]);
  }
  expect(events).toEqual([2, 3]);
});
