import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileCandidate } from "../learning/compiler";
import { appendTrajectory, readSkill } from "./library";
import { resolveSkillPrompt } from "./registry";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hermes-skill-path-safety-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("skill prompt resolution rejects path traversal instead of loading sibling instructions", async () => {
  const cwd = join(root, "workspace");
  const home = join(root, "home");
  await mkdir(join(cwd, ".claude", "private"), { recursive: true });
  await writeFile(join(cwd, ".claude", "private", "SKILL.md"), "private instructions");
  await mkdir(join(home, ".claude", "plugins", "private", "plugin", "v1", "skills", "target"), {
    recursive: true,
  });
  await writeFile(
    join(home, ".claude", "plugins", "private", "plugin", "v1", "skills", "target", "SKILL.md"),
    "outside cache"
  );
  for (const command of [
    "../private",
    "/../private",
    "../private:target",
    "market:../private",
    "..\\private",
    "/absolute/path",
    ".",
    "..",
  ]) {
    expect(await resolveSkillPrompt(command, { cwd, home })).toBeNull();
  }
});

test("skill library reads and trajectory appends reject escaping names", async () => {
  const sibling = join(root, ".claude", "hermes", "private");
  await mkdir(sibling, { recursive: true });
  await writeFile(join(sibling, "SKILL.md"), "private instructions");
  await writeFile(join(sibling, "trajectory.jsonl"), "sentinel\n");
  await expect(readSkill("../private", root)).rejects.toThrow("invalid skill name");
  await expect(appendTrajectory("../private", { tool: "Read", ok: true }, root)).rejects.toThrow(
    "invalid skill name"
  );
  expect(await readFile(join(sibling, "trajectory.jsonl"), "utf8")).toBe("sentinel\n");
});

test("candidate compilation rejects escaping names before writing any files", async () => {
  for (const skillName of [
    "../private",
    "../../../../outside",
    "..\\private",
    "",
    ".",
    "C:private",
    "parent/child",
  ]) {
    await expect(
      compileCandidate(
        {
          skillName,
          seenCount: 3,
          firstSeen: "2026-10-01T00:00:00.000Z",
          lastSeen: "2026-10-06T00:00:00.000Z",
          suggestedStatus: "shadow",
        },
        { cwd: root }
      )
    ).rejects.toThrow("invalid skill name");
  }
  expect(await readdir(root)).toEqual([]);
});
