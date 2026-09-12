import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const releaseScript = resolve("scripts/release.ts");

async function runRelease(verifyFails: boolean) {
  const cwd = await mkdtemp(join(tmpdir(), "hermes-release-"));
  const bin = join(cwd, "bin");
  await mkdir(bin);
  await mkdir(join(cwd, ".claude-plugin"));
  const files = {
    "package.json": { version: "1.0.3" },
    ".claude-plugin/plugin.json": { version: "1.0.3" },
    ".claude-plugin/marketplace.json": { plugins: [{ version: "1.0.3" }] },
  };
  for (const [path, value] of Object.entries(files)) await writeFile(join(cwd, path), JSON.stringify(value));
  await writeFile(join(cwd, "originals.json"), JSON.stringify(files));
  const fake = `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync('calls.jsonl', JSON.stringify([command, ...args]) + '\\n');
if (command === 'bun') process.exit(${verifyFails ? 1 : 0});
if (command === 'git' && args[0] === 'rev-parse') console.log(args.includes('--abbrev-ref') ? 'main' : 'same-sha');
if (command === 'git' && args[0] === 'log') console.log('- Fixture change');
if (command === 'git' && args[0] === 'restore') {
  const originals = JSON.parse(readFileSync('originals.json', 'utf8'));
  for (const [path, value] of Object.entries(originals)) writeFileSync(path, JSON.stringify(value));
}
`;
  for (const command of ["git", "bun", "gh"]) {
    await writeFile(join(bin, command), fake);
    await chmod(join(bin, command), 0o755);
  }
  try {
    const child = Bun.spawn([process.execPath, "run", releaseScript, "1.0.4"], {
      cwd,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await child.exited;
    const calls = (await readFile(join(cwd, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const versions = await Promise.all(
      Object.keys(files).map(async (path) => JSON.parse(await readFile(join(cwd, path), "utf8")))
    );
    const notes = await readFile(join(cwd, "docs/releases/v1.0.4.md"), "utf8").catch(() => null);
    return { exitCode, calls, versions, notes };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("release command commits versions and notes, then lets main CI publish", async () => {
  const result = await runRelease(false);
  expect(result.exitCode).toBe(0);
  expect(result.calls).toContainEqual(["git", "push", "origin", "main"]);
  expect(result.calls.some((call) => call[0] === "gh" || call[1] === "tag")).toBe(false);
  expect(result.notes).toContain("Fixture change");
  expect(result.versions.map((value) => value.version ?? value.plugins[0].version)).toEqual([
    "1.0.4",
    "1.0.4",
    "1.0.4",
  ]);
});

test("failed release verification restores versions and removes new notes without publishing", async () => {
  const result = await runRelease(true);
  expect(result.exitCode).not.toBe(0);
  expect(result.calls.some((call) => ["commit", "push", "tag"].includes(call[1]) || call[0] === "gh")).toBe(
    false
  );
  expect(result.versions.map((value) => value.version ?? value.plugins[0].version)).toEqual([
    "1.0.3",
    "1.0.3",
    "1.0.3",
  ]);
  expect(result.notes).toBeNull();
});
