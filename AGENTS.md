# AGENTS.md — orientation for autonomous AI agents

This file is for AI agents (Claude Code, autonomous evolve loops, third-party
SDK agents) working in this repo. Humans should read README.md instead.

## Quickstart

1. Read `CLAUDE.md` for project identity, persona, and behavioural rules.
2. Make your changes.
3. Run `bun run verify` — must exit 0 before you commit.
4. Commit with a meaningful message; push to a branch or master.
5. CI re-runs verify across (ubuntu, macos) × (bun 1.3.4, latest). All four
   legs must stay green.

## The verify pipeline

`bun run verify` is the single source of truth for "is this commit shippable".
It runs five steps in order, fails fast on the first red:

| step | command | what it catches |
|------|---------|-----------------|
| typecheck | `tsc --noEmit` | TS type errors |
| lint | `biome check src tests scripts` | style + safety lints |
| unit | `bun test src` | per-module behaviour |
| smoke | `bun test tests/smoke` | end-to-end CLI / daemon boot / install contract |
| integration | `bun test tests/integration` | router → runner with fake-claude |

**Machine-readable output:** `bun run verify --json` emits a JSON envelope
with per-step exitCode + stdoutTail/stderrTail. Parse this, don't scrape
the human log.

**Faster inner loop:** `bun run verify:fast` runs only typecheck + unit
(~8 s). Use this between edits; run full verify before every push.

## Test conventions

- Unit tests live next to their source: `foo.ts` → `foo.test.ts`.
- Smoke tests spawn real subprocesses — they go in `tests/smoke/`.
- Integration tests cross multiple modules (router + runner + state) — they
  go in `tests/integration/`.
- Tests are isolated via `mkdtemp` + cleanup, never against shared state.
- The Claude CLI is mocked via `tests/fixtures/fake-claude.ts`; set
  `HERMES_CLAUDE_BIN="bun run /abs/path/to/fake-claude.ts"` in your env.
- Skip the background plugin installer with `HERMES_SKIP_PREFLIGHT=1`.

## Hard rules — do not cross these

1. **Never commit a red verify.** The pre-commit hook runs `verify:fast`; the
   evolve loop reverts commits that fail full verify on master.
2. **Never `--no-verify` past the hook.** If the hook fails, fix the cause;
   don't bypass it.
3. **Never delete `LEGACY_*` constants in `src/paths.ts`.** Old users coming
   from `claudeclaw` rely on the migration path. Tests in
   `src/paths.test.ts` pin this; if you have to change them, talk to a human.
4. **Never write code that calls `os.homedir()` and expects `$HOME` to
   override it.** Bun on Linux ignores `$HOME` in some setups. Functions
   that need a configurable home must accept an explicit `roots.home` arg
   (see `discoverSkills`, `listSkills` for the pattern).
5. **Never serialise concurrent writes to a shared file via
   read-modify-write.** Use the in-process mutex pattern from
   `src/evolve/journal.ts:journalLocks`.

## Where things live

- `src/index.ts` — CLI dispatcher (start / status / send / --stop / --clear)
- `src/commands/` — one file per CLI subcommand
- `src/runner.ts` — the per-thread queue + Claude CLI wrapper
- `src/state/` — SQLite schema + migrations + repos
- `src/skills/` — discovery + registry + (in `learning/`) auto-promotion
- `src/evolve/` — the self-evolution loop
- `src/migrate/legacy.ts` — one-shot migrator from `.claude/claudeclaw/`
- `tests/fixtures/fake-claude.ts` — drop-in replacement for the real CLI
- `scripts/verify.ts` — the harness; emits structured JSON
- `commands/*.md` — Claude Code slash command definitions for end users

## Self-evolution loop

The 8-hour cron in `.github/workflows/evolve.yml` runs `scripts/evolve.ts`
which:
1. Reads pending tasks from `.claude/hermes/inbox/evolve/*.md` + GitHub issues
   tagged `hermes-input`
2. Asks Claude to pick one and propose a small change
3. Applies the change in a tmp worktree
4. Runs full verify
5. On green: commits + pushes. On red: reverts and journals the failure.

If you're an evolve agent, treat this as your contract: small, verify-gated,
revertible. Do not bundle multiple changes; one commit, one verify.

## When you get stuck

- `bun run verify --json | jq .results[]` shows you which step failed and
  the last 20 lines of stdout/stderr.
- `bun test path/to/specific.test.ts` runs one file in isolation.
- `cat .claude/hermes/memory/journal/*.md` shows what past evolve runs
  attempted and why they reverted.
- Read the SKILL.md files in `~/.claude/skills/` for reusable agent-side
  skills the project expects.

## Changing this file

This file is part of the agent contract. Treat changes here like API breaks:
update both the file and the smoke test that pins its existence
(`tests/smoke/plugin-contract.test.ts`).
