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
  return cwd.replace(/[\\/:]/g, "-");
}
