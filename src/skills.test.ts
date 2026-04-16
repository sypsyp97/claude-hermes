import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The skills module computes homedir()/cwd at call time. We isolate by
// stubbing HOME (POSIX) and USERPROFILE (Windows) so os.homedir() resolves
// into our temp dir, and chdir into a fake project. The env mutation must
// happen BEFORE the first dynamic import so the module binds to our stubs.
const ORIG_HOME = process.env.HOME;
const ORIG_USERPROFILE = process.env.USERPROFILE;
const ORIG_CWD = process.cwd();

let tempRoot: string;
let fakeHome: string;
let fakeProject: string;
let globalSkillsDir: string;
let projectSkillsDir: string;

type SkillsModule = typeof import("./skills");
let skillsMod: SkillsModule;

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(join(tmpdir(), "hermes-skills-"));
  fakeHome = join(tempRoot, "home");
  fakeProject = join(tempRoot, "project");
  globalSkillsDir = join(fakeHome, ".claude", "skills");
  projectSkillsDir = join(fakeProject, ".claude", "skills");
  await fs.mkdir(globalSkillsDir, { recursive: true });
  await fs.mkdir(projectSkillsDir, { recursive: true });

  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  process.chdir(fakeProject);

  skillsMod = await import("./skills");
});

afterAll(async () => {
  process.chdir(ORIG_CWD);
  if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME;
  else delete process.env.HOME;
  if (ORIG_USERPROFILE !== undefined) process.env.USERPROFILE = ORIG_USERPROFILE;
  else delete process.env.USERPROFILE;
  await fs.rm(tempRoot, { recursive: true, force: true });
});

async function clearSkills(): Promise<void> {
  await fs.rm(projectSkillsDir, { recursive: true, force: true });
  await fs.rm(globalSkillsDir, { recursive: true, force: true });
  await fs.mkdir(projectSkillsDir, { recursive: true });
  await fs.mkdir(globalSkillsDir, { recursive: true });
}

async function writeSkill(root: string, name: string, body: string): Promise<void> {
  const dir = join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, "SKILL.md"), body);
}

beforeEach(async () => {
  await clearSkills();
});

describe("listSkills", () => {
  test("returns empty array when no skills exist", async () => {
    const skills = await skillsMod.listSkills();
    expect(skills).toEqual([]);
  });

  test("dedupes by name when a skill exists in both project and global (project wins)", async () => {
    await writeSkill(projectSkillsDir, "shared", "project body\n");
    await writeSkill(globalSkillsDir, "shared", "global body\n");

    const skills = await skillsMod.listSkills();
    const shared = skills.filter((s) => s.name === "shared");
    expect(shared).toHaveLength(1);
    // description comes from the first (project) body
    expect(shared[0].description).toBe("project body");
  });

  test("extracts single-line frontmatter description", async () => {
    await writeSkill(globalSkillsDir, "single", "---\ndescription: Short desc\n---\nbody\n");
    const skills = await skillsMod.listSkills();
    const found = skills.find((s) => s.name === "single");
    expect(found?.description).toBe("Short desc");
  });

  test("extracts multi-line frontmatter description (block scalar)", async () => {
    // The multi-line branch of extractDescription terminates on a following
    // frontmatter key (`\n\w`), so include a trailing field to make the
    // block scalar well-formed for the module's parser.
    await writeSkill(
      globalSkillsDir,
      "multi",
      "---\ndescription: >\n  This is\n  multi line\nname: multi\n---\nbody\n"
    );
    const skills = await skillsMod.listSkills();
    const found = skills.find((s) => s.name === "multi");
    expect(found?.description).toBe("This is multi line");
    expect(found!.description.length).toBeLessThanOrEqual(256);
  });

  test("falls back to first non-header, non-empty line when no frontmatter", async () => {
    await writeSkill(globalSkillsDir, "nofm", "# Heading\n\nFirst real line here\nSecond line\n");
    const skills = await skillsMod.listSkills();
    const found = skills.find((s) => s.name === "nofm");
    expect(found?.description).toBe("First real line here");
  });

  test("truncates description to 256 chars", async () => {
    const long = "x".repeat(400);
    await writeSkill(globalSkillsDir, "long", `---\ndescription: ${long}\n---\nbody\n`);
    const skills = await skillsMod.listSkills();
    const found = skills.find((s) => s.name === "long");
    expect(found?.description.length).toBe(256);
    expect(found?.description).toBe("x".repeat(256));
  });
});

describe("resolveSkillPrompt", () => {
  test("returns null when nothing is installed", async () => {
    expect(await skillsMod.resolveSkillPrompt("anything")).toBeNull();
  });

  test("returns null for a missing skill even when others exist", async () => {
    await writeSkill(globalSkillsDir, "other", "something\n");
    expect(await skillsMod.resolveSkillPrompt("ghost")).toBeNull();
  });

  test("project skill takes priority over global skill of same name", async () => {
    await writeSkill(projectSkillsDir, "hello", "PROJECT HELLO");
    await writeSkill(globalSkillsDir, "hello", "GLOBAL HELLO");

    const content = await skillsMod.resolveSkillPrompt("hello");
    expect(content).toBe("PROJECT HELLO");
  });

  test("falls back to global when project does not have the skill", async () => {
    await writeSkill(globalSkillsDir, "foo", "GLOBAL FOO BODY");
    const content = await skillsMod.resolveSkillPrompt("foo");
    expect(content).toBe("GLOBAL FOO BODY");
  });

  test("strips a leading '/' from the command name", async () => {
    await writeSkill(globalSkillsDir, "leading-slash", "slashed body");
    const content = await skillsMod.resolveSkillPrompt("/leading-slash");
    expect(content).toBe("slashed body");
  });
});
