import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";

/**
 * Helpers for the Claude configuration directory layout that Claude Code
 * itself maintains (separate from anything hermes writes).
 *
 * Claude Code stores per-project conversation transcripts under
 * `<configDir>/projects/<slug>/<sessionId>.jsonl`, where `<configDir>` defaults
 * to `~/.claude` and `<slug>` is the
 * project's working directory with every path separator and the Windows
 * drive `:` replaced by `-`. Examples:
 *
 *   /Users/sun/projects/foo            -> -Users-sun-projects-foo
 *   C:\Users\sun\Downloads\hermes      -> C--Users-sun-Downloads-hermes
 *
 * The previous in-line implementation only replaced `/`, which produced a
 * verbatim Windows path on Windows hosts and never matched a real slug, so
 * `/context` always reported "Conversation file not found" there.
 */

export function projectSlugFromCwd(cwd: string = process.cwd()): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export type ClaudeConfigEnv = Readonly<Record<string, string | undefined>>;

/** Resolve at call time; an empty override keeps Claude's default home layout. */
export function claudeConfigDir(home: string, env: ClaudeConfigEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(home, ".claude");
}

// Explicit-home layout helpers are deterministic unless an environment is passed.
// Legacy memory migration uses these too and must not move another account's files
// merely because the surrounding process has CLAUDE_CONFIG_DIR set.
export function claudeProjectsDir(home: string, env: ClaudeConfigEnv = {}): string {
  return join(claudeConfigDir(home, env), "projects");
}

export function claudeProjectDir(
  home: string,
  cwd: string = process.cwd(),
  env: ClaudeConfigEnv = {}
): string {
  return join(claudeProjectsDir(home, env), projectSlugFromCwd(cwd));
}

export function claudeProjectMemoryDir(
  home: string,
  cwd: string = process.cwd(),
  env: ClaudeConfigEnv = {}
): string {
  return join(claudeProjectDir(home, cwd, env), "memory");
}

/** Exact session identity is required before searching other project slugs. */
export async function findSessionFile(
  home: string,
  cwd: string,
  sessionId: string,
  env: ClaudeConfigEnv = process.env
): Promise<string | null> {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null;
  const filename = `${sessionId}.jsonl`;
  const root = claudeProjectsDir(home, env);
  const direct = join(root, projectSlugFromCwd(cwd), filename);
  if ((await stat(direct).catch(() => null))?.isFile()) return direct;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return null;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const candidates = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        const path = join(root, e.name, filename);
        const info = await stat(path).catch(() => null);
        return info?.isFile() ? { path, modified: info.mtimeMs } : null;
      })
  );
  return candidates.filter((c) => c !== null).sort((a, b) => b.modified - a.modified)[0]?.path ?? null;
}
