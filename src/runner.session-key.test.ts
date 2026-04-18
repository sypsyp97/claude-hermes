import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmWithRetry } from "../tests/helpers/rm-with-retry";
import { threadKey, workspaceKey } from "./router/session-key";

/**
 * TDD red-phase test for Finding #2: the runner's `persistTurn` writes rows
 * keyed by either `queueKey(threadId, source)` (= `"<source>:<thread>"`) or
 * the bare `sessionId` (the opaque Claude session id) instead of the
 * router's canonical keys (`thread:<source>:<thread>` / `workspace:<hash>`
 * from `src/router/session-key.ts`). That means router-driven code looking
 * up `sessions.key = thread:telegram:123` finds nothing — two different
 * parts of the system write and read incompatible keys.
 *
 * We drive the runner with the fake-claude fixture, then open the shared DB
 * directly and assert on `sessions.key`.
 */

const ORIG_CWD = process.cwd();
const FAKE_CLAUDE_ABS = join(ORIG_CWD, "tests", "fixtures", "fake-claude.ts");

const MIN_SETTINGS = {
  model: "",
  api: "",
  fallback: { model: "", api: "" },
  agentic: { enabled: false, defaultMode: "implementation", modes: [] },
  timezone: "UTC",
  timezoneOffsetMinutes: 0,
  heartbeat: { enabled: false, interval: 15, prompt: "", excludeWindows: [], forwardToTelegram: false },
  telegram: { token: "", allowedUserIds: [] },
  discord: { token: "", allowedUserIds: [], listenChannels: [] },
  security: { level: "moderate", allowedTools: [], disallowedTools: [] },
  stt: { baseUrl: "", model: "" },
};

let tmpProj: string;
let runner: typeof import("./runner");
let sharedDb: typeof import("./state/shared-db");

beforeAll(async () => {
  tmpProj = mkdtempSync(join(tmpdir(), "hermes-runner-sk-"));
  process.chdir(tmpProj);
  mkdirSync(join(tmpProj, ".claude", "hermes", "logs"), { recursive: true });
  writeFileSync(join(tmpProj, ".claude", "hermes", "settings.json"), JSON.stringify(MIN_SETTINGS, null, 2));
  process.env.HERMES_CLAUDE_BIN = `bun run ${FAKE_CLAUDE_ABS}`;

  const config = await import("./config");
  await config.loadSettings();
  runner = await import("./runner");
  sharedDb = await import("./state/shared-db");
});

afterAll(async () => {
  const { resetSharedDbCache } = await import("./state/shared-db");
  await resetSharedDbCache();
  process.chdir(ORIG_CWD);
  delete process.env.HERMES_CLAUDE_BIN;
  delete process.env.HERMES_FAKE_SESSION_ID;
  delete process.env.HERMES_FAKE_REPLY;
  await rmWithRetry(tmpProj);
});

describe("runner persists to the router's canonical session key (Finding #2)", () => {
  test("thread run: persists row with key = thread:<source>:<threadId> and scope = per-thread", async () => {
    process.env.HERMES_FAKE_SESSION_ID = "claude-sess-thread-001";
    process.env.HERMES_FAKE_REPLY = "ok";

    const source = "telegram" as const;
    const threadId = "topic-42";
    const r = await runner.run("canonkey-thread", "hi", threadId, undefined, source);
    expect(r.exitCode).toBe(0);

    const db = await sharedDb.getSharedDb(tmpProj);
    const expectedKey = threadKey(source, threadId); // "thread:telegram:topic-42"
    const row = db
      .query<{ key: string; scope: string }, [string]>("SELECT key, scope FROM sessions WHERE key = ?")
      .get(expectedKey);
    expect(row).not.toBeNull();
    expect(row?.key).toBe(expectedKey);
    expect(row?.scope).toBe("per-thread");

    // And the buggy key (`<source>:<threadId>`) must NOT exist.
    const buggyKey = `${source}:${threadId}`;
    const buggyRow = db
      .query<{ key: string }, [string]>("SELECT key FROM sessions WHERE key = ?")
      .get(buggyKey);
    expect(buggyRow).toBeNull();
  });

  test("workspace run: persists row with key = workspaceKey(cwd) and scope = workspace", async () => {
    process.env.HERMES_FAKE_SESSION_ID = "claude-sess-ws-001";
    process.env.HERMES_FAKE_REPLY = "ok";

    const r = await runner.run("canonkey-ws", "hi");
    expect(r.exitCode).toBe(0);

    const db = await sharedDb.getSharedDb(tmpProj);
    const expectedKey = workspaceKey(process.cwd()); // "workspace:<12 hex>"
    const row = db
      .query<{ key: string; scope: string }, [string]>("SELECT key, scope FROM sessions WHERE key = ?")
      .get(expectedKey);
    expect(row).not.toBeNull();
    expect(row?.key).toBe(expectedKey);
    expect(row?.scope).toBe("workspace");

    // The bare Claude session id must NOT be used as a sessions.key.
    const buggyRow = db
      .query<{ key: string }, [string]>("SELECT key FROM sessions WHERE key = ?")
      .get("claude-sess-ws-001");
    expect(buggyRow).toBeNull();
  });
});
