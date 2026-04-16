import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// sessionManager uses threadSessionsFile() which derives from process.cwd(). An
// internal module-level cache (`sessionsCache`) backs the file: tests must
// invalidate it by rewriting the underlying file between describe blocks. We
// chdir into a fresh tmp dir and reset the file via fs.writeFile to keep the
// cache-on-first-load behaviour predictable.
const ORIG_CWD = process.cwd();
let tempRoot: string;
let sessFile: string;
let mgr: typeof import("./sessionManager");

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(join(tmpdir(), "hermes-sessmgr-"));
  await fs.mkdir(join(tempRoot, ".claude", "hermes"), { recursive: true });
  sessFile = join(tempRoot, ".claude", "hermes", "sessions.json");
  process.chdir(tempRoot);
  mgr = await import("./sessionManager");
});

afterAll(async () => {
  process.chdir(ORIG_CWD);
  await fs.rm(tempRoot, { recursive: true, force: true });
});

// Reset persistent state + blow away the module cache before each test by
// rewriting the file to an empty shape. The loader reads from disk only when
// the internal cache is null OR mutates the cache on write; rewriting the file
// alone is NOT enough when a previous test populated the cache — so we also
// remove all known keys via removeThreadSession to drop cache entries.
async function clearSessions(): Promise<void> {
  const existing = await mgr.listThreadSessions().catch(() => []);
  for (const s of existing) {
    await mgr.removeThreadSession(s.threadId);
  }
  await fs.writeFile(sessFile, JSON.stringify({ threads: {} }, null, 2) + "\n");
}

beforeEach(async () => {
  await clearSessions();
});

describe("getThreadSession", () => {
  test("returns null when no session exists for the thread", async () => {
    const result = await mgr.getThreadSession("missing");
    expect(result).toBeNull();
  });

  test("returns the shape {sessionId, turnCount, compactWarned} after create", async () => {
    await mgr.createThreadSession("t1", "session-abc");
    const result = await mgr.getThreadSession("t1");
    expect(result).toEqual({
      sessionId: "session-abc",
      turnCount: 0,
      compactWarned: false,
    });
  });
});

describe("createThreadSession", () => {
  test("initialises turnCount=0 and compactWarned=false", async () => {
    await mgr.createThreadSession("t-init", "sess-1");
    const peek = await mgr.peekThreadSession("t-init");
    expect(peek).not.toBeNull();
    expect(peek?.turnCount).toBe(0);
    expect(peek?.compactWarned).toBe(false);
    expect(peek?.sessionId).toBe("sess-1");
    expect(peek?.threadId).toBe("t-init");
    expect(typeof peek?.createdAt).toBe("string");
    expect(typeof peek?.lastUsedAt).toBe("string");
  });

  test("overwrites an existing session when called twice with same threadId", async () => {
    await mgr.createThreadSession("t-same", "first");
    await mgr.createThreadSession("t-same", "second");
    const peek = await mgr.peekThreadSession("t-same");
    expect(peek?.sessionId).toBe("second");
  });
});

describe("removeThreadSession", () => {
  test("removes an existing session", async () => {
    await mgr.createThreadSession("t-del", "s");
    await mgr.removeThreadSession("t-del");
    expect(await mgr.peekThreadSession("t-del")).toBeNull();
  });

  test("is idempotent — removing a missing threadId does not throw", async () => {
    await expect(mgr.removeThreadSession("never-existed")).resolves.toBeUndefined();
    await mgr.removeThreadSession("never-existed");
    await mgr.removeThreadSession("never-existed");
  });
});

describe("incrementThreadTurn", () => {
  test("increments by 1 and returns the new value", async () => {
    await mgr.createThreadSession("t-inc", "sess");
    const first = await mgr.incrementThreadTurn("t-inc");
    expect(first).toBe(1);
    const second = await mgr.incrementThreadTurn("t-inc");
    expect(second).toBe(2);
    const third = await mgr.incrementThreadTurn("t-inc");
    expect(third).toBe(3);
  });

  test("returns 0 when the session is missing", async () => {
    const result = await mgr.incrementThreadTurn("ghost");
    expect(result).toBe(0);
  });

  test("persists the incremented count so peek sees it", async () => {
    await mgr.createThreadSession("t-persist", "sess");
    await mgr.incrementThreadTurn("t-persist");
    await mgr.incrementThreadTurn("t-persist");
    const peek = await mgr.peekThreadSession("t-persist");
    expect(peek?.turnCount).toBe(2);
  });
});

describe("listThreadSessions", () => {
  test("returns empty array when nothing created", async () => {
    const list = await mgr.listThreadSessions();
    expect(list).toEqual([]);
  });

  test("returns every thread session created", async () => {
    await mgr.createThreadSession("a", "sa");
    await mgr.createThreadSession("b", "sb");
    await mgr.createThreadSession("c", "sc");
    const list = await mgr.listThreadSessions();
    const ids = list.map((s) => s.threadId).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });
});

describe("peekThreadSession", () => {
  test("returns null for missing thread", async () => {
    expect(await mgr.peekThreadSession("nope")).toBeNull();
  });

  test("does NOT update lastUsedAt", async () => {
    await mgr.createThreadSession("t-peek", "sess");
    const before = (await mgr.peekThreadSession("t-peek"))?.lastUsedAt;
    // Wait long enough that a new Date().toISOString() would differ.
    await new Promise((r) => setTimeout(r, 10));
    await mgr.peekThreadSession("t-peek");
    await mgr.peekThreadSession("t-peek");
    const after = (await mgr.peekThreadSession("t-peek"))?.lastUsedAt;
    expect(after).toBe(before);
  });

  test("getThreadSession DOES update lastUsedAt", async () => {
    await mgr.createThreadSession("t-touch", "sess");
    const before = (await mgr.peekThreadSession("t-touch"))?.lastUsedAt;
    await new Promise((r) => setTimeout(r, 10));
    await mgr.getThreadSession("t-touch");
    const after = (await mgr.peekThreadSession("t-touch"))?.lastUsedAt;
    expect(after).not.toBe(before);
  });
});

describe("markThreadCompactWarned", () => {
  test("flips compactWarned from false to true", async () => {
    await mgr.createThreadSession("t-warn", "sess");
    await mgr.markThreadCompactWarned("t-warn");
    const peek = await mgr.peekThreadSession("t-warn");
    expect(peek?.compactWarned).toBe(true);
  });

  test("is a no-op on missing thread", async () => {
    await expect(mgr.markThreadCompactWarned("ghost")).resolves.toBeUndefined();
  });
});
