#!/usr/bin/env bun
/**
 * Cut a new release. Bumps the version across all three manifests,
 * runs `bun run verify`, commits and pushes main. GitHub Actions verifies
 * all four platforms before creating the version tag and GitHub release. Abort + revert the bump if verify fails.
 *
 *   bun run release 1.0.1
 *   bun run release 1.0.1 --dry-run          # preview only
 *   bun run release 1.0.1 --no-push           # commit locally, don't push
 *   bun run release 1.0.1 --no-release        # legacy alias; publication now belongs to CI
 *   bun run release 1.0.1 --notes-file=X.md   # override auto-generated notes
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// SemVer 2.0: numeric identifiers cannot have leading zeroes; build metadata
// is valid but does not affect precedence.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const ROOT = process.cwd();

const MANIFESTS: ReadonlyArray<{ path: string; selector: string }> = [
  { path: join(ROOT, ".claude-plugin", "plugin.json"), selector: "version" },
  { path: join(ROOT, ".claude-plugin", "marketplace.json"), selector: "plugins.0.version" },
  { path: join(ROOT, "package.json"), selector: "version" },
];

function die(message: string): never {
  console.error(`[release] ${message}`);
  process.exit(1);
}

function sh(cmd: string, args: string[]): string {
  const result: SpawnSyncReturns<string> = spawnSync(cmd, args, { encoding: "utf-8" });
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || "").trim();
    die(`command failed: ${cmd} ${args.join(" ")}\n${err}`);
  }
  return (result.stdout || "").trim();
}

type JsonRecord = Record<string, unknown> | unknown[];

function walk(obj: JsonRecord, parts: string[]): { parent: JsonRecord; key: string | number } {
  let node: JsonRecord = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const raw = parts[i];
    const key: string | number = /^\d+$/.test(raw) ? Number(raw) : raw;
    node = (node as Record<string | number, JsonRecord>)[key];
    if (node == null) die(`selector ${parts.join(".")} hit a null at "${raw}"`);
  }
  const last = parts[parts.length - 1];
  return { parent: node, key: /^\d+$/.test(last) ? Number(last) : last };
}

function readVersion(json: JsonRecord, selector: string): string {
  const { parent, key } = walk(json, selector.split("."));
  const value = (parent as Record<string | number, unknown>)[key];
  if (typeof value !== "string") die(`selector ${selector} is not a string`);
  return value;
}

function writeVersion(json: JsonRecord, selector: string, value: string): void {
  const { parent, key } = walk(json, selector.split("."));
  (parent as Record<string | number, unknown>)[key] = value;
}

function cmpSemver(a: string, b: string): number {
  const left = SEMVER.exec(a)!;
  const right = SEMVER.exec(b)!;
  for (let i = 1; i <= 3; i++) {
    const x = BigInt(left[i]);
    const y = BigInt(right[i]);
    if (x !== y) return x < y ? -1 : 1;
  }
  if (left[4] === undefined || right[4] === undefined) {
    return left[4] === right[4] ? 0 : left[4] === undefined ? 1 : -1;
  }
  const x = left[4].split(".");
  const y = right[4].split(".");
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    const xn = /^\d+$/.test(x[i]);
    const yn = /^\d+$/.test(y[i]);
    if (xn && yn) return BigInt(x[i]) < BigInt(y[i]) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x[i] < y[i] ? -1 : 1;
  }
  return x.length - y.length;
}

function flag(name: string, args: string[]): string | true | undefined {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  return args.includes(name) ? true : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const version = args.find((a) => !a.startsWith("--"));
  if (!version)
    die("usage: bun run release <version> [--dry-run] [--no-push] [--no-release] [--notes-file=path]");
  if (!SEMVER.test(version)) die(`not a valid semver: ${version}`);

  const dryRun = flag("--dry-run", args) === true;
  const noPush = flag("--no-push", args) === true;
  // Retain the old flag for callers that already skipped local gh publication.
  const noRelease = flag("--no-release", args) === true;
  const notesFile = flag("--notes-file", args);

  // Preconditions
  const status = sh("git", ["status", "--porcelain"]);
  if (status) die(`working tree not clean:\n${status}`);

  const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== "main") die(`not on main (currently ${branch})`);

  sh("git", ["fetch", "origin", "main"]);
  const local = sh("git", ["rev-parse", "main"]);
  const remote = sh("git", ["rev-parse", "origin/main"]);
  if (local !== remote) die("local main is out of sync with origin/main");

  // Read + validate current versions across manifests
  const files = MANIFESTS.map((m) => {
    const json = JSON.parse(readFileSync(m.path, "utf-8")) as JsonRecord;
    return { ...m, json, current: readVersion(json, m.selector) };
  });
  const unique = new Set(files.map((f) => f.current));
  if (unique.size > 1) {
    die(`versions diverge across manifests:\n${files.map((f) => `  ${f.path} = ${f.current}`).join("\n")}`);
  }
  const [current] = [...unique];
  if (!SEMVER.test(current)) die(`not a valid current semver: ${current}`);
  if (cmpSemver(version, current) <= 0) {
    die(`new version ${version} is not higher than current ${current}`);
  }
  console.log(`[release] bumping ${current} → ${version}`);

  // Build release notes before mutating anything, so a failure here
  // doesn't leave files half-written.
  let notes: string;
  if (typeof notesFile === "string") {
    notes = readFileSync(notesFile, "utf-8");
  } else {
    const log = sh("git", ["log", `v${current}..HEAD`, "--format=- %s"]);
    notes = `## Changes\n\n${log || "- (no commits since v" + current + ")"}\n`;
  }

  const notesPath = join(ROOT, "docs", "releases", `v${version}.md`);
  const previousNotes = existsSync(notesPath) ? readFileSync(notesPath, "utf-8") : null;

  if (dryRun) {
    console.log("[release] --dry-run: would write:");
    for (const f of files) console.log(`  ${f.path} (${f.selector}: ${f.current} → ${version})`);
    console.log(`[release] --dry-run: would commit "Release v${version}" and ${notesPath}`);
    console.log(`[release] --dry-run: would push main${noPush ? " (skipped)" : ""}`);
    console.log(`[release] --dry-run: CI would verify and publish the release with notes:\n---\n${notes}---`);
    return;
  }

  // Write bumped versions
  for (const f of files) {
    writeVersion(f.json, f.selector, version);
    writeFileSync(f.path, JSON.stringify(f.json, null, 2) + "\n");
  }

  mkdirSync(dirname(notesPath), { recursive: true });
  writeFileSync(notesPath, notes);

  // Verify — if it fails, restore the untracked bump so the tree stays clean.
  console.log("[release] running bun run verify");
  const verify = spawnSync("bun", ["run", "verify"], { stdio: "inherit" });
  if (verify.status !== 0) {
    sh("git", ["restore", ...files.map((f) => f.path)]);
    if (previousNotes === null) rmSync(notesPath);
    else writeFileSync(notesPath, previousNotes);
    die("verify failed — version bump and notes reverted");
  }

  sh("git", ["add", ...files.map((f) => f.path), notesPath]);
  sh("git", ["commit", "-m", `Release v${version}`]);

  if (noPush) {
    console.log(`[release] committed locally; push main when ready to publish v${version}`);
    return;
  }

  sh("git", ["push", "origin", "main"]);
  if (noRelease) console.log("[release] --no-release: local gh publication is now always skipped");
  console.log(`[release] pushed main; GitHub Actions will verify and publish v${version}`);
}

void main();
