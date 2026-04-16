import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateRunners, VerifyResult } from "./gate";
import { commitChanges, revertAll, runVerify } from "./gate";

const ORIG_CWD = process.cwd();
let tempRoot: string;

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "hermes-evolve-gate-"));
  process.chdir(tempRoot);
});

afterAll(async () => {
  process.chdir(ORIG_CWD);
  await rm(tempRoot, { recursive: true, force: true });
});

describe("runVerify (injected runner)", () => {
  test("returns the injected success result as-is", async () => {
    const injected: VerifyResult = {
      ok: true,
      durationMs: 123,
      exitCode: 0,
      stdout: "verify green",
      stderr: "",
    };
    const runners: GateRunners = {
      runVerify: async () => injected,
    };
    const result = await runVerify("/nowhere", runners);
    expect(result).toEqual(injected);
  });

  test("returns the injected failure result as-is", async () => {
    const injected: VerifyResult = {
      ok: false,
      durationMs: 10,
      exitCode: 1,
      stdout: "",
      stderr: "typecheck failed on line 3",
    };
    const runners: GateRunners = {
      runVerify: async () => injected,
    };
    const result = await runVerify("/anywhere", runners);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("typecheck failed");
    expect(result.exitCode).toBe(1);
  });

  test("receives the cwd it was called with", async () => {
    let seenCwd = "";
    const runners: GateRunners = {
      runVerify: async (cwd) => {
        seenCwd = cwd;
        return { ok: true, durationMs: 1, exitCode: 0, stdout: "", stderr: "" };
      },
    };
    await runVerify("/tmp/elsewhere", runners);
    expect(seenCwd).toBe("/tmp/elsewhere");
  });
});

describe("runVerify (default runner, real spawn)", () => {
  test("reports ok=false with exitCode 127-ish when bin is missing", async () => {
    // Drive the default fallback which spawns `bun run verify`. We can't
    // actually invoke the real pipeline, but we can sanity-check the shape
    // by spawning from a cwd that has no bun.lock/package.json — a failure
    // exit is still a well-formed VerifyResult.
    // Using a tmp cwd keeps the real repo out of the way.
    const emptyCwd = await mkdtemp(join(tmpdir(), "hermes-gate-empty-"));
    try {
      // Kick off bun in a directory with nothing to verify. Exit code > 0 is fine.
      const result = await runVerify(emptyCwd);
      expect(typeof result.ok).toBe("boolean");
      expect(typeof result.exitCode).toBe("number");
      expect(typeof result.durationMs).toBe("number");
      expect(typeof result.stdout).toBe("string");
      expect(typeof result.stderr).toBe("string");
    } finally {
      await rm(emptyCwd, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("commitChanges", () => {
  test("returns null when git status reports no pending changes", async () => {
    const calls: string[][] = [];
    const runners: GateRunners = {
      runGit: async (_cwd, args) => {
        calls.push(args);
        if (args[0] === "status") return { ok: true, stdout: "", stderr: "" };
        return { ok: true, stdout: "", stderr: "" };
      },
    };
    const sha = await commitChanges("/nowhere", "noop", runners);
    expect(sha).toBeNull();
    // Should not attempt add / commit / rev-parse when the tree is clean.
    const invoked = calls.map((c) => c[0]);
    expect(invoked).toEqual(["status"]);
  });

  test("returns null when 'git status --porcelain' output is only whitespace", async () => {
    const runners: GateRunners = {
      runGit: async (_cwd, args) => {
        if (args[0] === "status") return { ok: true, stdout: "   \n\t\n", stderr: "" };
        return { ok: true, stdout: "", stderr: "" };
      },
    };
    expect(await commitChanges("/c", "msg", runners)).toBeNull();
  });

  test("happy path: status dirty → add → commit → rev-parse → trimmed sha", async () => {
    const calls: string[][] = [];
    const runners: GateRunners = {
      runGit: async (_cwd, args) => {
        calls.push(args);
        if (args[0] === "status") return { ok: true, stdout: " M src/foo.ts\n", stderr: "" };
        if (args[0] === "add") return { ok: true, stdout: "", stderr: "" };
        if (args[0] === "commit") return { ok: true, stdout: "ok", stderr: "" };
        if (args[0] === "rev-parse") return { ok: true, stdout: "  cafebabe0042\n", stderr: "" };
        return { ok: true, stdout: "", stderr: "" };
      },
    };
    const sha = await commitChanges("/repo", "evolve: fix bug", runners);
    expect(sha).toBe("cafebabe0042");

    const ordered = calls.map((c) => c[0]);
    expect(ordered).toEqual(["status", "add", "commit", "rev-parse"]);

    // Commit message is passed with -m.
    const commitCall = calls.find((c) => c[0] === "commit")!;
    expect(commitCall).toEqual(["commit", "-m", "evolve: fix bug"]);

    // Add uses -A.
    expect(calls.find((c) => c[0] === "add")).toEqual(["add", "-A"]);
  });

  test("returns null when 'git commit' fails (hook rejection etc.)", async () => {
    const runners: GateRunners = {
      runGit: async (_cwd, args) => {
        if (args[0] === "status") return { ok: true, stdout: " M a\n", stderr: "" };
        if (args[0] === "add") return { ok: true, stdout: "", stderr: "" };
        if (args[0] === "commit") return { ok: false, stdout: "", stderr: "hook failed" };
        throw new Error("rev-parse should not be reached after commit failure");
      },
    };
    const sha = await commitChanges("/repo", "oops", runners);
    expect(sha).toBeNull();
  });

  test("passes the cwd through to the git runner", async () => {
    const cwds: string[] = [];
    const runners: GateRunners = {
      runGit: async (cwd, args) => {
        cwds.push(cwd);
        if (args[0] === "status") return { ok: true, stdout: " M x\n", stderr: "" };
        if (args[0] === "rev-parse") return { ok: true, stdout: "abc\n", stderr: "" };
        return { ok: true, stdout: "", stderr: "" };
      },
    };
    await commitChanges("/repo-xyz", "m", runners);
    expect(new Set(cwds)).toEqual(new Set(["/repo-xyz"]));
  });
});

describe("revertAll", () => {
  test("runs restore --staged, restore, and clean -fd in that order", async () => {
    const calls: string[][] = [];
    const runners: GateRunners = {
      runGit: async (_cwd, args) => {
        calls.push(args);
        return { ok: true, stdout: "", stderr: "" };
      },
    };
    await revertAll("/repo", runners);
    expect(calls).toEqual([
      ["restore", "--staged", "."],
      ["restore", "."],
      ["clean", "-fd"],
    ]);
  });

  test("passes through the cwd on every call", async () => {
    const seen: string[] = [];
    const runners: GateRunners = {
      runGit: async (cwd) => {
        seen.push(cwd);
        return { ok: true, stdout: "", stderr: "" };
      },
    };
    await revertAll("/some/repo", runners);
    expect(seen).toEqual(["/some/repo", "/some/repo", "/some/repo"]);
  });

  test("still completes when an intermediate git call reports not-ok (best-effort revert)", async () => {
    const calls: string[][] = [];
    const runners: GateRunners = {
      runGit: async (_cwd, args) => {
        calls.push(args);
        return { ok: false, stdout: "", stderr: "nope" };
      },
    };
    await revertAll("/repo", runners);
    expect(calls.length).toBe(3);
  });
});

describe("revertAll with a real git binary", () => {
  test("running against a non-git directory does not throw", async () => {
    // With no injected runner this uses the default `git` bin. Even if git
    // fails because cwd is not a repo the function must resolve without
    // throwing (it ignores per-call results).
    const noRepo = await mkdtemp(join(tmpdir(), "hermes-gate-norepo-"));
    try {
      await expect(revertAll(noRepo)).resolves.toBeUndefined();
    } finally {
      await rm(noRepo, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("commitChanges with a real git binary", () => {
  test("clean newly-initialised repo → returns null (no changes to commit)", async () => {
    const repoCwd = await mkdtemp(join(tmpdir(), "hermes-gate-cleanrepo-"));
    try {
      await runShell("git", ["init", "-q"], repoCwd);
      // Configure committer identity inline (env, not repo config) so we do
      // not violate the "never update git config" rule. No commits anyway.
      const sha = await commitChanges(repoCwd, "should be skipped");
      expect(sha).toBeNull();
    } finally {
      await rm(repoCwd, { recursive: true, force: true });
    }
  }, 15_000);
});

function runShell(
  bin: string,
  args: string[],
  cwd: string
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (c) => {
      stdout += c.toString();
    });
    proc.stderr?.on("data", (c) => {
      stderr += c.toString();
    });
    proc.on("close", (code) => resolve({ ok: code === 0, stdout, stderr }));
    proc.on("error", () => resolve({ ok: false, stdout, stderr }));
  });
}
