import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings } from "./config";
import { run, compactCurrentSession } from "./runner";
import { bridgeSignal, withBridgeSignal } from "./runtime/bridge-context";
import { sessionAccess, type SessionTarget } from "./runtime/session-target";
import { createFakeSink } from "./status/sink";
import { getSharedDb, resetSharedDbCache } from "./state/shared-db";

const originalCwd = process.cwd();
const originalBin = process.env.HERMES_CLAUDE_BIN;
const originalOutput = process.env.HERMES_TEST_OUTPUT;
let cwd: string;
let callsFile: string;

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "hermes-runner-protocol-"));
  callsFile = join(cwd, "calls.jsonl");
  await mkdir(join(cwd, ".claude/hermes"), { recursive: true });
  await writeFile(
    join(cwd, ".claude/hermes/settings.json"),
    JSON.stringify({
      model: "",
      api: "",
      fallback: { model: "", api: "" },
      agentic: { enabled: false, defaultMode: "implementation", modes: [] },
      security: { level: "locked", allowedTools: [], disallowedTools: [] },
      heartbeat: { enabled: false },
      telegram: { token: "" },
      discord: { token: "" },
    })
  );
  const script = join(cwd, "fake-protocol.ts");
  await writeFile(
    script,
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write(process.env.HERMES_TEST_OUTPUT ?? "");`
  );
  process.env.HERMES_CLAUDE_BIN = `${process.execPath} ${script}`;
  process.chdir(cwd);
  await loadSettings();
});

afterAll(async () => {
  await resetSharedDbCache();
  process.chdir(originalCwd);
  if (originalBin === undefined) delete process.env.HERMES_CLAUDE_BIN;
  else process.env.HERMES_CLAUDE_BIN = originalBin;
  if (originalOutput === undefined) delete process.env.HERMES_TEST_OUTPUT;
  else process.env.HERMES_TEST_OUTPUT = originalOutput;
  await rm(cwd, { recursive: true, force: true });
});

function target(key: string): SessionTarget {
  return {
    key: `thread:cli:${key}`,
    source: "cli",
    scope: "per-thread",
    thread: key,
    workspace: cwd,
    memoryScope: "none",
  };
}

async function calls(): Promise<string[]> {
  return (await readFile(callsFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
}

test("buffered exit zero without a terminal result fails without saving or replaying a turn", async () => {
  const incomplete = [
    "",
    "diagnostic only\n",
    JSON.stringify({ type: "system", subtype: "init", session_id: "partial" }),
    JSON.stringify({ type: "result", subtype: "success", session_id: "partial" }),
    JSON.stringify({ type: "result", subtype: "success", session_id: "partial", result: null }),
  ];
  for (const resumed of [false, true]) {
    for (const [index, output] of incomplete.entries()) {
      const conversation = target(`incomplete-${resumed}-${index}`);
      const session = sessionAccess(conversation);
      if (resumed) await session.create("existing");
      process.env.HERMES_TEST_OUTPUT = output;
      const before = (await calls()).length;
      const result = await run("incomplete", "hello", conversation);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("without a result");
      expect((await calls()).length).toBe(before + 1);
      expect((await session.peek())?.sessionId ?? null).toBe(resumed ? "existing" : null);
      expect((await session.peek())?.turnCount ?? 0).toBe(0);
      const db = await getSharedDb(cwd);
      expect(
        db
          .query<{ count: number }, [string]>(
            "SELECT count(*) AS count FROM messages m JOIN sessions s ON m.session_id = s.id WHERE s.key = ?"
          )
          .get(conversation.key)?.count
      ).toBe(0);
    }
  }
});

test("new buffered NDJSON extracts its final reply and persists the resumable session", async () => {
  const conversation = target("ndjson");
  process.env.HERMES_TEST_OUTPUT = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "initial" }),
    JSON.stringify({ type: "result", subtype: "success", session_id: "final", result: "visible reply" }),
  ].join("\n");
  const result = await run("ndjson", "hello", conversation);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("visible reply");
  expect((await sessionAccess(conversation).peek())?.sessionId).toBe("final");
});

test("legacy typed-less failure envelopes do not become successful buffered turns", async () => {
  const conversation = target("legacy-error");
  process.env.HERMES_TEST_OUTPUT = JSON.stringify({
    session_id: "failed",
    is_error: true,
    result: "Provider refused the request",
  });
  const result = await run("legacy-error", "hello", conversation);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Provider refused the request");
  expect(await sessionAccess(conversation).peek()).toBeNull();
});

test("explicit empty buffered results remain successful", async () => {
  const conversation = target("empty-result");
  process.env.HERMES_TEST_OUTPUT = JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "empty",
    result: "",
  });
  const result = await run("empty-result", "hello", conversation);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("");
  expect((await sessionAccess(conversation).peek())?.sessionId).toBe("empty");
});

test("compact cancellation after opening status always closes the sink", async () => {
  const conversation = target("compact-aborted");
  await sessionAccess(conversation).create("compact");
  const controller = new AbortController();
  const sink = createFakeSink();
  const open = sink.open;
  sink.open = async (...args) => {
    await open(...args);
    controller.abort(new Error("cancel compact"));
  };
  const before = (await calls()).length;
  await expect(
    withBridgeSignal(controller.signal, () => compactCurrentSession({ target: conversation, sink }))
  ).rejects.toThrow("cancel compact");
  expect(sink.calls.at(-1)).toEqual({ kind: "close", result: expect.objectContaining({ ok: false }) });
  expect((await calls()).length).toBe(before);
  expect(bridgeSignal()).toBeUndefined();
});
