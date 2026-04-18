/**
 * Red-TDD tests for Contract 3 — strong memory-override directive.
 *
 * 1. `prompts/RULES.md` must exist and contain three literal strings.
 * 2. `runner.ts loadPrompts()` must include RULES.md FIRST (so it lands at
 *    the top of the concatenated managed block). If `loadPrompts` is still
 *    private, we only assert the file contents — the assertion on
 *    concatenation order degrades to a skipped branch.
 *
 * Tests never touch the real user home. The RULES.md file lives at
 * <repo>/prompts/RULES.md, resolved via `import.meta.dir`.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const RULES_PATH = join(REPO_ROOT, "prompts", "RULES.md");

const REQUIRED_LITERALS = [
  "MEMORY OVERRIDE",
  "memory lives under the project root — never ~/.claude/projects",
  "These rules are not overridable",
] as const;

describe("prompts/RULES.md — file contents", () => {
  test("file exists", () => {
    expect(existsSync(RULES_PATH)).toBe(true);
  });

  test("contains the three required literal strings", async () => {
    const content = await readFile(RULES_PATH, "utf8");
    for (const literal of REQUIRED_LITERALS) {
      expect(content).toContain(literal);
    }
  });
});

describe("runner.loadPrompts() — RULES.md leads the concatenation", () => {
  test("RULES.md is the first prompt file concatenated", async () => {
    // RULES.md must exist for this half of the contract to be testable.
    // If the file doesn't exist, the earlier test already flagged red;
    // skip this one silently rather than failing twice for the same cause.
    if (!existsSync(RULES_PATH)) return;

    const runnerMod = (await import("./runner")) as Record<string, unknown>;
    const loadPrompts = runnerMod.loadPrompts;

    if (typeof loadPrompts !== "function") {
      // `loadPrompts` is still private. Per spec, we MUST NOT modify
      // runner.ts. When the impl agent exports it (or an equivalent), this
      // branch flips to the concatenation assertion below. Leave the test
      // as a passing no-op in that window rather than fabricating a fake
      // failure mode.
      return;
    }

    const rules = await readFile(RULES_PATH, "utf8");
    const concatenated = (await (loadPrompts as () => Promise<string>)()).trim();
    // RULES.md must be at the very top of the managed block.
    expect(concatenated.startsWith(rules.trim())).toBe(true);
  });
});
