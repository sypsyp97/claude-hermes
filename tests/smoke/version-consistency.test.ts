import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const REPO_ROOT = process.cwd();

async function readJson<T>(path: string): Promise<T> {
  const text = await readFile(path, "utf8");
  return JSON.parse(text) as T;
}

describe("version consistency", () => {
  test("package.json + plugin.json + marketplace.json share the same version string", async () => {
    const pkg = await readJson<{ version: string }>(join(REPO_ROOT, "package.json"));
    const plugin = await readJson<{ version: string }>(join(REPO_ROOT, ".claude-plugin", "plugin.json"));
    const marketplace = await readJson<{ plugins: Array<{ name: string; version: string }> }>(
      join(REPO_ROOT, ".claude-plugin", "marketplace.json")
    );
    const hermesEntry = marketplace.plugins.find((p) => p.name === "claude-hermes");

    expect(pkg.version).toBeDefined();
    expect(plugin.version).toBe(pkg.version);
    expect(hermesEntry).toBeDefined();
    expect(hermesEntry?.version).toBe(pkg.version);
  });

  test("plugin manifest name matches package.json name", async () => {
    const pkg = await readJson<{ name: string }>(join(REPO_ROOT, "package.json"));
    const plugin = await readJson<{ name: string }>(join(REPO_ROOT, ".claude-plugin", "plugin.json"));
    expect(plugin.name).toBe(pkg.name);
  });
});
