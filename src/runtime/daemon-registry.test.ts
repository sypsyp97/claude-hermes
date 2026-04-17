import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DaemonEntry, listDaemons, registerDaemon, unregisterDaemon } from "./daemon-registry";

let dir: string;
let registryPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hermes-reg-"));
  registryPath = join(dir, "daemons.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("daemon-registry — basic CRUD", () => {
  test("listDaemons on missing file returns empty array", async () => {
    expect(await listDaemons({ path: registryPath })).toEqual([]);
  });

  test("registerDaemon writes a new entry that listDaemons returns", async () => {
    await registerDaemon({ pid: 111, cwd: "/proj/a" }, { path: registryPath });
    const list = await listDaemons({ path: registryPath });
    expect(list.length).toBe(1);
    expect(list[0].pid).toBe(111);
    expect(list[0].cwd).toBe("/proj/a");
    expect(typeof list[0].startedAt).toBe("string");
  });

  test("two registers under different pids both end up in the registry", async () => {
    await registerDaemon({ pid: 111, cwd: "/a" }, { path: registryPath });
    await registerDaemon({ pid: 222, cwd: "/b" }, { path: registryPath });
    const list = await listDaemons({ path: registryPath });
    expect(list.map((d) => d.pid).sort()).toEqual([111, 222]);
  });

  test("re-register on the same pid replaces the previous entry (idempotent)", async () => {
    await registerDaemon({ pid: 111, cwd: "/old" }, { path: registryPath });
    await registerDaemon({ pid: 111, cwd: "/new" }, { path: registryPath });
    const list = await listDaemons({ path: registryPath });
    expect(list.length).toBe(1);
    expect(list[0].cwd).toBe("/new");
  });

  test("unregisterDaemon by pid removes the entry", async () => {
    await registerDaemon({ pid: 111, cwd: "/a" }, { path: registryPath });
    await registerDaemon({ pid: 222, cwd: "/b" }, { path: registryPath });
    await unregisterDaemon(111, { path: registryPath });
    const list = await listDaemons({ path: registryPath });
    expect(list.length).toBe(1);
    expect(list[0].pid).toBe(222);
  });

  test("unregisterDaemon on a missing pid is a no-op", async () => {
    await registerDaemon({ pid: 111, cwd: "/a" }, { path: registryPath });
    await expect(unregisterDaemon(999, { path: registryPath })).resolves.toBeUndefined();
    const list = await listDaemons({ path: registryPath });
    expect(list.map((d) => d.pid)).toEqual([111]);
  });

  test("removing the last entry deletes the file", async () => {
    await registerDaemon({ pid: 111, cwd: "/a" }, { path: registryPath });
    await unregisterDaemon(111, { path: registryPath });
    await expect(readFile(registryPath, "utf8")).rejects.toThrow();
  });
});

describe("daemon-registry — concurrent writers", () => {
  // Mirrors the sessionManager legacy-JSON fix: two processes that hit
  // register() at exactly the same moment must both end up in the file.
  // Without serialization, the second writer clobbers the first.
  test("concurrent registerDaemon for two pids: both survive", async () => {
    await Promise.all([
      registerDaemon({ pid: 111, cwd: "/a" }, { path: registryPath }),
      registerDaemon({ pid: 222, cwd: "/b" }, { path: registryPath }),
    ]);
    const list = await listDaemons({ path: registryPath });
    expect(list.map((d) => d.pid).sort()).toEqual([111, 222]);
  });

  test("concurrent register + unregister on different pids: state is consistent", async () => {
    await registerDaemon({ pid: 111, cwd: "/a" }, { path: registryPath });
    await Promise.all([
      registerDaemon({ pid: 222, cwd: "/b" }, { path: registryPath }),
      unregisterDaemon(111, { path: registryPath }),
    ]);
    const list = await listDaemons({ path: registryPath });
    expect(list.map((d) => d.pid)).toEqual([222]);
  });
});

describe("daemon-registry — malformed file recovery", () => {
  test("garbage JSON: listDaemons returns empty (does not throw)", async () => {
    await writeFile(registryPath, "not valid json {", "utf8");
    const list = await listDaemons({ path: registryPath });
    expect(list).toEqual([]);
  });

  test("garbage JSON gets overwritten cleanly on next register", async () => {
    await writeFile(registryPath, "garbage", "utf8");
    await registerDaemon({ pid: 111, cwd: "/a" }, { path: registryPath });
    const list = await listDaemons({ path: registryPath });
    expect(list.length).toBe(1);
    expect(list[0].pid).toBe(111);
  });

  test("entries without required fields are dropped on read", async () => {
    await writeFile(
      registryPath,
      JSON.stringify({ daemons: [{ pid: 111, cwd: "/a", startedAt: "x" }, { pid: "bogus" }, {}] }),
      "utf8"
    );
    const list = await listDaemons({ path: registryPath });
    expect(list.length).toBe(1);
    expect(list[0].pid).toBe(111);
  });
});

describe("daemon-registry — DaemonEntry shape contract", () => {
  test("entries have pid (number), cwd (string), startedAt (ISO-ish)", async () => {
    await registerDaemon({ pid: 111, cwd: "/a" }, { path: registryPath });
    const list = await listDaemons({ path: registryPath });
    const entry: DaemonEntry = list[0];
    expect(typeof entry.pid).toBe("number");
    expect(typeof entry.cwd).toBe("string");
    expect(entry.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
