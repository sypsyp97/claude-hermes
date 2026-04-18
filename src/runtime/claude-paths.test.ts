import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  claudeProjectDir,
  claudeProjectMemoryDir,
  claudeProjectsDir,
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
