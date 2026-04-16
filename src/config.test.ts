import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config.ts now resolves its filesystem paths lazily via `src/paths.ts` helpers,
// so we only need to chdir before the first call (not before module load). We
// still do the chdir in beforeAll for clarity, and reloadSettings() is used to
// bypass the in-memory `cached` Settings object between tests whenever the
// on-disk settings.json changes.

const ORIG_CWD = process.cwd();
const TEMP_DIR = join(tmpdir(), `hermes-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const HERMES_DIR = join(TEMP_DIR, ".claude", "hermes");
const SETTINGS_FILE = join(HERMES_DIR, "settings.json");

let config: typeof import("./config");

beforeAll(async () => {
  await mkdir(HERMES_DIR, { recursive: true });
  process.chdir(TEMP_DIR);
  config = await import("./config");
});

afterAll(async () => {
  process.chdir(ORIG_CWD);
  await rm(TEMP_DIR, { recursive: true, force: true });
});

afterEach(async () => {
  // Remove the settings file between tests so each test starts clean. The
  // module-level `cached` Settings object is refreshed by calling
  // reloadSettings() (or a fresh loadSettings after a deletion + rewrite).
  await rm(SETTINGS_FILE, { force: true });
});

async function writeSettings(raw: string): Promise<void> {
  await writeFile(SETTINGS_FILE, raw);
}

describe("resolvePrompt", () => {
  test("returns literal string when prompt is plain text", async () => {
    expect(await config.resolvePrompt("hello world")).toBe("hello world");
  });

  test("falls back to trimmed literal when .md path does not exist", async () => {
    // "some.md" ends with a prompt extension → config will try to read it,
    // fail, and gracefully return the trimmed literal string.
    expect(await config.resolvePrompt("  some.md  ")).toBe("some.md");
  });

  test("reads prompt file contents when .md path exists", async () => {
    const fixtureRel = "fixture.md";
    const fixtureAbs = join(TEMP_DIR, fixtureRel);
    await writeFile(fixtureAbs, "prompt body");
    try {
      expect(await config.resolvePrompt(`./${fixtureRel}`)).toBe("prompt body");
    } finally {
      await rm(fixtureAbs, { force: true });
    }
  });
});

describe("loadSettings / reloadSettings", () => {
  test("returns defaults after initConfig on a fresh cwd", async () => {
    await config.initConfig();
    const settings = await config.reloadSettings();

    expect(settings.heartbeat.enabled).toBe(false);
    expect(settings.security.level).toBe("moderate");
    expect(settings.telegram.token).toBe("");
    expect(settings.telegram.allowedUserIds).toEqual([]);
    expect(settings.discord.token).toBe("");
    expect(settings.discord.allowedUserIds).toEqual([]);
  });

  test("invalid security.level falls back to 'moderate'", async () => {
    await writeSettings(
      JSON.stringify({
        security: { level: "bogus", allowedTools: [], disallowedTools: [] },
      })
    );
    const settings = await config.reloadSettings();
    expect(settings.security.level).toBe("moderate");
  });

  test("preserves Discord snowflake precision for values above Number.MAX_SAFE_INTEGER", async () => {
    // Both IDs exceed Number.MAX_SAFE_INTEGER (9007199254740992) and would be
    // mangled by a naive JSON.parse. The extractDiscordUserIds regex reads
    // them as strings directly from the raw JSON text.
    const rawText = `{
  "discord": {
    "token": "",
    "allowedUserIds": [1234567890123456789, 9999999999999999999],
    "listenChannels": []
  }
}
`;
    await writeSettings(rawText);
    const settings = await config.reloadSettings();

    expect(settings.discord.allowedUserIds).toContain("1234567890123456789");
    expect(settings.discord.allowedUserIds).toContain("9999999999999999999");
    // Guard against float-mangled variants sneaking in.
    for (const id of settings.discord.allowedUserIds) {
      expect(typeof id).toBe("string");
    }
  });

  test("reloadSettings bypasses cache and picks up on-disk changes", async () => {
    // Seed an initial settings file and prime the cache via reloadSettings
    // (loadSettings would return whatever a previous test left cached).
    await writeSettings(JSON.stringify({ telegram: { token: "first-token", allowedUserIds: [] } }));
    const first = await config.reloadSettings();
    expect(first.telegram.token).toBe("first-token");

    // Overwrite on disk; a plain loadSettings() should still return the cache.
    await writeSettings(JSON.stringify({ telegram: { token: "second-token", allowedUserIds: [] } }));
    const stillCached = await config.loadSettings();
    expect(stillCached.telegram.token).toBe("first-token");

    const refreshed = await config.reloadSettings();
    expect(refreshed.telegram.token).toBe("second-token");
  });
});
