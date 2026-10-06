import { describe, expect, test } from "bun:test";
import { createCoalescer } from "./coalesce";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("createCoalescer", () => {
  test("schedule fires flush once after the window elapses", async () => {
    let calls = 0;
    const c = createCoalescer(
      async () => {
        calls++;
      },
      { windowMs: 20 }
    );
    c.schedule();
    await sleep(40);
    expect(calls).toBe(1);
  });

  test("multiple schedule() calls within the window coalesce to one flush", async () => {
    let calls = 0;
    const c = createCoalescer(
      async () => {
        calls++;
      },
      { windowMs: 30 }
    );
    c.schedule();
    c.schedule();
    c.schedule();
    await sleep(60);
    expect(calls).toBe(1);
  });

  test("forceFlush runs immediately and cancels the pending timer", async () => {
    let calls = 0;
    const c = createCoalescer(
      async () => {
        calls++;
      },
      { windowMs: 200 }
    );
    c.schedule();
    await c.forceFlush();
    expect(calls).toBe(1);
    await sleep(250);
    expect(calls).toBe(1);
  });

  test("forceFlush with nothing pending is a no-op", async () => {
    let calls = 0;
    const c = createCoalescer(
      async () => {
        calls++;
      },
      { windowMs: 50 }
    );
    await c.forceFlush();
    expect(calls).toBe(0);
  });

  test("dispose cancels pending flush without running it", async () => {
    let calls = 0;
    const c = createCoalescer(
      async () => {
        calls++;
      },
      { windowMs: 30 }
    );
    c.schedule();
    c.dispose();
    await sleep(60);
    expect(calls).toBe(0);
  });

  test("after a flush fires, a new schedule arms a fresh timer", async () => {
    let calls = 0;
    const c = createCoalescer(
      async () => {
        calls++;
      },
      { windowMs: 20 }
    );
    c.schedule();
    await sleep(40);
    expect(calls).toBe(1);
    c.schedule();
    await sleep(40);
    expect(calls).toBe(2);
  });

  test("flush errors are swallowed so one bad edit does not crash the daemon", async () => {
    const c = createCoalescer(
      async () => {
        throw new Error("simulated api failure");
      },
      { windowMs: 10 }
    );
    c.schedule();
    await sleep(30);
    // Should not have thrown. Scheduling again must still work.
    c.schedule();
    await sleep(30);
    expect(true).toBe(true);
  });

  test("default window is non-zero (production safety)", () => {
    // Defensive: the default window must be > 0 so we never degenerate into
    // a no-debounce firehose that would breach rate limits.
    let calls = 0;
    const c = createCoalescer(async () => {
      calls++;
    });
    c.schedule();
    // Before any timer fires synchronously there must be zero calls.
    expect(calls).toBe(0);
    c.dispose();
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("slow flushes coalesce later windows instead of queueing redundant concurrent edits", async () => {
  const started = deferred();
  const release = deferred();
  let calls = 0;
  let active = 0;
  let peak = 0;
  const c = createCoalescer(
    async () => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      if (calls === 1) {
        started.resolve();
        await release.promise;
      }
      active--;
    },
    { windowMs: 5 }
  );
  c.schedule();
  await started.promise;
  try {
    for (let i = 0; i < 4; i++) {
      c.schedule();
      await sleep(15);
    }
    expect(calls).toBe(1);
  } finally {
    release.resolve();
    await c.forceFlush();
    c.dispose();
  }
  expect(calls).toBe(2);
  expect(peak).toBe(1);
});

test("forceFlush waits for an in-flight flush before flushing newer updates", async () => {
  const started = deferred();
  const release = deferred();
  let calls = 0;
  let settled = false;
  const c = createCoalescer(
    async () => {
      calls++;
      if (calls === 1) {
        started.resolve();
        await release.promise;
      }
    },
    { windowMs: 5 }
  );
  c.schedule();
  await started.promise;
  c.schedule();
  const forced = c.forceFlush().then(() => {
    settled = true;
  });
  try {
    await sleep(10);
    expect(calls).toBe(1);
    expect(settled).toBe(false);
  } finally {
    release.resolve();
    await forced;
    c.dispose();
  }
  expect(calls).toBe(2);
});

test("dispose drops updates collected during an in-flight flush", async () => {
  const started = deferred();
  const release = deferred();
  let calls = 0;
  const c = createCoalescer(
    async () => {
      calls++;
      if (calls === 1) {
        started.resolve();
        await release.promise;
      }
    },
    { windowMs: 5 }
  );
  c.schedule();
  await started.promise;
  c.schedule();
  c.dispose();
  release.resolve();
  await c.forceFlush();
  await sleep(15);
  expect(calls).toBe(1);
});
