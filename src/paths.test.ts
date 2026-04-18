import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HERMES_DIR_NAME,
  LEGACY_DIR_NAME,
  LEGACY_MANAGED_BLOCK_END,
  LEGACY_MANAGED_BLOCK_START,
  MANAGED_BLOCK_END,
  MANAGED_BLOCK_START,
  channelMemoryFile,
  crossSessionMemoryFile,
  discordInboxDir,
  hermesDir,
  identityMemoryFile,
  inboxDir,
  jobsDir,
  legacyDir,
  logsDir,
  memoryDir,
  migrationMarkerFile,
  pidFile,
  promptsDir,
  sessionFile,
  settingsFile,
  soulMemoryFile,
  stateDbFile,
  telegramInboxDir,
  threadSessionsFile,
  userMemoryFile,
} from "./paths";
// `legacyMemoryDir` is a NEW export added in Phase X. Import it via a
// namespace import so the test file still compiles (the direct named
// import above would fail at module-load time if the export is missing,
// which would turn the whole `paths.test.ts` suite red, not just our new
// tests). Using dynamic access lets the new test specifically fail while
// the rest of the file stays readable.
import * as paths from "./paths";

describe("path constants", () => {
  test("new layout lives under .claude/hermes", () => {
    expect(HERMES_DIR_NAME).toBe("hermes");
    expect(hermesDir("/tmp/proj")).toBe(join("/tmp/proj", ".claude", "hermes"));
  });

  test("legacy layout is claudeclaw", () => {
    expect(LEGACY_DIR_NAME).toBe("claudeclaw");
    expect(legacyDir("/tmp/proj")).toBe(join("/tmp/proj", ".claude", "claudeclaw"));
  });

  test("settings, session, threads all under hermes dir", () => {
    const root = "/tmp/x";
    expect(settingsFile(root)).toBe(join(root, ".claude", "hermes", "settings.json"));
    expect(sessionFile(root)).toBe(join(root, ".claude", "hermes", "session.json"));
    expect(threadSessionsFile(root)).toBe(join(root, ".claude", "hermes", "sessions.json"));
  });

  test("job/log/prompt/inbox/pid/db paths", () => {
    const root = "/tmp/y";
    expect(jobsDir(root)).toBe(join(root, ".claude", "hermes", "jobs"));
    expect(logsDir(root)).toBe(join(root, ".claude", "hermes", "logs"));
    expect(promptsDir(root)).toBe(join(root, ".claude", "hermes", "prompts"));
    expect(inboxDir(root)).toBe(join(root, ".claude", "hermes", "inbox"));
    expect(discordInboxDir(root)).toBe(join(root, ".claude", "hermes", "inbox", "discord"));
    expect(telegramInboxDir(root)).toBe(join(root, ".claude", "hermes", "inbox", "telegram"));
    expect(pidFile(root)).toBe(join(root, ".claude", "hermes", "daemon.pid"));
    expect(stateDbFile(root)).toBe(join(root, ".claude", "hermes", "state.db"));
    expect(migrationMarkerFile(root)).toBe(join(root, ".claude", "hermes", "MIGRATED.json"));
  });

  test("memory paths live under <cwd>/memory (project root, not .claude/hermes)", () => {
    const root = "/tmp/m";
    expect(memoryDir(root)).toBe(join(root, "memory"));
    expect(userMemoryFile(root)).toBe(join(root, "memory", "USER.md"));
    expect(crossSessionMemoryFile(root)).toBe(join(root, "memory", "MEMORY.md"));
    expect(soulMemoryFile(root)).toBe(join(root, "memory", "SOUL.md"));
    expect(identityMemoryFile(root)).toBe(join(root, "memory", "IDENTITY.md"));
    expect(channelMemoryFile("abc", root)).toBe(join(root, "memory", "channels", "abc.md"));
  });

  test("legacyMemoryDir exposes the old .claude/hermes/memory path for the migrator", () => {
    const root = "/tmp/m-legacy";
    // The new export must exist and return the OLD memory location.
    expect(typeof paths.legacyMemoryDir).toBe("function");
    expect(paths.legacyMemoryDir(root)).toBe(join(root, ".claude", "hermes", "memory"));
  });

  test("managed block markers carry the new name and expose legacy markers for migration", () => {
    expect(MANAGED_BLOCK_START).toBe("<!-- hermes:managed:start -->");
    expect(MANAGED_BLOCK_END).toBe("<!-- hermes:managed:end -->");
    expect(LEGACY_MANAGED_BLOCK_START).toBe("<!-- claudeclaw:managed:start -->");
    expect(LEGACY_MANAGED_BLOCK_END).toBe("<!-- claudeclaw:managed:end -->");
  });
});

// Files allowed to mention `claudeclaw` — anything else is a Phase 1 regression.
// Keep paths POSIX-style; the walker normalises separators before matching.
const CLAUDECLAW_ALLOWLIST: ReadonlySet<string> = new Set([
  "paths.ts",
  "paths.test.ts",
  "migrate/legacy.ts",
  "state/import-json.ts", // one-shot legacy-JSON importer
  "commands/start.ts", // user-facing migration log messages
  "runner.test.ts", // tests the legacy-marker rewrite behavior in ensureProjectClaudeMd
]);

async function walkTs(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      await walkTs(full, out);
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      out.push(full);
    }
  }
}

describe("no stray `claudeclaw` literals in src/", () => {
  test("only allowlisted files may mention the legacy name", async () => {
    const srcRoot = fileURLToPath(new URL(".", import.meta.url));
    const files: string[] = [];
    await walkTs(srcRoot, files);

    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(srcRoot, file).replace(/\\/g, "/");
      if (CLAUDECLAW_ALLOWLIST.has(rel)) continue;
      const content = await readFile(file, "utf8");
      if (/claudeclaw/i.test(content)) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });
});
