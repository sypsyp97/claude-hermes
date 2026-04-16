import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIG_CWD = process.cwd();
let tempRoot: string;
let pidModule: typeof import("./pid");
let pidPath: string;

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(join(tmpdir(), "hermes-pid-"));
  await fs.mkdir(join(tempRoot, ".claude", "hermes"), { recursive: true });
  process.chdir(tempRoot);
  pidModule = await import("./pid");
  pidPath = pidModule.getPidPath();
});

afterAll(async () => {
  process.chdir(ORIG_CWD);
  await fs.rm(tempRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  // Always start each test with no pid file.
  await fs.rm(pidPath, { force: true });
});

describe("getPidPath", () => {
  test("returns an absolute path inside the hermes dir", () => {
    const p = pidModule.getPidPath();
    expect(p).toContain(".claude");
    expect(p).toContain("hermes");
    expect(p).toContain("daemon.pid");
  });
});

describe("checkExistingDaemon", () => {
  test("returns null when no pid file exists", async () => {
    const result = await pidModule.checkExistingDaemon();
    expect(result).toBeNull();
  });

  test("returns process.pid after writePidFile()", async () => {
    await pidModule.writePidFile();
    const result = await pidModule.checkExistingDaemon();
    expect(result).toBe(process.pid);
  });

  test("stale pid (dead process) returns null and removes the file", async () => {
    // 999999 is almost guaranteed not to exist as an active PID on the test
    // host — process.kill() with signal 0 will throw ESRCH.
    await fs.writeFile(pidPath, "999999\n");
    expect(existsSync(pidPath)).toBe(true);
    const result = await pidModule.checkExistingDaemon();
    expect(result).toBeNull();
    expect(existsSync(pidPath)).toBe(false);
  });

  test("non-numeric garbage in pid file returns null and removes the file", async () => {
    await fs.writeFile(pidPath, "not-a-number\n");
    expect(existsSync(pidPath)).toBe(true);
    const result = await pidModule.checkExistingDaemon();
    expect(result).toBeNull();
    expect(existsSync(pidPath)).toBe(false);
  });

  test("empty pid file returns null and removes the file", async () => {
    await fs.writeFile(pidPath, "");
    const result = await pidModule.checkExistingDaemon();
    expect(result).toBeNull();
    expect(existsSync(pidPath)).toBe(false);
  });

  test("zero pid returns null and removes the file", async () => {
    await fs.writeFile(pidPath, "0\n");
    const result = await pidModule.checkExistingDaemon();
    expect(result).toBeNull();
    expect(existsSync(pidPath)).toBe(false);
  });
});

describe("writePidFile", () => {
  test("writes process.pid to the pid file", async () => {
    await pidModule.writePidFile();
    const raw = (await fs.readFile(pidPath, "utf-8")).trim();
    expect(raw).toBe(String(process.pid));
  });

  test("overwrites existing content", async () => {
    await fs.writeFile(pidPath, "12345\n");
    await pidModule.writePidFile();
    const raw = (await fs.readFile(pidPath, "utf-8")).trim();
    expect(raw).toBe(String(process.pid));
  });
});

describe("cleanupPidFile", () => {
  test("removes the pid file when it exists", async () => {
    await pidModule.writePidFile();
    expect(existsSync(pidPath)).toBe(true);
    await pidModule.cleanupPidFile();
    expect(existsSync(pidPath)).toBe(false);
  });

  test("is idempotent — silently succeeds when the file is already gone", async () => {
    await expect(pidModule.cleanupPidFile()).resolves.toBeUndefined();
    await expect(pidModule.cleanupPidFile()).resolves.toBeUndefined();
    await expect(pidModule.cleanupPidFile()).resolves.toBeUndefined();
  });
});
