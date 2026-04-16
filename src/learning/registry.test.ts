import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, closeDb, type Database, openDb, skillsRepo } from "../state";

// The learning registry wraps discovery with DB-backed status gating. Discovery
// pulls from homedir()+cwd at call time, so we stub HOME/USERPROFILE and chdir
// into a fake project, then import the module so it picks up our fakes.
const ORIG_HOME = process.env.HOME;
const ORIG_USERPROFILE = process.env.USERPROFILE;
const ORIG_CWD = process.cwd();

let tempRoot: string;
let fakeHome: string;
let fakeProject: string;
let globalSkillsDir: string;
let projectSkillsDir: string;
let db: Database;

type LearningRegistry = typeof import("./registry");
let reg: LearningRegistry;

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(join(tmpdir(), "hermes-learn-reg-"));
  fakeHome = join(tempRoot, "home");
  fakeProject = join(tempRoot, "project");
  globalSkillsDir = join(fakeHome, ".claude", "skills");
  projectSkillsDir = join(fakeProject, ".claude", "skills");
  await fs.mkdir(globalSkillsDir, { recursive: true });
  await fs.mkdir(projectSkillsDir, { recursive: true });

  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  process.chdir(fakeProject);

  reg = await import("./registry");
  db = openDb({ path: ":memory:" });
  await applyMigrations(db);
});

afterAll(async () => {
  closeDb(db);
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
  await fs.mkdir(projectSkillsDir, { recursive: true });
  await fs.mkdir(globalSkillsDir, { recursive: true });
  db.exec("DELETE FROM skills");
}

async function writeSkill(root: string, name: string, body: string): Promise<void> {
  const dir = join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, "SKILL.md"), body);
}

beforeEach(async () => {
  await reset();
});

describe("listActiveSkills", () => {
  test("returns empty array when no skills are active in DB", async () => {
    await writeSkill(globalSkillsDir, "fs-only", "---\ndescription: x\n---\n");
    const active = await reg.listActiveSkills(db);
    expect(active).toEqual([]);
  });

  test("only returns filesystem skills whose DB row has status=active", async () => {
    await writeSkill(globalSkillsDir, "alpha", "---\ndescription: a\n---\n");
    await writeSkill(globalSkillsDir, "beta", "---\ndescription: b\n---\n");
    await writeSkill(globalSkillsDir, "gamma", "---\ndescription: g\n---\n");

    skillsRepo.upsertSkill(db, { name: "alpha", path: "/tmp/a", status: "active" });
    skillsRepo.upsertSkill(db, { name: "beta", path: "/tmp/b", status: "shadow" });
    // gamma has no DB row

    const active = await reg.listActiveSkills(db);
    const names = active.map((s) => s.name).sort();
    expect(names).toEqual(["alpha"]);
  });

  test("skills with status candidate/shadow/disabled are excluded from active list", async () => {
    await writeSkill(globalSkillsDir, "c", "---\ndescription: c\n---\n");
    await writeSkill(globalSkillsDir, "s", "---\ndescription: s\n---\n");
    await writeSkill(globalSkillsDir, "d", "---\ndescription: d\n---\n");
    skillsRepo.upsertSkill(db, { name: "c", path: "/x", status: "candidate" });
    skillsRepo.upsertSkill(db, { name: "s", path: "/x", status: "shadow" });
    skillsRepo.upsertSkill(db, { name: "d", path: "/x", status: "disabled" });

    const active = await reg.listActiveSkills(db);
    expect(active).toEqual([]);
  });
});

describe("listCandidateSkills", () => {
  test("returns filesystem skills whose DB row is candidate or shadow", async () => {
    await writeSkill(globalSkillsDir, "cand", "---\ndescription: c\n---\n");
    await writeSkill(globalSkillsDir, "shad", "---\ndescription: s\n---\n");
    await writeSkill(globalSkillsDir, "act", "---\ndescription: a\n---\n");

    skillsRepo.upsertSkill(db, { name: "cand", path: "/x", status: "candidate" });
    skillsRepo.upsertSkill(db, { name: "shad", path: "/x", status: "shadow" });
    skillsRepo.upsertSkill(db, { name: "act", path: "/x", status: "active" });

    const candidates = await reg.listCandidateSkills(db);
    const names = candidates.map((s) => s.name).sort();
    expect(names).toEqual(["cand", "shad"]);
  });

  test("returns [] when no skills are in candidate/shadow status", async () => {
    await writeSkill(globalSkillsDir, "a", "---\ndescription: a\n---\n");
    expect(await reg.listCandidateSkills(db)).toEqual([]);
  });

  test("skill present in DB but missing on disk is excluded", async () => {
    skillsRepo.upsertSkill(db, { name: "ghost", path: "/tmp/gone", status: "candidate" });
    expect(await reg.listCandidateSkills(db)).toEqual([]);
  });
});

describe("re-exports", () => {
  test("exposes listSkills from the pure skills module", async () => {
    await writeSkill(globalSkillsDir, "re-export", "---\ndescription: x\n---\n");
    const all = await reg.listSkills();
    expect(all.map((s) => s.name)).toContain("re-export");
  });

  test("exposes resolveSkillPrompt from the pure skills module", async () => {
    await writeSkill(globalSkillsDir, "resolve-me", "BODY");
    expect(await reg.resolveSkillPrompt("resolve-me")).toBe("BODY");
  });

  test("exposes discoverSkills and extractDescription from discovery", () => {
    expect(typeof reg.discoverSkills).toBe("function");
    expect(typeof reg.extractDescription).toBe("function");
  });
});
