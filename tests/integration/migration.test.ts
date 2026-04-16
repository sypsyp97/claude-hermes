import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIG_CWD = process.cwd();
let root: string;

beforeAll(async () => {
  root = join(tmpdir(), `hermes-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(root, { recursive: true });
});

afterAll(async () => {
  process.chdir(ORIG_CWD);
  await rm(root, { recursive: true, force: true });
});

let projectDir: string;
beforeEach(async () => {
  projectDir = join(root, `proj-${Math.random().toString(36).slice(2)}`);
  await mkdir(projectDir, { recursive: true });
  process.chdir(projectDir);
});

async function seedLegacyState(cwd: string, files: Record<string, string>): Promise<void> {
  for (const [relPath, body] of Object.entries(files)) {
    const full = join(cwd, ".claude", "claudeclaw", relPath);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, body, "utf8");
  }
}

describe("one-shot migrator", () => {
  test("noop when no legacy directory exists", async () => {
    const { migrateIfNeeded } = await import("../../src/migrate/legacy");
    const result = await migrateIfNeeded(projectDir);
    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/no legacy/i);
  });

  test("copies runtime files to .claude/hermes and archives source", async () => {
    await seedLegacyState(projectDir, {
      "settings.json": JSON.stringify({ model: "opus" }),
      "session.json": JSON.stringify({ sessionId: "abc", turnCount: 3 }),
      "sessions.json": JSON.stringify({ threads: {} }),
      "jobs/greet.md": '---\nschedule: "0 9 * * *"\n---\nGood morning',
      "logs/run-1.log": "ok",
      "prompts/HEARTBEAT.md": "custom heartbeat",
      "inbox/discord/image.png": "binary-ish",
      "daemon.pid": "12345",
    });

    const { migrateIfNeeded } = await import("../../src/migrate/legacy");
    const result = await migrateIfNeeded(projectDir);

    expect(result.status).toBe("migrated");
    expect(result.filesCopied).toBeGreaterThanOrEqual(8);
    expect(result.archivedAs).toBeTruthy();

    const hermesDir = join(projectDir, ".claude", "hermes");
    const migrated = await readFile(join(hermesDir, "settings.json"), "utf8");
    expect(migrated).toBe(JSON.stringify({ model: "opus" }));

    const marker = JSON.parse(await readFile(join(hermesDir, "MIGRATED.json"), "utf8"));
    expect(marker.version).toBe(1);
    expect(marker.filesCopied).toBeGreaterThanOrEqual(8);

    const remainingUnderClaude = await readdir(join(projectDir, ".claude"));
    const hasArchivedSource = remainingUnderClaude.some((name) => name.startsWith("claudeclaw.migrated-"));
    expect(hasArchivedSource).toBe(true);
    expect(remainingUnderClaude).not.toContain("claudeclaw");
  });

  test("is idempotent after a successful migration", async () => {
    await seedLegacyState(projectDir, { "settings.json": "{}" });
    const { migrateIfNeeded } = await import("../../src/migrate/legacy");
    const first = await migrateIfNeeded(projectDir);
    expect(first.status).toBe("migrated");

    const second = await migrateIfNeeded(projectDir);
    expect(second.status).toBe("skipped");
  });

  test("refuses to overwrite if both dirs exist without a MIGRATED marker", async () => {
    await seedLegacyState(projectDir, { "settings.json": "{}" });
    await mkdir(join(projectDir, ".claude", "hermes"), { recursive: true });
    await writeFile(join(projectDir, ".claude", "hermes", "foo"), "existing", "utf8");

    const { migrateIfNeeded } = await import("../../src/migrate/legacy");
    const result = await migrateIfNeeded(projectDir);
    expect(result.status).toBe("conflict");
  });

  test("rewrites CLAUDE.md managed-block markers from claudeclaw to hermes", async () => {
    const claudeMd = [
      "# Project",
      "",
      "Some doc content.",
      "",
      "<!-- claudeclaw:managed:start -->",
      "managed body",
      "<!-- claudeclaw:managed:end -->",
      "",
      "Trailing prose.",
    ].join("\n");
    await writeFile(join(projectDir, "CLAUDE.md"), claudeMd, "utf8");
    await seedLegacyState(projectDir, { "settings.json": "{}" });

    const { migrateIfNeeded } = await import("../../src/migrate/legacy");
    const result = await migrateIfNeeded(projectDir);

    expect(result.status).toBe("migrated");
    expect(result.claudeMdRewritten).toBe(true);

    const rewritten = await readFile(join(projectDir, "CLAUDE.md"), "utf8");
    expect(rewritten).toContain("<!-- hermes:managed:start -->");
    expect(rewritten).toContain("<!-- hermes:managed:end -->");
    expect(rewritten).not.toContain("<!-- claudeclaw:managed:start -->");
    expect(rewritten).not.toContain("<!-- claudeclaw:managed:end -->");
    expect(rewritten).toContain("Trailing prose.");
    expect(rewritten).toContain("managed body");
  });

  test("leaves CLAUDE.md alone when there is no managed block", async () => {
    await writeFile(join(projectDir, "CLAUDE.md"), "Just user content, no managed block.", "utf8");
    await seedLegacyState(projectDir, { "settings.json": "{}" });

    const { migrateIfNeeded } = await import("../../src/migrate/legacy");
    const result = await migrateIfNeeded(projectDir);

    expect(result.status).toBe("migrated");
    expect(result.claudeMdRewritten).toBe(false);
    const after = await readFile(join(projectDir, "CLAUDE.md"), "utf8");
    expect(after).toBe("Just user content, no managed block.");
  });
});
