/**
 * Gate — commits on green verify, reverts on red. Every mutation is scoped to
 * a caller-provided path list so a failed evolve never sweeps in unrelated
 * user work sitting in the same worktree.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export interface VerifyResult {
  ok: boolean;
  durationMs: number;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GateRunners {
  runVerify?(cwd: string): Promise<VerifyResult>;
  runGit?(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }>;
  /**
   * Content fingerprint for one worktree-relative path. Returns null when the
   * path does not exist (deleted, never created). Used to detect when the
   * evolve subagent modifies a file that was ALREADY dirty before the run —
   * such a file would otherwise sit in `baselineDirty` and be invisible to
   * `touchedPaths`, meaning it wouldn't be reverted on RED or committed on
   * GREEN. Default hashes file bytes with SHA-1; tests inject.
   */
  hashPath?(cwd: string, path: string): Promise<string | null>;
}

export async function hashWorktreePath(cwd: string, path: string): Promise<string | null> {
  const abs = isAbsolute(path) ? path : join(cwd, path);
  try {
    const bytes = await readFile(abs);
    return createHash("sha1").update(bytes).digest("hex");
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code;
    if (code === "ENOENT" || code === "EISDIR") return null;
    // Permission errors, Windows file-locking, etc. — treat as unknown, not
    // as "unchanged". Return a sentinel that differs from any real hash so
    // the path stays in the touched set and gets reverted conservatively.
    return `unreadable:${code ?? "unknown"}:${Date.now()}`;
  }
}

export async function runVerify(cwd: string, runners: GateRunners = {}): Promise<VerifyResult> {
  if (runners.runVerify) return runners.runVerify(cwd);
  return runProcess("bun", ["run", "verify"], cwd);
}

/**
 * Snapshot of paths that `git status --porcelain` currently reports dirty.
 * The caller should diff this against a pre-execution snapshot to derive the
 * set of paths the evolve subagent actually touched.
 */
export async function computeDirtyPaths(
  cwd: string,
  runners: GateRunners = {},
): Promise<string[]> {
  const run = runners.runGit ?? defaultGit;
  // NUL framing preserves whitespace, quotes, Unicode and literal " -> ".
  // Disable rename folding: both paths must remain in commit/rollback scope.
  const status = await run(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);
  if (!status.ok) throw new Error(`Cannot inspect evolve worktree: ${status.stderr}`);
  const set = new Set<string>();
  for (const record of status.stdout.split("\0")) {
    if (!record) continue;
    set.add(record.slice(3));
  }
  return Array.from(set).sort();
}

export async function commitChanges(
  cwd: string,
  message: string,
  paths: string[],
  runners: GateRunners = {},
): Promise<string | null> {
  if (paths.length === 0) return null;
  const run = runners.runGit ?? defaultGit;

  const add = await run(cwd, ["add", "--", ...paths]);
  if (!add.ok) throw new Error(`Cannot stage evolve changes: ${add.stderr || add.stdout}`);

  const staged = await run(cwd, ["diff", "--cached", "--name-only", "--", ...paths]);
  if (!staged.ok) throw new Error(`Cannot inspect staged evolve changes: ${staged.stderr || staged.stdout}`);
  if (!staged.stdout.trim()) return null;

  const commit = await run(cwd, ["commit", "--only", "-m", message, "--", ...paths]);
  if (!commit.ok) throw new Error(`Cannot commit evolve changes: ${commit.stderr || commit.stdout}`);

  const sha = await run(cwd, ["rev-parse", "HEAD"]);
  if (!sha.ok || !sha.stdout.trim()) {
    throw new Error(`Cannot read committed evolve revision: ${sha.stderr || sha.stdout || "empty revision"}`);
  }
  return sha.stdout.trim();
}

export async function revertPaths(
  cwd: string,
  paths: string[],
  runners: GateRunners = {},
): Promise<void> {
  if (paths.length === 0) return;
  const run = runners.runGit ?? defaultGit;

  // The executor can stage additions/deletions/renames. Classify against
  // HEAD rather than its modified index so rollback restores the baseline.
  const tracked: string[] = [];
  const added: string[] = [];
  for (const path of paths) {
    const result = await run(cwd, ["ls-tree", "--name-only", "-z", "HEAD", "--", path]);
    if (!result.ok) throw new Error(`Cannot inspect evolve rollback path: ${result.stderr}`);
    if (result.stdout.length > 0) tracked.push(path);
    else added.push(path);
  }

  if (tracked.length > 0) {
    const restored = await run(cwd, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...tracked]);
    if (!restored.ok) throw new Error(`Cannot restore evolve changes: ${restored.stderr}`);
  }
  if (added.length > 0) {
    const unstaged = await run(cwd, ["rm", "--cached", "-f", "--ignore-unmatch", "--", ...added]);
    if (!unstaged.ok) throw new Error(`Cannot unstage evolve additions: ${unstaged.stderr}`);
    const cleaned = await run(cwd, ["clean", "-fd", "--", ...added]);
    if (!cleaned.ok) throw new Error(`Cannot remove evolve additions: ${cleaned.stderr}`);
  }
}

async function defaultGit(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const r = await runProcess("git", ["--literal-pathspecs", ...args], cwd);
  return { ok: r.ok, stdout: r.stdout, stderr: r.stderr };
}

function runProcess(bin: string, args: string[], cwd: string): Promise<VerifyResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const proc = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => {
      resolve({
        ok: code === 0,
        exitCode: code ?? -1,
        durationMs: Date.now() - started,
        stdout,
        stderr,
      });
    });
    proc.on("error", (err) => {
      resolve({
        ok: false,
        exitCode: -1,
        durationMs: Date.now() - started,
        stdout,
        stderr: stderr + String(err),
      });
    });
  });
}
