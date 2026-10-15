import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const releaseScript = resolve("scripts/release.ts");

async function dryRunRelease(current: string, version: string) {
  const cwd = await mkdtemp(join(tmpdir(), "hermes-release-semver-"));
  try {
    const bin = join(cwd, "bin");
    await mkdir(bin);
    await mkdir(join(cwd, ".claude-plugin"));
    const manifests = {
      "package.json": { version: current },
      ".claude-plugin/plugin.json": { version: current },
      ".claude-plugin/marketplace.json": { plugins: [{ version: current }] },
    };
    for (const [path, value] of Object.entries(manifests)) {
      await writeFile(join(cwd, path), JSON.stringify(value));
    }
    const git = `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync("calls.jsonl", JSON.stringify(args) + "\\n");
if (args[0] === "status" || args[0] === "fetch") process.exit(0);
if (args[0] === "rev-parse") {
  console.log(args.includes("--abbrev-ref") ? "main" : "same-sha");
  process.exit(0);
}
if (args[0] === "log") { console.log("- Fixture change"); process.exit(0); }
console.error("unexpected git command: " + args.join(" "));
process.exit(99);
`;
    await writeFile(join(bin, "git"), git);
    await chmod(join(bin, "git"), 0o755);
    const child = Bun.spawn([process.execPath, "run", releaseScript, version, "--dry-run"], {
      cwd,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const calls = (await readFile(join(cwd, "calls.jsonl"), "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    // A dry run must never publish or mutate the fixture's release inputs.
    expect(calls.some(([command]) => ["add", "commit", "push", "tag", "restore"].includes(command))).toBe(
      false
    );
    for (const [path, value] of Object.entries(manifests)) {
      expect(JSON.parse(await readFile(join(cwd, path), "utf8"))).toEqual(value);
    }
    expect(await Bun.file(join(cwd, "docs/releases", `v${version}.md`)).exists()).toBe(false);
    return { exitCode, stdout, stderr };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

// SemVer 2.0.0 rules 9–11; exercise the real CLI, not a duplicate comparator.
const promotions = [
  ["1.0.0-rc.1", "1.0.0-rc.2"],
  ["1.0.0-rc.2", "1.0.0-rc.10"],
  ["1.0.0-rc.10", "1.0.0"],
  ["1.0.0-alpha", "1.0.0-alpha.1"],
  ["1.0.0-alpha.1", "1.0.0-alpha.beta"],
  ["1.0.0-alpha.beta", "1.0.0-beta"],
  ["1.0.0-beta", "1.0.0-beta.2"],
  ["1.0.0-beta.2", "1.0.0-beta.11"],
  ["1.0.0-beta.11", "1.0.0-rc.1"],
  ["1.0.0-999", "1.0.0-alpha"],
  ["1.0.0-Alpha", "1.0.0-alpha"],
  ["1.0.0-x-y-z.--", "1.0.0"],
  ["1.0.9", "1.0.10"],
  ["1.9.0", "1.10.0"],
  ["1.9.9", "2.0.0"],
  ["1.0.0", "1.0.1+build.01"],
  ["1.0.0+old", "1.0.1+new"],
  ["1.0.0-rc.1+old", "1.0.0-rc.2+new"],
  ["1.0.0-9999999999999999999999999", "1.0.0-10000000000000000000000000"],
  ["9007199254740992.0.0", "9007199254740993.0.0"],
] as const;

for (const [current, version] of promotions) {
  test(`release dry run accepts SemVer promotion ${current} → ${version}`, async () => {
    const result = await dryRunRelease(current, version);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--dry-run");
  });
}

for (const [current, version] of [
  ...promotions.map(([lower, higher]) => [higher, lower]),
  ["1.0.0", "1.0.0"],
  ["1.0.0-rc.2", "1.0.0-rc.2"],
  ["1.0.0+old", "1.0.0+new"],
  ["1.0.0-rc.2+old", "1.0.0-rc.2+new"],
  ["1.0.0+old", "1.0.0"],
] as const) {
  test(`release dry run rejects non-increasing SemVer ${current} → ${version}`, async () => {
    const result = await dryRunRelease(current, version);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("would commit");
  });
}

for (const invalid of [
  "v1.2.3",
  "1.2",
  "01.2.3",
  "1.02.3",
  "1.2.03",
  "1.2.3-01",
  "1.2.3-alpha.01",
  "1.2.3-alpha..1",
  "1.2.3-",
  "1.2.3+",
  "1.2.3+build..1",
  "1.2.3-alpha_1",
  "1.2.3-ä",
  "1.2.3\n",
  "1.2.3\r\n",
]) {
  test(`release dry run rejects invalid target version ${invalid}`, async () => {
    const result = await dryRunRelease("0.1.0", invalid);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("would commit");
  });
}

test("release dry run rejects invalid current manifest versions", async () => {
  const result = await dryRunRelease("01.0.0", "2.0.0");
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).not.toContain("would commit");
});
