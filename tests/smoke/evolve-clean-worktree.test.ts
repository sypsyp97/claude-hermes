import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

test("evolve CLI reports dirty paths and exits nonzero without starting Claude", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hermes-evolve-cli-clean-"));
  try {
    git(cwd, "init", "-q", "-b", "main");
    git(cwd, "config", "user.name", "Hermes Test");
    git(cwd, "config", "user.email", "test@example.invalid");
    git(cwd, "config", "commit.gpgsign", "false");
    await writeFile(join(cwd, ".gitignore"), ".claude/\nmemory/journal/\n");
    git(cwd, "add", ".gitignore");
    git(cwd, "commit", "-qm", "seed");
    await writeFile(join(cwd, "user.txt"), "preserve this work");
    const script = fileURLToPath(new URL("../../scripts/evolve.ts", import.meta.url));
    const result = Bun.spawnSync([process.execPath, script, "Inspect local fixture"], {
      cwd,
      env: { ...process.env, HERMES_CLAUDE_BIN: join(cwd, "never-start-this-missing-executor") },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      outcome: "dirty-worktree",
      dirtyPaths: ["user.txt"],
      execOk: null,
      verifyOk: null,
    });
    expect(result.stderr.toString()).toContain("Commit or stash");
    expect(result.stderr.toString()).not.toContain("ENOENT");
    expect(await readFile(join(cwd, "user.txt"), "utf8")).toBe("preserve this work");
    expect(await Bun.file(join(cwd, "memory", "journal")).exists()).toBe(false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
