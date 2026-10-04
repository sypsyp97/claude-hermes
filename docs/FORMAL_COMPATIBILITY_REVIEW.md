# Runtime verification and Claude Code compatibility — 2026-10-04

## Reproducible baseline

- Repository baseline: `e0fbf5a77c29ac4008b899df6d8b9293a3f722ee`
- Claude Code public release and installed native Linux binary: **2.1.289**
- Linux Bun baseline: **1.3.4**; current npm Bun: **1.4.2**
- Dependencies installed from the unchanged lockfile with lifecycle scripts disabled
- No model requests, bot connections, user credentials, plugin installation, or production state were used

The existing `bun run verify` command is a typecheck/lint/test pipeline, not a
formal proof. The original checkout had no formal specification/checker. Its
baseline yielded 1,190 passing unit tests and one failure, plus 36 passing smoke
and 120 passing integration tests. The failure was an empty ancestor `.git`
placeholder being mistaken for a repository.

## Confirmed fixes

1. **Cancelled destination transfer.** A bridge reservation can pass its initial
   cancellation check, suspend waiting for thread creation, and then receive a
   successful response after shutdown. Recheck the captured lifecycle signal
   after that wait before starting destination work. The failing implementation
   trace is also a negative control in the new formal suite.
2. **Current stream block ordering.** Claude emits singleton assistant envelopes
   per non-empty content block, with a shared message ID, before the corresponding
   block-stop event. Track the API block index instead of treating the singleton
   array offset as that index. Preserve already streamed prefixes and emit only
   a missing suffix. Tests cover thinking/tool predecessors and later text blocks.
3. **Incomplete success.** An exit-zero stream without a result is an unknown
   execution outcome, not a successful turn. Preserve cancellation/timeout exit
   codes and drain through actual process exit. Empty successful text and legacy
   JSON-array / `{session_id,result}` adapters remain supported. No automatic
   replay is introduced.
4. **Documented operator environment.** Preserve a narrow allowlist of provider,
   authentication-mode, resource, privacy, MCP environment-filtering, and current
   compatibility controls. Parent session/IPC fields, unknown namespace members,
   auto-memory overrides and automatic interrupted-turn replay remain excluded.
   This is an explicit allowlist, not support for every Claude environment option.
5. **Custom configuration root.** Honor `CLAUDE_CONFIG_DIR` at runtime for
   transcript lookup, plugin cache/registry/marketplace paths, and global/plugin
   skill discovery and command resolution. Explicit-home
   helpers used by migration remain deterministic unless an environment is
   supplied, preventing accidental migration of another configuration root.
   Project `.claude/settings.json` remains project-local.
6. **Git preflight.** Use bounded, no-shell `git rev-parse --is-inside-work-tree`
   rather than `.git` existence. Tests use real repositories and cover malformed
   metadata, parent discovery, valid gitfiles, bare repositories and missing Git.

The core defects were reproduced before fixes. Existing permission defaults and
the documented Claude minimum version are unchanged.

## Final executed checks

Both **Bun 1.3.4 and Bun 1.4.2 on Linux** pass the complete five-stage pipeline:
typecheck, lint, **1,218 unit + 36 smoke + 120 integration tests** (1,374 tests per
runtime, zero failures). The two verification-harness tests also pass separately.

`bun run verify:formal` passes four checker self-tests, 12 model instances covering
**230,590 states / 1,246,335 transitions**, six expected faulty-mutant detections,
and five real-source replay tests (18 assertions). The transfer-abort regression
is additionally part of the unit suite.

Independent review reran the formal suite and source-drift fence, exercised
**5,760 parser combinations** and seven subprocess terminal/exit cases, and
passed 114 focused tests. No open blocker was found in the reviewed runtime
changes. This does not remove the separate plugin-name installation blocker below.

## Bounded formal verification

Run `bun run verify:formal` (Python 3.10+ and Bun). The command performs exhaustive
finite-state exploration, requires source-correspondence review hashes, checks
faulty negative controls, and replays selected witnesses against real runtime
modules. CI runs this separately on its Ubuntu/Bun-1.3.4 leg.

See [formal/README.md](../formal/README.md) for exact state bounds, transition
relations, invariants, progress assumptions, code correspondence and limits.
The check is source-corresponding abstract model checking, not a proof of the
entire TypeScript program or OS/network behavior. The source hash fence detects
stale review; it does not prove refinement. Runtime replay tests bridge selected
traces only.

## Latest CLI manifest blocker

The real Claude Code 2.1.289 native binary was run with an empty, dedicated config
root and environment for `--version`, `--help`, and `plugin validate` only.
Both the pristine baseline and the edited checkout fail plugin validation:
third-party plugin identifiers beginning `claude-` are reserved. The existing
`claude-hermes` identifier is therefore rejected in both manifests.

Renaming the public plugin identity changes installation identifiers and command
namespaces and requires an explicit migration decision. Until that change is
made and the validator rerun, do not claim full 2.1.289 installation compatibility.
The validator also warns that root `CLAUDE.md` is not automatically loaded as
plugin context; Hermes's deliberate workspace seeding is a separate mechanism.

## Sources and scope

- [Claude Code 2.1.289 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.289)
- [Official npm package](https://www.npmjs.com/package/@anthropic-ai/claude-code/v/2.1.289)
- [Stream message flow](https://code.claude.com/docs/en/agent-sdk/streaming-output#message-flow)
- [Result lifecycle](https://code.claude.com/docs/en/agent-sdk/agent-loop#handle-the-result)
- [Environment variables](https://code.claude.com/docs/en/env-vars#variables)
- [Headless cancellation](https://code.claude.com/docs/en/headless#stop-a-run-with-sigterm)

This comparison uses official public contracts, release metadata, public SDK code
and the publicly distributed native CLI. The complete proprietary Claude Code
implementation is not available in its public GitHub repository.

No live inference, provider authentication, bot-service acceptance, macOS runs or
remote CI runs are claimed. The dependency vulnerability audit was not run due
to a required approval for sending dependency metadata to the npm audit service.
Optional permission-mode redesign, duplicate prompt removal, mandatory-Node
cleanup, and `CLAUDE_CODE_PROJECT_DIR_NAME` support remain separate work.
