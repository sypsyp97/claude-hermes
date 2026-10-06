import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = new URL("../../", import.meta.url).pathname;
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function deliver(args: string[], reply = "hello", rejectTelegram = false) {
  const directory = await mkdtemp(join(tmpdir(), "hermes-send-delivery-"));
  directories.push(directory);
  const state = join(directory, ".claude", "hermes");
  const callsFile = join(directory, "calls.json");
  await mkdir(state, { recursive: true });
  await writeFile(
    join(state, "settings.json"),
    JSON.stringify({
      telegram: { token: "fake-token", allowedUserIds: [123] },
      discord: { token: "fake-token", allowedUserIds: ["123"] },
    })
  );
  await writeFile(
    join(state, "session.json"),
    JSON.stringify({
      sessionId: "fake-existing-session",
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      turnCount: 0,
    })
  );
  await writeFile(callsFile, "[]");
  const script = `
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({url:String(url), body:JSON.parse(String(init.body))});
      await Bun.write(${JSON.stringify(callsFile)}, JSON.stringify(calls));
      if (String(url).includes("api.telegram.org")) return Response.json(${JSON.stringify(
        rejectTelegram
          ? { ok: false, error_code: 403, description: "Forbidden" }
          : { ok: true, result: { message_id: 1 } }
      )});
      if (String(url).endsWith("/users/@me/channels")) return Response.json({id:"456"});
      if (String(url).endsWith("/channels/456/messages")) return Response.json({id:"789"});
      throw new Error("Unexpected mocked URL: " + url);
    };
    const {send} = await import(${JSON.stringify(join(repo, "src/commands/send.ts"))});
    await send(${JSON.stringify(args)});
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: directory,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: join(directory, "claude-config"),
      HERMES_SKIP_PREFLIGHT: "1",
      HERMES_CLAUDE_BIN: `${process.execPath} run ${join(repo, "tests/fixtures/fake-claude.ts")}`,
      HERMES_FAKE_REPLY: reply,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const calls = JSON.parse(await readFile(callsFile, "utf8")) as {
      url: string;
      body: Record<string, any>;
    }[];
    return { exitCode, stdout, stderr, calls };
  } finally {
    clearTimeout(timer);
  }
}

describe("send CLI delivery", () => {
  test("Discord forwards the complete reply with mentions suppressed", async () => {
    const reply = "a".repeat(1999) + "😀" + "b".repeat(2500) + "@everyone END";
    const result = await deliver(["hello", "--discord", "--to", "123"], reply);
    expect(result.exitCode).toBe(0);
    const messages = result.calls.filter((call) => call.url.endsWith("/messages"));
    expect(messages.map((call) => call.body.content).join("")).toBe(reply);
    for (const message of messages) {
      expect(message.body.allowed_mentions).toEqual({ parse: [] });
      expect(message.body.content.length).toBeLessThanOrEqual(2000);
      expect(message.body.content.isWellFormed()).toBe(true);
    }
  });

  test("Telegram splits long replies into accepted message sizes", async () => {
    const reply = "x".repeat(8500) + "END";
    const result = await deliver(["hello", "--telegram", "--to", "123"], reply);
    expect(result.exitCode).toBe(0);
    expect(result.calls.map((call) => call.body.text).join("")).toBe(reply);
    expect(result.calls.every((call) => call.body.text.length <= 4096)).toBe(true);
  });

  test("Telegram API errors inside HTTP 200 make CLI delivery fail", async () => {
    const result = await deliver(["hello", "--telegram", "--to", "123"], "hello", true);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("Sent to Telegram");
    expect(result.calls).toHaveLength(1);
  });

  test("a delivery flag cannot be consumed as the --to value", async () => {
    const result = await deliver(["hello", "--to", "--discord"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--to requires a user id");
    expect(result.stdout).toBe("");
    expect(result.calls).toEqual([]);
  });

  test("--to without a delivery platform fails before invoking Claude", async () => {
    const result = await deliver(["hello", "--to", "123"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--telegram or --discord");
    expect(result.stdout).toBe("");
    expect(result.calls).toEqual([]);
  });
});
