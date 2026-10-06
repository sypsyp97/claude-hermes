import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudePluginPaths, installRepoPlugin } from "./preflight";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(marketplace: unknown, files: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "hermes-plugin-install-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(join(repo, ".claude-plugin"), { recursive: true });
  await writeFile(join(repo, ".claude-plugin", "marketplace.json"), JSON.stringify(marketplace));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(repo, path, ".."), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  const paths = claudePluginPaths(join(root, "home"), {});
  await mkdir(join(paths.pluginsDir, "marketplaces"), { recursive: true });
  await mkdir(join(paths.pluginsDir, "cache"), { recursive: true });
  const commit = () => {
    const options = {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    };
    execFileSync("git", ["init", "-q", "--template="], options);
    execFileSync("git", ["add", "."], options);
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Hermes Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-qm",
        "fixture",
      ],
      options
    );
  };
  return { root, repo, paths, commit };
}

test("marketplace traversal is rejected before deleting an existing directory", async () => {
  const { root, repo, paths, commit } = await fixture({ name: "../../victim", plugins: [{ name: "safe" }] });
  const victim = join(root, "home", ".claude", "victim", "keep.txt");
  await mkdir(join(victim, ".."), { recursive: true });
  await writeFile(victim, "keep me");
  commit();
  expect(() => installRepoPlugin(repo, join(root, "project"), "bun", paths)).toThrow();
  expect(await readFile(victim, "utf8")).toBe("keep me");
});

test("plugin source selects the declared directory rather than the whole marketplace", async () => {
  const { root, repo, paths, commit } = await fixture(
    { name: "test-market", plugins: [{ name: "safe", source: "./plugins/safe" }] },
    { "plugins/safe/commands/hello.md": "Hello", "unrelated.txt": "not plugin content" }
  );
  commit();
  expect(installRepoPlugin(repo, join(root, "project"), "bun", paths)).toBe("installed");
  const registry = JSON.parse(await readFile(paths.installedPluginsFile, "utf8"));
  const cache = registry.plugins["safe@test-market"][0].installPath;
  expect(await readFile(join(cache, "commands", "hello.md"), "utf8")).toBe("Hello");
  expect(existsSync(join(cache, "unrelated.txt"))).toBe(false);
});

test("a plugin source cannot point outside the cloned marketplace", async () => {
  const { root, repo, paths, commit } = await fixture({
    name: "test-market",
    plugins: [{ name: "safe", source: "../../outside" }],
  });
  const sentinel = join(paths.pluginsDir, "marketplaces", "test-market", "keep.txt");
  await mkdir(join(sentinel, ".."), { recursive: true });
  await writeFile(sentinel, "previous marketplace");
  commit();
  expect(() => installRepoPlugin(repo, join(root, "project"), "bun", paths)).toThrow();
  expect(existsSync(paths.installedPluginsFile)).toBe(false);
  expect(await readFile(sentinel, "utf8")).toBe("previous marketplace");
});

test("plugin file symlinks cannot copy unrelated local secrets into the cache", async () => {
  const { root, repo, paths, commit } = await fixture({ name: "test-market", plugins: [{ name: "safe" }] });
  const secret = join(root, "secret.txt");
  await writeFile(secret, "private content");
  await symlink(secret, join(repo, "leaked.txt"));
  const sentinel = join(paths.pluginsDir, "marketplaces", "test-market", "keep.txt");
  await mkdir(join(sentinel, ".."), { recursive: true });
  await writeFile(sentinel, "previous marketplace");
  commit();
  expect(() => installRepoPlugin(repo, join(root, "project"), "bun", paths)).toThrow();
  expect(existsSync(paths.installedPluginsFile)).toBe(false);
  expect(await readFile(sentinel, "utf8")).toBe("previous marketplace");
});

test("escaping skill paths fail before replacing the marketplace or running dependencies", async () => {
  const { root, repo, paths, commit } = await fixture({
    name: "test-market",
    plugins: [{ name: "safe", skills: ["../../outside"] }],
  });
  const sentinel = join(paths.pluginsDir, "marketplaces", "test-market", "keep.txt");
  await mkdir(join(sentinel, ".."), { recursive: true });
  await writeFile(sentinel, "previous marketplace");
  commit();
  expect(() => installRepoPlugin(repo, join(root, "project"), "bun", paths)).toThrow();
  expect(await readFile(sentinel, "utf8")).toBe("previous marketplace");
});

test("unsupported directory symlinks fail before replacing the marketplace", async () => {
  const { root, repo, paths, commit } = await fixture(
    { name: "test-market", plugins: [{ name: "safe" }] },
    { "real/hello.md": "plugin file" }
  );
  await symlink("real", join(repo, "linked"));
  const sentinel = join(paths.pluginsDir, "marketplaces", "test-market", "keep.txt");
  await mkdir(join(sentinel, ".."), { recursive: true });
  await writeFile(sentinel, "previous marketplace");
  commit();
  expect(() => installRepoPlugin(repo, join(root, "project"), "bun", paths)).toThrow();
  expect(await readFile(sentinel, "utf8")).toBe("previous marketplace");
});
