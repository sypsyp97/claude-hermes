import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitChanges, computeDirtyPaths, revertPaths } from "./gate";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}
async function withRepo(run: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "hermes-gate-safety-"));
  try {
    git(cwd, "init", "-q", "-b", "main");
    git(cwd, "config", "user.name", "Hermes Test");
    git(cwd, "config", "user.email", "test@example.invalid");
    git(cwd, "config", "commit.gpgsign", "false");
    await writeFile(join(cwd, "seed.txt"), "seed\n");
    git(cwd, "add", "seed.txt");
    git(cwd, "commit", "-qm", "seed");
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("evolve literal path and index isolation", () => {
  test("commit excludes unrelated pre-staged user work and preserves its index entry", async () => {
    await withRepo(async (cwd) => {
      await writeFile(join(cwd, "user.txt"), "private user work\n");
      git(cwd, "add", "user.txt");
      await writeFile(join(cwd, "edit.txt"), "agent edit\n");
      expect(await commitChanges(cwd, "scoped edit", ["edit.txt"])).not.toBeNull();
      expect(git(cwd, "show", "--format=", "--name-only", "HEAD").trim()).toBe("edit.txt");
      expect(git(cwd, "diff", "--cached", "--name-only").trim()).toBe("user.txt");
    });
  });

  test("status preserves newline, unicode, arrow and glob filenames exactly", async () => {
    await withRepo(async (cwd) => {
      const paths = ["line\nbreak.txt", "中文.txt", "old -> new.txt", "[a].txt"];
      for (const path of paths) await writeFile(join(cwd, path), "new\n");
      expect(await computeDirtyPaths(cwd)).toEqual(paths.sort());
    });
  });

  test("status enumerates files in untracked directories", async () => {
    await withRepo(async (cwd) => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(cwd, "new"));
      await writeFile(join(cwd, "new", "a.txt"), "new\n");
      expect(await computeDirtyPaths(cwd)).toEqual(["new/a.txt"]);
    });
  });

  test("reverting a literal wildcard file never removes another file", async () => {
    await withRepo(async (cwd) => {
      await writeFile(join(cwd, "[a].txt"), "agent work\n");
      await writeFile(join(cwd, "a.txt"), "user work\n");
      await revertPaths(cwd, ["[a].txt"]);
      expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("user work\n");
      expect(await Bun.file(join(cwd, "[a].txt")).exists()).toBe(false);
    });
  });

  test("status failures stop instead of claiming a clean tree", async () => {
    await expect(
      computeDirtyPaths("/missing", {
        runGit: async () => ({ ok: false, stdout: "", stderr: "status failed" }),
      })
    ).rejects.toThrow("status failed");
  });
});

describe("evolve rollback restores HEAD rather than the edited index", () => {
  test("restores a staged deletion", async () => {
    await withRepo(async (cwd) => {
      git(cwd, "rm", "seed.txt");
      await revertPaths(cwd, await computeDirtyPaths(cwd));
      expect(await Bun.file(join(cwd, "seed.txt")).exists()).toBe(true);
      expect(await readFile(join(cwd, "seed.txt"), "utf8")).toBe("seed\n");
      expect(await computeDirtyPaths(cwd)).toEqual([]);
    });
  });

  test("removes a newly staged file from both worktree and index", async () => {
    await withRepo(async (cwd) => {
      await writeFile(join(cwd, "new.txt"), "generated\n");
      git(cwd, "add", "new.txt");
      await revertPaths(cwd, await computeDirtyPaths(cwd));
      expect(await Bun.file(join(cwd, "new.txt")).exists()).toBe(false);
      expect(await computeDirtyPaths(cwd)).toEqual([]);
    });
  });

  test("restores both ends of a staged rename", async () => {
    await withRepo(async (cwd) => {
      git(cwd, "mv", "seed.txt", "renamed.txt");
      await revertPaths(cwd, await computeDirtyPaths(cwd));
      expect(await Bun.file(join(cwd, "seed.txt")).exists()).toBe(true);
      expect(await Bun.file(join(cwd, "renamed.txt")).exists()).toBe(false);
      expect(await computeDirtyPaths(cwd)).toEqual([]);
    });
  });
});

for (const operation of ["add", "diff", "commit", "rev-parse"]) {
  test(`commit surfaces ${operation} failures instead of returning a no-op`, async () => {
    await expect(
      commitChanges("/fixture", "test", ["edit.txt"], {
        runGit: async (_cwd, args) =>
          args[0] === operation
            ? { ok: false, stdout: "", stderr: `${operation} failed` }
            : { ok: true, stdout: args[0] === "diff" ? "edit.txt\n" : "", stderr: "" },
      })
    ).rejects.toThrow(`${operation} failed`);
  });
}

test("commit rejects an empty revision response", async () => {
  await expect(
    commitChanges("/fixture", "test", ["edit.txt"], {
      runGit: async (_cwd, args) => ({
        ok: true,
        stdout: args[0] === "diff" ? "edit.txt\n" : "",
        stderr: "",
      }),
    })
  ).rejects.toThrow("revision");
});
