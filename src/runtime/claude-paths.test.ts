import { describe, expect, test } from "bun:test";
import { projectSlugFromCwd } from "./claude-paths";

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
