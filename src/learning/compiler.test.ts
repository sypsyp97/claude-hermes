import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileCandidate } from "./compiler";
import type { CandidateSpec } from "./detector";

// compileCandidate writes into hermesDir(cwd)/skills/candidates/<name>. The
// `opts.cwd` argument lets us pin the output tree to a tmp dir without
// mutating process.cwd.
let tempRoot: string;

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(join(tmpdir(), "hermes-compile-"));
});

afterAll(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  // Fresh workspace per test to make the SKILL.md / skill.yaml comparisons
  // easy to reason about.
  await fs.rm(tempRoot, { recursive: true, force: true });
  await fs.mkdir(tempRoot, { recursive: true });
});

function makeSpec(overrides: Partial<CandidateSpec> = {}): CandidateSpec {
  return {
    skillName: "test-skill",
    seenCount: 5,
    firstSeen: "2026-04-01T00:00:00.000Z",
    lastSeen: "2026-04-10T00:00:00.000Z",
    suggestedStatus: "shadow",
    ...overrides,
  };
}

describe("compileCandidate", () => {
  test("creates SKILL.md and skill.yaml in the candidates dir", async () => {
    const result = await compileCandidate(makeSpec(), { cwd: tempRoot });
    expect(result.name).toBe("test-skill");
    expect(existsSync(result.skillMdPath)).toBe(true);
    expect(existsSync(result.skillYamlPath)).toBe(true);
    expect(result.dir).toContain(join("skills", "candidates", "test-skill"));
  });

  test("SKILL.md contains frontmatter with name, description, and status=candidate", async () => {
    const result = await compileCandidate(makeSpec({ skillName: "my-skill" }), {
      cwd: tempRoot,
      description: "My custom description.",
    });
    const content = await fs.readFile(result.skillMdPath, "utf8");
    expect(content).toContain("---");
    expect(content).toContain("name: my-skill");
    expect(content).toContain("description: My custom description.");
    expect(content).toContain("status: candidate");
  });

  test("SKILL.md body defaults to auto-generated text referencing seenCount + dates", async () => {
    const spec = makeSpec({
      skillName: "defaulted",
      seenCount: 7,
      firstSeen: "2026-03-01T00:00:00.000Z",
      lastSeen: "2026-03-15T00:00:00.000Z",
    });
    const result = await compileCandidate(spec, { cwd: tempRoot });
    const content = await fs.readFile(result.skillMdPath, "utf8");
    expect(content).toContain("auto-compiled candidate skill");
    expect(content).toContain("`defaulted`");
    expect(content).toContain("7 successful shadow runs");
    expect(content).toContain("2026-03-01T00:00:00.000Z");
    expect(content).toContain("2026-03-15T00:00:00.000Z");
  });

  test("custom body overrides default body", async () => {
    const result = await compileCandidate(makeSpec(), {
      cwd: tempRoot,
      body: "Totally custom body content.",
    });
    const content = await fs.readFile(result.skillMdPath, "utf8");
    expect(content).toContain("Totally custom body content.");
    expect(content).not.toContain("auto-compiled candidate skill");
  });

  test("skill.yaml records name, status, dates, shadow_runs, and empty arrays by default", async () => {
    const spec = makeSpec({
      skillName: "yaml-check",
      seenCount: 9,
      firstSeen: "2026-01-01T00:00:00.000Z",
      lastSeen: "2026-01-10T00:00:00.000Z",
    });
    const result = await compileCandidate(spec, { cwd: tempRoot });
    const yaml = await fs.readFile(result.skillYamlPath, "utf8");
    expect(yaml).toContain("name: yaml-check");
    expect(yaml).toContain("status: candidate");
    expect(yaml).toContain("first_seen: 2026-01-01T00:00:00.000Z");
    expect(yaml).toContain("last_seen: 2026-01-10T00:00:00.000Z");
    expect(yaml).toContain("shadow_runs: 9");
    expect(yaml).toContain("allowed_tools: []");
    expect(yaml).toContain("source_run_ids: []");
  });

  test("allowedTools and sourceRunIds are serialised into the yaml", async () => {
    const result = await compileCandidate(makeSpec(), {
      cwd: tempRoot,
      allowedTools: ["Read", "Edit", "Bash"],
      sourceRunIds: [1, 2, 3],
    });
    const yaml = await fs.readFile(result.skillYamlPath, "utf8");
    expect(yaml).toContain(`allowed_tools: ["Read", "Edit", "Bash"]`);
    expect(yaml).toContain("source_run_ids: [1, 2, 3]");
  });

  test("output is stable — same input → identical files on a re-run", async () => {
    const spec = makeSpec({ skillName: "stable" });
    const first = await compileCandidate(spec, {
      cwd: tempRoot,
      description: "desc",
      body: "body",
      allowedTools: ["A"],
      sourceRunIds: [1],
    });
    const firstMd = await fs.readFile(first.skillMdPath, "utf8");
    const firstYaml = await fs.readFile(first.skillYamlPath, "utf8");

    // Recompile into the same dir with identical inputs.
    const second = await compileCandidate(spec, {
      cwd: tempRoot,
      description: "desc",
      body: "body",
      allowedTools: ["A"],
      sourceRunIds: [1],
    });
    const secondMd = await fs.readFile(second.skillMdPath, "utf8");
    const secondYaml = await fs.readFile(second.skillYamlPath, "utf8");

    expect(secondMd).toBe(firstMd);
    expect(secondYaml).toBe(firstYaml);
  });

  test("returns absolute paths rooted in cwd + skills/candidates/<name>", async () => {
    const result = await compileCandidate(makeSpec({ skillName: "pathed" }), { cwd: tempRoot });
    expect(result.skillMdPath).toContain(tempRoot);
    expect(result.skillMdPath.endsWith("SKILL.md")).toBe(true);
    expect(result.skillYamlPath.endsWith("skill.yaml")).toBe(true);
    expect(result.dir).toBe(join(tempRoot, ".claude", "hermes", "skills", "candidates", "pathed"));
  });

  test("creates nested parent directories", async () => {
    const fresh = await fs.mkdtemp(join(tmpdir(), "hermes-compile-nested-"));
    try {
      const result = await compileCandidate(makeSpec({ skillName: "deep" }), { cwd: fresh });
      expect(existsSync(result.dir)).toBe(true);
    } finally {
      await fs.rm(fresh, { recursive: true, force: true });
    }
  });
});
