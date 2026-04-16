/**
 * Single seam for invoking the Claude Code CLI.
 *
 * Every spawn of `claude` must go through this module so tests (and future
 * sandboxing) can redirect invocations without monkey-patching. Resolution
 * order:
 *
 *   1. Explicit opts.override (unit-test injection)
 *   2. HERMES_CLAUDE_BIN env var (smoke/integration tests, local overrides)
 *   3. literal "claude" (production default; relies on $PATH)
 *
 * The resolved value is always an array of argv tokens. That lets a caller
 * point at a Bun script like `bun run tests/fixtures/fake-claude.ts` without
 * any custom shell logic at the call site.
 */

export interface ResolveClaudeBinOpts {
  override?: string;
  env?: NodeJS.ProcessEnv;
}

const WS_SPLIT = /\s+/;

export function resolveClaudeBin(opts: ResolveClaudeBinOpts = {}): string[] {
  const env = opts.env ?? process.env;
  const candidate = opts.override ?? env.HERMES_CLAUDE_BIN ?? "";
  const trimmed = candidate.trim();
  if (!trimmed) return ["claude"];
  const tokens = trimmed.split(WS_SPLIT).filter(Boolean);
  return tokens.length > 0 ? tokens : ["claude"];
}

/**
 * Return the first argv slot plus any prefix args required by the resolved
 * bin. Callers that used to push `"claude"` as args[0] should spread the
 * return value of this function instead.
 */
export function claudeArgv(opts: ResolveClaudeBinOpts = {}): string[] {
  return resolveClaudeBin(opts);
}
