import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, del, insert, rename, strReplace, view } from "./agent-memory";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "hermes-agent-memory-safety-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

test("replacement strings are literal, including JavaScript replacement tokens", async () => {
  await create("notes.md", "before TARGET after", cwd);
  const replacement = "$& $$ $` $'";
  await strReplace("notes.md", "TARGET", replacement, cwd);
  expect(await view("notes.md", cwd)).toEqual({
    kind: "file",
    content: `before ${replacement} after`,
  });
});

test("concurrent creates cannot overwrite the first successful create", async () => {
  const results = await Promise.allSettled([
    create("notes.md", "first", cwd),
    create("notes.md", "second", cwd),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const winner = results[0]!.status === "fulfilled" ? "first" : "second";
  expect(await view("notes.md", cwd)).toEqual({ kind: "file", content: winner });
});

test("concurrent surgical edits preserve all independent changes", async () => {
  const tokens = Array.from({ length: 24 }, (_, i) => `token-${i}-end`);
  await create("notes.md", tokens.join("\n"), cwd);
  await Promise.all(tokens.map((token) => strReplace("notes.md", token, `edited-${token}`, cwd)));
  expect(await view("notes.md", cwd)).toEqual({
    kind: "file",
    content: tokens.map((token) => `edited-${token}`).join("\n"),
  });
  expect(await readdir(join(cwd, "memory", "agent"))).toEqual(["notes.md"]);
});

test("concurrent inserts retain each new entry", async () => {
  await create("notes.md", "base", cwd);
  await Promise.all(Array.from({ length: 24 }, (_, i) => insert("notes.md", 0, `entry-${i}`, cwd)));
  const result = await view("notes.md", cwd);
  expect(result.kind).toBe("file");
  if (result.kind !== "file") throw new Error("expected a file");
  expect(new Set(result.content.split("\n")).size).toBe(25);
});

test("concurrent renames cannot overwrite an existing destination", async () => {
  await create("first.md", "first", cwd);
  await create("second.md", "second", cwd);
  const results = await Promise.allSettled([
    rename("first.md", "winner.md", cwd),
    rename("second.md", "winner.md", cwd),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const loser = results[0]!.status === "fulfilled" ? "second" : "first";
  expect(await view(`${loser}.md`, cwd)).toEqual({ kind: "file", content: loser });
});

describe("agent memory filesystem boundary", () => {
  test("every operation rejects a linked ancestor without touching its target", async () => {
    const outside = join(cwd, "outside");
    const agentRoot = join(cwd, "memory", "agent");
    await mkdir(outside);
    await mkdir(agentRoot, { recursive: true });
    await writeFile(join(outside, "private.md"), "private");
    await symlink(outside, join(agentRoot, "linked"), "junction");
    await create("safe.md", "safe", cwd);

    const operations = [
      () => view("linked/private.md", cwd),
      () => create("linked/new.md", "new", cwd),
      () => strReplace("linked/private.md", "private", "changed", cwd),
      () => insert("linked/private.md", 0, "changed", cwd),
      () => del("linked/private.md", cwd),
      () => rename("linked/private.md", "stolen.md", cwd),
      () => rename("safe.md", "linked/moved.md", cwd),
    ];
    for (const operation of operations) await expect(operation()).rejects.toThrow("invalid path");
    expect(await readFile(join(outside, "private.md"), "utf8")).toBe("private");
    expect(await readdir(outside)).toEqual(["private.md"]);
    expect(await view("safe.md", cwd)).toEqual({ kind: "file", content: "safe" });
  });

  for (const rootPart of ["memory", "agent"]) {
    test(`rejects a symlink replacing the ${rootPart} directory`, async () => {
      const outside = join(cwd, "outside");
      await mkdir(outside);
      const link = rootPart === "memory" ? join(cwd, "memory") : join(cwd, "memory", "agent");
      if (rootPart === "agent") await mkdir(join(cwd, "memory"));
      await symlink(outside, link, "junction");
      await expect(view("", cwd)).rejects.toThrow("invalid path");
      await expect(create("new.md", "new", cwd)).rejects.toThrow("invalid path");
      expect(await readdir(outside)).toEqual([]);
    });
  }

  test("workspace aliases share the mutation lock", async () => {
    const workspace = join(cwd, "workspace");
    const alias = join(cwd, "alias");
    await mkdir(workspace);
    await symlink(workspace, alias, "junction");
    await create("notes.md", "alpha beta", workspace);
    await Promise.all([
      strReplace("notes.md", "alpha", "ALPHA", workspace),
      strReplace("notes.md", "beta", "BETA", alias),
    ]);
    expect(await view("notes.md", workspace)).toEqual({ kind: "file", content: "ALPHA BETA" });
  });
});

test("a failed edit releases the mutation lane for later operations", async () => {
  await create("notes.md", "original", cwd);
  const results = await Promise.allSettled([
    strReplace("notes.md", "missing", "wrong", cwd),
    strReplace("notes.md", "original", "updated", cwd),
  ]);
  expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
  expect(await view("notes.md", cwd)).toEqual({ kind: "file", content: "updated" });
});

test("linked files and dangling links are rejected before reading or writing", async () => {
  const outside = join(cwd, "private.md");
  const agentRoot = join(cwd, "memory", "agent");
  await mkdir(agentRoot, { recursive: true });
  await writeFile(outside, "private");
  await symlink(outside, join(agentRoot, "linked.md"));
  await symlink(join(cwd, "new-private.md"), join(agentRoot, "dangling.md"));
  await expect(view("linked.md", cwd)).rejects.toThrow("invalid path");
  await expect(strReplace("linked.md", "private", "changed", cwd)).rejects.toThrow("invalid path");
  await expect(create("dangling.md", "changed", cwd)).rejects.toThrow("invalid path");
  expect(await readFile(outside, "utf8")).toBe("private");
});
