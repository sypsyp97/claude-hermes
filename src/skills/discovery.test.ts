import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills, extractDescription } from "./discovery";

// discoverSkills() accepts a `DiscoveryRoots` argument, so we can drive it
// through explicit cwd + home paths without touching the real homedir or
// process.cwd. That makes the tests fully parallel-safe.
let tempRoot: string;
let fakeCwd: string;
let fakeHome: string;
let projectSkillsDir: string;
let globalSkillsDir: string;
let pluginCacheDir: string;

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(join(tmpdir(), "hermes-discovery-"));
  fakeCwd = join(tempRoot, "project");
  fakeHome = join(tempRoot, "home");
  projectSkillsDir = join(fakeCwd, ".claude", "skills");
  globalSkillsDir = join(fakeHome, ".claude", "skills");
  pluginCacheDir = join(fakeHome, ".claude", "plugins", "cache");
  await fs.mkdir(projectSkillsDir, { recursive: true });
  await fs.mkdir(globalSkillsDir, { recursive: true });
  await fs.mkdir(pluginCacheDir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

async function resetDirs(): Promise<void> {
  await fs.rm(projectSkillsDir, { recursive: true, force: true });
  await fs.rm(globalSkillsDir, { recursive: true, force: true });
  await fs.rm(pluginCacheDir, { recursive: true, force: true });
  await fs.mkdir(projectSkillsDir, { recursive: true });
  await fs.mkdir(globalSkillsDir, { recursive: true });
  await fs.mkdir(pluginCacheDir, { recursive: true });
}

async function writeSkill(root: string, name: string, body: string): Promise<void> {
  const dir = join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, "SKILL.md"), body);
}

beforeEach(async () => {
  await resetDirs();
});

describe("discoverSkills", () => {
  test("returns empty array when no skill dirs exist", async () => {
    // Point at a completely fresh tmp root with no .claude dirs.
    const empty = await fs.mkdtemp(join(tmpdir(), "hermes-discovery-empty-"));
    try {
      const skills = await discoverSkills({ cwd: empty, home: empty });
      expect(skills).toEqual([]);
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });

  test("returns empty array when skill dirs exist but are empty", async () => {
    const skills = await discoverSkills({ cwd: fakeCwd, home: fakeHome });
    expect(skills).toEqual([]);
  });

  test("discovers a well-formed project SKILL.md", async () => {
    await writeSkill(projectSkillsDir, "hello", "---\ndescription: Says hi\n---\nbody\n");
    const skills = await discoverSkills({ cwd: fakeCwd, home: fakeHome });
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("hello");
    expect(skills[0].source).toBe("project");
    expect(skills[0].description).toBe("Says hi");
    expect(skills[0].path).toBe(join(projectSkillsDir, "hello", "SKILL.md"));
  });

  test("discovers a global SKILL.md and marks source=global", async () => {
    await writeSkill(globalSkillsDir, "global-one", "# Global\n\nsome description\n");
    const skills = await discoverSkills({ cwd: fakeCwd, home: fakeHome });
    const found = skills.find((s) => s.name === "global-one");
    expect(found?.source).toBe("global");
    expect(found?.description).toBe("some description");
  });

  test("dedupes by name: project skill shadows global with same name", async () => {
    await writeSkill(projectSkillsDir, "shared", "---\ndescription: project desc\n---\n");
    await writeSkill(globalSkillsDir, "shared", "---\ndescription: global desc\n---\n");
    const skills = await discoverSkills({ cwd: fakeCwd, home: fakeHome });
    const shared = skills.filter((s) => s.name === "shared");
    expect(shared).toHaveLength(1);
    expect(shared[0].source).toBe("project");
    expect(shared[0].description).toBe("project desc");
  });

  test("skips empty SKILL.md files", async () => {
    await writeSkill(projectSkillsDir, "empty", "");
    await writeSkill(projectSkillsDir, "whitespace", "   \n\t\n  ");
    await writeSkill(projectSkillsDir, "real", "---\ndescription: ok\n---\n");
    const skills = await discoverSkills({ cwd: fakeCwd, home: fakeHome });
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["real"]);
  });

  test("ignores files (not directories) in skills root", async () => {
    await fs.writeFile(join(projectSkillsDir, "README.md"), "a file, not a skill dir");
    const skills = await discoverSkills({ cwd: fakeCwd, home: fakeHome });
    expect(skills).toEqual([]);
  });

  test("ignores skill directories with no SKILL.md", async () => {
    await fs.mkdir(join(projectSkillsDir, "no-manifest"), { recursive: true });
    await fs.writeFile(join(projectSkillsDir, "no-manifest", "other.md"), "x");
    const skills = await discoverSkills({ cwd: fakeCwd, home: fakeHome });
    expect(skills).toEqual([]);
  });

  test("does not crash on malformed frontmatter — falls back gracefully", async () => {
    // Unterminated frontmatter, no closing `---`.
    await writeSkill(projectSkillsDir, "broken", "---\ndescription: never closes\nname: x\nnothing below\n");
    const skills = await discoverSkills({ cwd: fakeCwd, home: fakeHome });
    const found = skills.find((s) => s.name === "broken");
    expect(found).toBeDefined();
    // With no valid frontmatter, the first non-header line is returned.
    expect(found?.description).toBeTruthy();
  });

  test("discovers plugin skills via plugins/cache/<marketplace>/<plugin>/<version>/skills layout", async () => {
    const pluginSkillDir = join(pluginCacheDir, "my-marketplace", "my-plugin", "v1", "skills", "plug-skill");
    await fs.mkdir(pluginSkillDir, { recursive: true });
    await fs.writeFile(join(pluginSkillDir, "SKILL.md"), "---\ndescription: plugin\n---\n");

    const skills = await discoverSkills({ cwd: fakeCwd, home: fakeHome });
    const found = skills.find((s) => s.source === "plugin");
    expect(found).toBeDefined();
    expect(found?.name).toBe("my-marketplace_plug-skill");
    expect(found?.plugin).toBe("my-marketplace");
  });

  test("discovers plugin skills via plugins/cache/<marketplace>/<plugin>/skills layout (no version)", async () => {
    const pluginSkillDir = join(pluginCacheDir, "mkt2", "plug2", "skills", "direct-skill");
    await fs.mkdir(pluginSkillDir, { recursive: true });
    await fs.writeFile(join(pluginSkillDir, "SKILL.md"), "---\ndescription: direct\n---\n");

    const skills = await discoverSkills({ cwd: fakeCwd, home: fakeHome });
    const found = skills.find((s) => s.name === "mkt2_direct-skill");
    expect(found).toBeDefined();
    expect(found?.source).toBe("plugin");
    expect(found?.plugin).toBe("mkt2");
  });
});

describe("extractDescription", () => {
  test("returns default when content has no usable text", () => {
    expect(extractDescription("# Only heading\n---")).toBe("Claude Code skill");
  });

  test("extracts single-line description from frontmatter", () => {
    expect(extractDescription("---\ndescription: Short desc\n---\nbody\n")).toBe("Short desc");
  });

  test("extracts multi-line (block scalar) description", () => {
    // A following frontmatter key terminates the block scalar match.
    const content = "---\ndescription: >\n  Line one\n  line two\nname: x\n---\nbody\n";
    expect(extractDescription(content)).toBe("Line one line two");
  });

  test("strips wrapping quotes in single-line description", () => {
    expect(extractDescription(`---\ndescription: "quoted"\n---\n`)).toBe("quoted");
    expect(extractDescription(`---\ndescription: 'apos'\n---\n`)).toBe("apos");
  });

  test("truncates description to 256 chars", () => {
    const long = "x".repeat(400);
    const content = `---\ndescription: ${long}\n---\n`;
    const desc = extractDescription(content);
    expect(desc.length).toBe(256);
    expect(desc).toBe("x".repeat(256));
  });

  test("falls back to first non-header line when no frontmatter", () => {
    const content = "# Heading\n\nFirst real line here\nSecond line\n";
    expect(extractDescription(content)).toBe("First real line here");
  });

  test("skips blank lines, heading lines, and --- lines for the fallback", () => {
    const content = "\n---\n# Title\n\n\nActual body line\n";
    expect(extractDescription(content)).toBe("Actual body line");
  });
});
