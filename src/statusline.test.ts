import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// statusline.ts writes `state.json` into hermesDir(). We chdir into a tmp dir
// so the state file lands in a predictable, writable location.
const ORIG_CWD = process.cwd();
let tempRoot: string;
let statePath: string;
let sl: typeof import("./statusline");

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(join(tmpdir(), "hermes-statusline-"));
  await fs.mkdir(join(tempRoot, ".claude", "hermes"), { recursive: true });
  statePath = join(tempRoot, ".claude", "hermes", "state.json");
  process.chdir(tempRoot);
  sl = await import("./statusline");
});

afterAll(async () => {
  process.chdir(ORIG_CWD);
  await fs.rm(tempRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(statePath, { force: true });
});

describe("writeState", () => {
  test("writes a JSON file at .claude/hermes/state.json", async () => {
    await sl.writeState({
      jobs: [],
      security: "open",
      telegram: false,
      discord: false,
      startedAt: 123,
    });
    const raw = await fs.readFile(statePath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(raw.trim());
    expect(parsed.security).toBe("open");
    expect(parsed.telegram).toBe(false);
    expect(parsed.discord).toBe(false);
    expect(parsed.startedAt).toBe(123);
    expect(parsed.jobs).toEqual([]);
  });

  test("serialises heartbeat and jobs arrays verbatim", async () => {
    const state: import("./statusline").StateData = {
      heartbeat: { nextAt: 1_000 },
      jobs: [
        { name: "backup", nextAt: 2_000 },
        { name: "gc", nextAt: 3_000 },
      ],
      security: "locked",
      telegram: true,
      discord: true,
      startedAt: 42,
    };
    await sl.writeState(state);
    const parsed = JSON.parse((await fs.readFile(statePath, "utf8")).trim());
    expect(parsed.heartbeat).toEqual({ nextAt: 1_000 });
    expect(parsed.jobs).toEqual([
      { name: "backup", nextAt: 2_000 },
      { name: "gc", nextAt: 3_000 },
    ]);
    expect(parsed.security).toBe("locked");
    expect(parsed.telegram).toBe(true);
    expect(parsed.discord).toBe(true);
    expect(parsed.startedAt).toBe(42);
  });

  test("omits heartbeat when undefined", async () => {
    await sl.writeState({
      jobs: [],
      security: "open",
      telegram: false,
      discord: false,
      startedAt: 0,
    });
    const parsed = JSON.parse((await fs.readFile(statePath, "utf8")).trim());
    expect("heartbeat" in parsed).toBe(false);
  });

  test("overwrites any previous state", async () => {
    await sl.writeState({
      jobs: [],
      security: "first",
      telegram: false,
      discord: false,
      startedAt: 1,
    });
    await sl.writeState({
      jobs: [],
      security: "second",
      telegram: true,
      discord: true,
      startedAt: 999,
    });
    const parsed = JSON.parse((await fs.readFile(statePath, "utf8")).trim());
    expect(parsed.security).toBe("second");
    expect(parsed.telegram).toBe(true);
    expect(parsed.startedAt).toBe(999);
  });

  test("output is a single-line JSON followed by a newline", async () => {
    await sl.writeState({
      jobs: [{ name: "j", nextAt: 1 }],
      security: "s",
      telegram: false,
      discord: false,
      startedAt: 0,
    });
    const raw = await fs.readFile(statePath, "utf8");
    const lines = raw.split("\n");
    // One JSON line plus the trailing empty string from the final newline.
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("");
  });
});
