import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// registry.ts calls homedir() and process.cwd() internally, so we stub HOME +
// USERPROFILE and chdir into a fake project. This mirrors the pattern already
// used in src/skills.test.ts (which covers the barrel export).
const ORIG_HOME = process.env.HOME;
const ORIG_USERPROFILE = process.env.USERPROFILE;
const ORIG_CWD = process.cwd();

let tempRoot: string;
let fakeHome: string;
let fakeProject: string;
let globalSkillsDir: string;
let projectSkillsDir: string;
let pluginsDir: string;

type RegistryModule = typeof import("./registry");
let reg: RegistryModule;

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(join(tmpdir(), "hermes-reg-"));
  fakeHome = join(tempRoot, "home");
  fakeProject = join(tempRoot, "project");
  globalSkillsDir = join(fakeHome, ".claude", "skills");
  projectSkillsDir = join(fakeProject, ".claude", "skills");
  pluginsDir = join(fakeHome, ".claude", "plugins");
  await fs.mkdir(globalSkillsDir, { recursive: true });
  await fs.mkdir(projectSkillsDir, { recursive: true });
  await fs.mkdir(pluginsDir, { recursive: true });

  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  process.chdir(fakeProject);

  reg = await import("./registry");
});

afterAll(async () => {
  process.chdir(ORIG_CWD);
  if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  else delete process.env.HOME;
  if (ORIG_USERPROFILE !== undefined) process.env.USERPROFILE = ORIG_USERPROFILE;
  else delete process.env.USERPROFILE;
  await fs.rm(tempRoot, { recursive: true, force: true });
});

async function reset(): Promise<void> {
  await fs.rm(projectSkillsDir, { recursive: true, force: true });
  await fs.rm(globalSkillsDir, { recursive: true, force: true });
  await fs.rm(pluginsDir, { recursive: true, force: true });
  await fs.mkdir(projectSkillsDir, { recursive: true });
  await fs.mkdir(globalSkillsDir, { recursive: true });
  await fs.mkdir(pluginsDir, { recursive: true });
}

async function writeSkill(root: string, name: string, body: string): Promise<void> {
  const dir = join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, "SKILL.md"), body);
}

beforeEach(async () => {
  await reset();
});

describe("listSkills", () => {
  test("returns empty array when nothing is installed", async () => {
    const skills = await reg.listSkills();
    expect(skills).toEqual([]);
  });

  test("returns discovered skills from project + global", async () => {
    await writeSkill(projectSkillsDir, "proj-only", "---\ndescription: p\n---\n");
    await writeSkill(globalSkillsDir, "glob-only", "---\ndescription: g\n---\n");
    const skills = await reg.listSkills();
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["glob-only", "proj-only"]);
  });
});

describe("resolveSkillPrompt", () => {
  test("returns null for empty command (just '/')", async () => {
    expect(await reg.resolveSkillPrompt("/")).toBeNull();
  });

  test("returns null when the named skill does not exist anywhere", async () => {
    await writeSkill(globalSkillsDir, "other", "body");
    expect(await reg.resolveSkillPrompt("ghost")).toBeNull();
  });

  test("strips a leading slash from the command", async () => {
    await writeSkill(globalSkillsDir, "hi", "hello world");
    expect(await reg.resolveSkillPrompt("/hi")).toBe("hello world");
  });

  test("project skill takes precedence over global skill with same name", async () => {
    await writeSkill(projectSkillsDir, "shared", "PROJECT CONTENT");
    await writeSkill(globalSkillsDir, "shared", "GLOBAL CONTENT");
    expect(await reg.resolveSkillPrompt("shared")).toBe("PROJECT CONTENT");
  });

  test("falls back to global when the project lacks the skill", async () => {
    await writeSkill(globalSkillsDir, "only-global", "ONLY GLOBAL");
    expect(await reg.resolveSkillPrompt("only-global")).toBe("ONLY GLOBAL");
  });

  test("returns null when the SKILL.md is present but empty/whitespace", async () => {
    await writeSkill(globalSkillsDir, "blank", "");
    await writeSkill(globalSkillsDir, "ws", "   \n  ");
    expect(await reg.resolveSkillPrompt("blank")).toBeNull();
    expect(await reg.resolveSkillPrompt("ws")).toBeNull();
  });

  test("finds a plugin skill under plugins/<marketplace>/skills/<name>/SKILL.md", async () => {
    const pluginSkillDir = join(pluginsDir, "mymkt", "skills", "plug-skill");
    await fs.mkdir(pluginSkillDir, { recursive: true });
    await fs.writeFile(join(pluginSkillDir, "SKILL.md"), "PLUGIN BODY");

    expect(await reg.resolveSkillPrompt("plug-skill")).toBe("PLUGIN BODY");
  });

  test("respects plugin hint (marketplace:skill) to restrict search", async () => {
    // One marketplace has the skill, another does not; the hint should steer
    // the search to the right marketplace.
    const mktSkill = join(pluginsDir, "want-this", "skills", "target");
    await fs.mkdir(mktSkill, { recursive: true });
    await fs.writeFile(join(mktSkill, "SKILL.md"), "FROM WANT-THIS");

    const otherMkt = join(pluginsDir, "other", "skills", "target");
    await fs.mkdir(otherMkt, { recursive: true });
    await fs.writeFile(join(otherMkt, "SKILL.md"), "FROM OTHER");

    expect(await reg.resolveSkillPrompt("want-this:target")).toBe("FROM WANT-THIS");
  });

  test("finds a skill in the plugins cache directory (versioned path)", async () => {
    const cachedSkill = join(pluginsDir, "cache", "mkt", "plug", "v1", "skills", "cached");
    await fs.mkdir(cachedSkill, { recursive: true });
    await fs.writeFile(join(cachedSkill, "SKILL.md"), "CACHED BODY");

    expect(await reg.resolveSkillPrompt("cached")).toBe("CACHED BODY");
  });
});
