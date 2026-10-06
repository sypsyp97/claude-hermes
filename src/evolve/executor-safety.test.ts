import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeSelfEdit } from "./executor";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "hermes-executor-safety-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
async function fixture(name: string, code: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, code);
  return `${process.execPath} ${path}`;
}

describe("evolve subprocess safety", () => {
  test("a graceful zero exit after timeout is still failure", async () => {
    if (process.platform === "win32") return;
    const claudeBin = await fixture(
      "graceful.ts",
      'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);'
    );
    const result = await executeSelfEdit({
      prompt: "test",
      cwd: root,
      claudeBin,
      timeoutMs: 500,
      killEscalationMs: 100,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("timed out");
  });

  test("buffered execution strips parent-session signalling but preserves provider controls", async () => {
    const old = process.env.CLAUDECODE;
    const oldProvider = process.env.CLAUDE_CODE_USE_BEDROCK;
    process.env.CLAUDECODE = "parent-session-test";
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    try {
      const claudeBin = await fixture(
        "environment.ts",
        "console.log(JSON.stringify({ nested: process.env.CLAUDECODE ?? null, provider: process.env.CLAUDE_CODE_USE_BEDROCK }));"
      );
      const result = await executeSelfEdit({ prompt: "test", cwd: root, claudeBin });
      expect(JSON.parse(result.stdout)).toEqual({ nested: null, provider: "1" });
    } finally {
      if (old === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = old;
      if (oldProvider === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
      else process.env.CLAUDE_CODE_USE_BEDROCK = oldProvider;
    }
  });

  test("UTF-8 split across pipe chunks is decoded without corruption", async () => {
    const claudeBin = await fixture(
      "utf8.ts",
      'const b = Buffer.from("你好"); process.stdout.write(b.subarray(0, 2)); setTimeout(() => process.stdout.write(b.subarray(2)), 50);'
    );
    const result = await executeSelfEdit({ prompt: "test", cwd: root, claudeBin });
    expect(result.stdout).toBe("你好");
  });
});

test("timeout does not wait for inherited pipes after the direct child exits", async () => {
  const claudeBin = await fixture(
    "inherited-pipes.ts",
    `
    Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 1500)"], {
      stdin: "ignore", stdout: "inherit", stderr: "inherit"
    }).unref();
    process.exit(0);
  `
  );
  const started = Date.now();
  const result = await executeSelfEdit({ prompt: "test", cwd: root, claudeBin, timeoutMs: 200 });
  expect(result.exitCode).toBe(124);
  expect(Date.now() - started).toBeLessThan(1000);
});
