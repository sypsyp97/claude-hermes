import { describe, expect, test } from "bun:test";
import { claudeArgv, resolveClaudeBin } from "./claude-cli";

describe("resolveClaudeBin", () => {
  test("returns default when no env and no override", () => {
    expect(resolveClaudeBin({ env: {} })).toEqual(["claude"]);
  });

  test("explicit override wins over env", () => {
    expect(
      resolveClaudeBin({
        override: "fake-bin",
        env: { HERMES_CLAUDE_BIN: "envy" },
      })
    ).toEqual(["fake-bin"]);
  });

  test("env var single token", () => {
    expect(resolveClaudeBin({ env: { HERMES_CLAUDE_BIN: "whatever" } })).toEqual(["whatever"]);
  });

  test("env var with whitespace splits on whitespace", () => {
    expect(
      resolveClaudeBin({
        env: { HERMES_CLAUDE_BIN: "bun run tests/fixtures/fake-claude.ts" },
      })
    ).toEqual(["bun", "run", "tests/fixtures/fake-claude.ts"]);
  });

  test("env var with extra whitespace trims and drops empty tokens", () => {
    expect(
      resolveClaudeBin({
        env: { HERMES_CLAUDE_BIN: "  bun   run   foo.ts  " },
      })
    ).toEqual(["bun", "run", "foo.ts"]);
  });

  test("empty env value falls back to default", () => {
    expect(resolveClaudeBin({ env: { HERMES_CLAUDE_BIN: "" } })).toEqual(["claude"]);
  });
});

describe("claudeArgv", () => {
  test("is a thin alias for resolveClaudeBin", () => {
    const inputs = [
      { env: {} },
      { override: "fake-bin", env: { HERMES_CLAUDE_BIN: "envy" } },
      { env: { HERMES_CLAUDE_BIN: "whatever" } },
      { env: { HERMES_CLAUDE_BIN: "bun run tests/fixtures/fake-claude.ts" } },
      { env: { HERMES_CLAUDE_BIN: "  bun   run   foo.ts  " } },
      { env: { HERMES_CLAUDE_BIN: "" } },
    ];
    for (const opts of inputs) {
      expect(claudeArgv(opts)).toEqual(resolveClaudeBin(opts));
    }
  });
});
