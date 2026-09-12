# Agent runtime review — 2026-09-12

Reviewed the production Discord/Telegram bridges, session state, memory retrieval
and Claude Code subprocess boundary, starting at
`5fd372cc93c19e0bbff3a5cf52ca1b4388025b59`. Claude Code **2.1.269** was installed
in an isolated tooling directory and its `--version` and `--help` inspected.
Tests do not use model requests, real bot connections or account credentials.

## Open-source comparison

These are design references, not a popularity ranking or performance benchmark.
The implementation retains Hermes's existing Bun/SQLite/Claude CLI architecture.

| Reference | Relevant pattern | Finding and implementation |
| --- | --- | --- |
| [OpenClaw queue](https://docs.openclaw.ai/concepts/queue), [sessions](https://docs.openclaw.ai/concepts/session) | Conversation execution lanes and explicit recovery semantics | Live bridge DMs still used the workspace session; canonical targets now address execution and controls. Timeout no longer triggers task replay. |
| [NousResearch Hermes Agent](https://github.com/NousResearch/hermes-agent), [messaging](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/) | Persistent chat identities and explicit conversation lifecycle | Telegram topic IDs collided across groups. Keys now include chat ID; transport lifecycles are cancellable and Discord archival retains context. |
| [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence) | Thread-scoped persistence and deliberate recovery boundaries | Live session keys and persisted metadata were inconsistent. A shared session adapter and transactional message pairs now use the same identity. |
| [Deep Agents](https://github.com/langchain-ai/deepagents) | Separate conversation context, reusable memory and runtime facilities | Recall only included recent snippets and unrelated sessions. Query-driven FTS5 recall now uses provenance filters and a bounded digest. |

## Claude Code compatibility

Requires **Claude Code 2.1.257 or later** for `--system-prompt-snapshot off`.
Run `claude update` before upgrading Hermes. The audited current version is
2.1.269; model aliases still resolve through the installed CLI.

| Native facility | Integration |
| --- | --- |
| Sessions | Persist returned IDs and explicitly resume the addressed conversation |
| Partial streaming | `stream-json`, `--verbose`, `--include-partial-messages`; parse deltas, suppress duplicate completed text, retain tool progress |
| Result errors | JSON on new and resumed buffered turns; `is_error` and `error_*` results fail even when the child exits zero |
| System-prompt snapshot | Disable it so newly retrieved memory takes effect on resumed turns |
| Auto memory | Inline `--settings` selects an absolute, hashed directory per bridge conversation; `memoryScope: none` sets `autoMemoryEnabled: false` |
| Tool availability | `locked` uses `--tools Read,Grep,Glob`; `--allowedTools` remains an approval rule |
| Subagents | Recognize current `Agent` and legacy `Task`; nested text does not become the parent reply |
| Plugins, skills, hooks and MCP | Retain native discovery/configuration; no second agent loop is added |

Sources: [CLI reference](https://code.claude.com/docs/en/cli-reference),
[headless usage](https://code.claude.com/docs/en/headless),
[memory](https://code.claude.com/docs/en/memory),
[settings](https://code.claude.com/docs/en/settings),
[Agent SDK types](https://code.claude.com/docs/en/agent-sdk/typescript).
Native memory generation still depends on the CLI, model, permissions and
user/managed settings. Tests verify configuration and routing, not model behavior.

## Transport and lifecycle contracts

- Discord owns one socket generation and cancellable timers. Stop/token rotation
  retires stale callbacks. Missing HELLO/heartbeat ACK reconnects with backoff and
  jitter. Resume retains the sequence and versioned URL; invalid session codes
  identify afresh, fatal configuration codes stop. Duplicate sequences are ignored.
- Live Discord handlers enforce channel mode, session scope, memory scope and
  delivery role. Threads inherit parent policy; local overrides win. Authorized
  slash commands defer before channel lookup or queued work.
- Telegram requests have deadlines including response-body reads. Explicit 429s
  honor `retry_after`; safe reads retry transient failures with a bounded budget.
  Ambiguous send failures are surfaced. Plain-text fallback requires an explicit
  formatting rejection, preventing duplicate sends after network failures.
- Telegram polling continues during agent turns, advances offsets monotonically,
  and suppresses repeated updates within the process. Stop/token changes abort
  pending reads and retry waits.
- Reset and compact share the addressed execution lane. Reset retains long-term
  history. Archiving a Discord thread preserves context and reconnect skips it.
  Deletion waits for admitted runner work and removes attributed SQLite facts,
  preventing `ON DELETE SET NULL` from turning private facts into shared facts.
- Timed-out children exit before their lane is released. Tasks are not automatically
  compacted and replayed because their side effects may already have occurred.

Protocol references: [Discord Gateway](https://docs.discord.com/developers/events/gateway),
[interaction responses](https://docs.discord.com/developers/interactions/receiving-and-responding),
[Telegram Bot API](https://core.telegram.org/bots/api).

## Memory behavior and boundaries

Every bridge turn retrieves relevant older messages with FTS5/BM25 before recent
snippets. Query terms are quoted, results are bounded, and the default digest
budget is 6,000 characters. CJK substring fallback helps unicode61's unsegmented
tokens. This is lexical retrieval, not embedding-based semantic search.

Recall uses the exact key and workspace. Facts require matching session provenance,
except deliberately unattributed workspace facts. Unattributed personal facts are
excluded. A newer expired fact does not resurrect an older value. Historical
excerpts are labeled as data and include message IDs. Scoped chats omit shared
USER/MEMORY files and scratchpad blocks unless workspace sharing is selected.
`none` disables automatic memory injection, not transcript persistence.

This remains a trusted personal-assistant workspace. Prompt selection and native
memory directories are **not an OS sandbox**: project CLAUDE.md, hooks, MCP, skills
and accessible files remain shared configuration. This is not a multi-tenant
hosting isolation boundary.

## TDD and verification

Baseline full verify: **1,123 unit + 23 smoke + 60 integration tests**.
Final local verify: **1,152 unit + 23 smoke + 69 integration tests**, all green
on Linux with Bun 1.3.4 (38 additional tests). GitHub CI runs the four-way
Ubuntu/macOS and pinned/latest-Bun matrix; real-service acceptance remains separate.
Behavioral failures were reproduced before implementation for memory recall and
provenance, transport retry/cancellation, channel inheritance, stream/result parsing,
locked tool availability, timeout replay, archival, deleted fact provenance and
queued Discord reset acknowledgement. New modules also received contract tests
before their implementation. Actual bridge handlers are exercised through the
runner and a deterministic Claude subprocess fixture.

The initial macOS CI run also exposed concurrent migration through `/var` and
`/private/var` aliases of one workspace. A symlink regression test reproduced this
on Linux before the fix. Shared database initialization now resolves the physical
state directory before caching its promise, so aliases share one initialized handle.

Key tests: `runtime-digest.recall.test.ts`, `gateway.test.ts`, `polling.test.ts`,
`telegram-api.test.ts`, `telegram.delivery.test.ts`, `bridge-session.test.ts`,
`session-target.test.ts`, `stream.test.ts`, `claude-output.test.ts`,
`security-args.test.ts`, `shared-db.test.ts`, and
`tests/integration/scoped-bridge-runtime.test.ts`.
Run `bun run verify --json` for the authoritative five-stage result.
No dependency, schema migration, disabled test or relaxed gate is required.

## Remaining architectural work

A multi-user service additionally needs durable inbound/outbound ledgers, a global
execution budget, scoped retention/erasure of native transcripts and memory, and
process/filesystem isolation. In-memory queues and polling offsets do not guarantee
exactly-once delivery through a crash. Attachment preparation can affect admission
order before work reaches the runner queue.

Channel-policy `autoThread`, `allowedSkills` and `modelPolicy` still need complete
live handler enforcement beyond the routing/memory/delivery fields above. Native
background agents, Remote Control, same-turn steering and permission-mode changes
need separate lifecycle designs. Existing `/context` capacity estimates should
eventually use model-reported limits. This branch does not claim full feature
parity with every referenced framework.
