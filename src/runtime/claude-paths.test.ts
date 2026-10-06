import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeConfigDir,
  claudeProjectDir,
  claudeProjectMemoryDir,
  claudeProjectsDir,
  findSessionFile,
  projectSlugFromCwd,
} from "./claude-paths";

describe("projectSlugFromCwd", () => {
  test("posix path: leading / becomes leading -, separators become -", () => {
    expect(projectSlugFromCwd("/Users/sun/projects/foo")).toBe("-Users-sun-projects-foo");
  });

  test("windows path: drive C:\\ becomes C--, separators become -", () => {
    expect(projectSlugFromCwd("C:\\Users\\sun\\Downloads\\hermes")).toBe("C--Users-sun-Downloads-hermes");
  });

  test("windows path with mixed separators is normalized too", () => {
    expect(projectSlugFromCwd("C:\\Users/sun\\x")).toBe("C--Users-sun-x");
  });

  test("real folder hyphens collide with separators (documented limitation)", () => {
    // This is the lossy case the audit raised. Test it so a future fix that
    // changes the round-trip behavior is forced to update the test on
    // purpose, not by accident.
    expect(projectSlugFromCwd("/home/me/my-project")).toBe("-home-me-my-project");
  });

  test("matches the format that Claude Code writes on disk for the current cwd", () => {
    // Smoke test against process.cwd() — purely to assert the helper accepts
    // a real path without throwing and returns a plausible slug shape.
    const slug = projectSlugFromCwd();
    expect(slug.length).toBeGreaterThan(0);
    expect(slug).not.toMatch(/[\\/:]/);
  });
});

describe("Claude project helpers", () => {
  test("claudeProjectsDir points at ~/.claude/projects under the provided home", () => {
    expect(claudeProjectsDir("/tmp/home")).toBe(join("/tmp/home", ".claude", "projects"));
  });

  test("claudeProjectDir nests the cwd-derived slug under ~/.claude/projects", () => {
    expect(claudeProjectDir("/tmp/home", "/Users/sun/projects/foo")).toBe(
      join("/tmp/home", ".claude", "projects", "-Users-sun-projects-foo")
    );
  });

  test("claudeProjectMemoryDir appends /memory under the Claude project dir", () => {
    expect(claudeProjectMemoryDir("/tmp/home", "C:\\Users\\sun\\Downloads\\hermes")).toBe(
      join("/tmp/home", ".claude", "projects", "C--Users-sun-Downloads-hermes", "memory")
    );
  });
});

describe("Claude configuration directory", () => {
  test("missing and empty overrides keep the explicit home fallback", () => {
    const expected = join("/tmp/isolated-home", ".claude");
    expect(claudeConfigDir("/tmp/isolated-home", {})).toBe(expected);
    expect(claudeConfigDir("/tmp/isolated-home", { CLAUDE_CONFIG_DIR: "" })).toBe(expected);
    expect(claudeConfigDir("/tmp/isolated-home", { CLAUDE_CONFIG_DIR: "/tmp/Claude Config" })).toBe(
      "/tmp/Claude Config"
    );
  });

  test("explicit configuration roots apply to every project layout helper", () => {
    const home = "/tmp/isolated-home";
    const env = { CLAUDE_CONFIG_DIR: "/tmp/custom-claude" };
    expect(claudeProjectsDir(home, env)).toBe(join(env.CLAUDE_CONFIG_DIR, "projects"));
    expect(claudeProjectDir(home, "/workspace", env)).toBe(
      join(env.CLAUDE_CONFIG_DIR, "projects", "-workspace")
    );
    expect(claudeProjectMemoryDir(home, "/workspace", env)).toBe(
      join(env.CLAUDE_CONFIG_DIR, "projects", "-workspace", "memory")
    );
  });

  test("session lookup stays inside the selected configuration root", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-config-transcripts-"));
    try {
      const home = join(root, "home");
      const configDir = join(root, "custom-config");
      const env = { CLAUDE_CONFIG_DIR: configDir };
      const id = "12345678-1234-4234-8234-123456789012";
      const direct = join(configDir, "projects", "-workspace", `${id}.jsonl`);
      const moved = join(configDir, "projects", "-old-workspace", `${id}.jsonl`);
      const unrelated = join(home, ".claude", "projects", "-workspace", `${id}.jsonl`);
      for (const file of [direct, moved, unrelated]) {
        await mkdir(join(file, ".."), { recursive: true });
        await writeFile(file, "{}\n");
      }
      expect(await findSessionFile(home, "/workspace", id, env)).toBe(direct);
      await rm(direct);
      expect(await findSessionFile(home, "/workspace", id, env)).toBe(moved);
      await rm(moved);
      expect(await findSessionFile(home, "/workspace", id, env)).toBeNull();
      expect(await readFile(unrelated, "utf8")).toBe("{}\n");
      expect(await findSessionFile(home, "/workspace", "../escape", env)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("runtime transcript lookup reads the environment after module import", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-config-runtime-"));
    try {
      const home = join(root, "home");
      const configDirs = [join(root, "config-one"), join(root, "config-two")];
      const expected = configDirs.map((dir) => join(dir, "projects", "-workspace", "session.jsonl"));
      for (const file of expected) {
        await mkdir(join(file, ".."), { recursive: true });
        await writeFile(file, "{}\n");
      }
      const script = `
        const { findSessionFile } = await import(${JSON.stringify(new URL("./claude-paths.ts", import.meta.url).href)});
        const found = [];
        for (const configDir of ${JSON.stringify(configDirs)}) {
          process.env.CLAUDE_CONFIG_DIR = configDir;
          found.push(await findSessionFile(${JSON.stringify(home)}, "/workspace", "session"));
        }
        console.log(JSON.stringify(found));
      `;
      const child = Bun.spawnSync([process.execPath, "-e", script], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: join(root, "import-time-config") },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode).toBe(0);
      expect(JSON.parse(child.stdout.toString())).toEqual(expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("legacy memory migration keeps an explicit home isolated from the runtime environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-config-migration-"));
    try {
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const configDir = join(root, "unrelated-config");
      const slug = projectSlugFromCwd(workspace);
      const source = join(home, ".claude", "projects", slug, "memory", "MEMORY.md");
      const unrelated = join(configDir, "projects", slug, "memory", "MEMORY.md");
      for (const [file, content] of [
        [source, "legacy fixture"],
        [unrelated, "untouched"],
      ]) {
        await mkdir(join(file, ".."), { recursive: true });
        await writeFile(file, content);
      }
      const script = `
        const { migrateLegacyMemory } = await import(${JSON.stringify(new URL("../memory/files.ts", import.meta.url).href)});
        console.log(JSON.stringify(await migrateLegacyMemory(${JSON.stringify(workspace)}, { home: ${JSON.stringify(home)} })));
      `;
      const child = Bun.spawnSync([process.execPath, "-e", script], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode).toBe(0);
      expect(JSON.parse(child.stdout.toString())).toEqual({ moved: ["MEMORY.md"], skipped: [] });
      expect(await readFile(join(workspace, "memory", "MEMORY.md"), "utf8")).toBe("legacy fixture");
      expect(await readFile(unrelated, "utf8")).toBe("untouched");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
