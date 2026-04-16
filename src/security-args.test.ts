import { describe, expect, test } from "bun:test";
import type { SecurityConfig } from "./config";
import { buildSecurityArgs } from "./runner";

function cfg(overrides: Partial<SecurityConfig> = {}): SecurityConfig {
  return {
    level: "moderate",
    allowedTools: [],
    disallowedTools: [],
    bypassPermissions: false,
    ...overrides,
  };
}

describe("buildSecurityArgs — bypass flag is opt-in", () => {
  test("default config does NOT emit --dangerously-skip-permissions", () => {
    const args = buildSecurityArgs(cfg());
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  test("only emits --dangerously-skip-permissions when bypassPermissions=true", () => {
    const args = buildSecurityArgs(cfg({ bypassPermissions: true }));
    expect(args).toContain("--dangerously-skip-permissions");
  });

  test("bypass=false + level=unrestricted still does NOT emit the bypass flag", () => {
    // Level is about tool surface, not permission prompts. The only knob that
    // removes the prompt is the explicit bypass flag.
    const args = buildSecurityArgs(cfg({ level: "unrestricted" }));
    expect(args).not.toContain("--dangerously-skip-permissions");
  });
});

describe("buildSecurityArgs — level presets use the CLI-standard flags", () => {
  test("locked → --allowedTools Read,Grep,Glob (not --tools)", () => {
    const args = buildSecurityArgs(cfg({ level: "locked" }));
    const idx = args.indexOf("--allowedTools");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("Read,Grep,Glob");
    // The non-standard `--tools` flag is gone.
    expect(args).not.toContain("--tools");
  });

  test("strict → --disallowedTools Bash,WebSearch,WebFetch", () => {
    const args = buildSecurityArgs(cfg({ level: "strict" }));
    const idx = args.indexOf("--disallowedTools");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("Bash,WebSearch,WebFetch");
  });

  test("moderate emits no tool-surface flags by default", () => {
    const args = buildSecurityArgs(cfg({ level: "moderate" }));
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("--disallowedTools");
    expect(args).not.toContain("--tools");
  });

  test("unrestricted emits no tool-surface flags", () => {
    const args = buildSecurityArgs(cfg({ level: "unrestricted" }));
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("--disallowedTools");
  });
});

describe("buildSecurityArgs — tool lists are comma-joined, not space-joined", () => {
  test("allowedTools list is passed as a single comma-joined value", () => {
    const args = buildSecurityArgs(cfg({ allowedTools: ["Read", "Bash"] }));
    const idx = args.indexOf("--allowedTools");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("Read,Bash");
    // Defense against regressions: a space-joined value would collapse to a
    // single tool name and silently fail closed.
    expect(args[idx + 1]).not.toBe("Read Bash");
  });

  test("disallowedTools list is passed as a single comma-joined value", () => {
    const args = buildSecurityArgs(cfg({ disallowedTools: ["WebFetch", "Bash", "WebSearch"] }));
    const idx = args.indexOf("--disallowedTools");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("WebFetch,Bash,WebSearch");
  });

  test("empty caller lists do not add stray flags", () => {
    const args = buildSecurityArgs(cfg());
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("--disallowedTools");
  });
});
