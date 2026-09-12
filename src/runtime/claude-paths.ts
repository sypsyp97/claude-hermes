import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";

/**
 * Helpers for the `~/.claude/` project directory layout that Claude Code
 * itself maintains (separate from anything hermes writes).
 *
 * Claude Code stores per-project conversation transcripts under
 * `~/.claude/projects/<slug>/<sessionId>.jsonl`, where `<slug>` is the
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

export function claudeProjectsDir(home: string): string {
  return join(home, ".claude", "projects");
}

export function claudeProjectDir(home: string, cwd: string = process.cwd()): string {
  return join(claudeProjectsDir(home), projectSlugFromCwd(cwd));
}

export function claudeProjectMemoryDir(home: string, cwd: string = process.cwd()): string {
  return join(claudeProjectDir(home, cwd), "memory");
}

/** Exact session identity is required before searching other project slugs. */
export async function findSessionFile(home: string, cwd: string, sessionId: string): Promise<string | null> {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null;
  const filename = `${sessionId}.jsonl`;
  const direct = join(claudeProjectDir(home, cwd), filename);
  if ((await stat(direct).catch(() => null))?.isFile()) return direct;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return null;
  const root = claudeProjectsDir(home);
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
