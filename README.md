# Claude Hermes

> **Fork of [moazbuilds/claudeclaw](https://github.com/moazbuilds/claudeclaw).** Rebuilt around a SQLite state engine, an envelope-based router, an auto-promoting skills pipeline, and a human-triggered, verify-gated self-evolution loop. The Telegram and Discord bridges are the only interfaces — no web dashboard.

> 🇨🇳 [中文 README](README.zh.md)

Claude Hermes turns your Claude Code into a personal assistant that never sleeps. It runs as a background daemon, executes tasks on a schedule, responds on Telegram and Discord, transcribes voice commands, and learns new skills from your usage.

## Why Hermes (vs. the Claw fork it grew out of)

| | Hermes | Claw |
| --- | --- | --- |
| Storage | `bun:sqlite` + FTS5, single `state.db` | flat JSON files |
| Sessions | scope-based router (`dm`, `per-channel-user`, `per-thread`, `shared`, `workspace`) | global + per-thread overrides |
| Skills | candidate → active with a rollback window (`shadow` on regression) | manual install only |
| Self-evolution | human-triggered, verify-gated: auto-commits on green, reverts on red | none |
| Model routing | agentic routing plus persisted per-conversation overrides | bridge-specific model selection |
| Web dashboard | removed — talk to the daemon via Telegram/Discord/CLI | yes |
| Verify pipeline | typecheck + lint + unit + smoke + integration, all five must be green | manual |

## Install

Easiest path — install from the Claude Code plugin marketplace. Inside any Claude Code session, run:

```
/plugin marketplace add sypsyp97/claude-hermes
/plugin install claude-hermes@claude-hermes
/claude-hermes:start
```

The setup wizard walks you through model, heartbeat, Telegram, Discord, and security; the daemon then runs in the background. Use Bun and Claude Code **2.1.257+** (`claude update` before upgrading). `start` offers to install Bun if missing. See the [Claude compatibility and reliability review](docs/AGENT_RELIABILITY_REVIEW.md).

If you previously ran the upstream Claw daemon in this workspace, the first `start` migrates `.claude/claudeclaw/` → `.claude/hermes/` once and then leaves the legacy directory untouched as a safety net.

### Develop from source

```bash
git clone https://github.com/sypsyp97/claude-hermes.git
cd claude-hermes
bun install
bun run verify
```

Then point Claude Code at the working tree:

```
/plugin marketplace add /absolute/path/to/claude-hermes
/plugin install claude-hermes@claude-hermes
```

## Features

### Automation
- **Heartbeat:** periodic check-ins with configurable intervals, quiet hours, and editable prompts. The heartbeat prompt can be an inline string or a file path; edits take effect without restarting the daemon.
- **Cron jobs:** timezone-aware schedules for repeating or one-time tasks. Job files hot-reload every 30s — no daemon restart needed.
- **Scaffolder (`/claude-hermes:new`):** `new job <name>`, `new skill <name>`, or `new prompt <name>` writes a template file with sensible frontmatter so you don't hand-craft YAML. Runs as a CLI too: `bun run src/index.ts new job my-job --schedule "0 9 * * *"`.
- **Self-evolution (`bun run scripts/evolve.ts`):** opt-in local tool that takes a task body (CLI arg or stdin or Discord/Telegram message), asks your local Claude to implement it, runs the full verify pipeline, and commits on green / `git restore`s on red. Small-step, verify-gated, journal-everything discipline. Human-triggered, not a cron — the verify gate is the safety net.

### Job notification targets
Job frontmatter accepts `notifyChannel: "DISCORD_CHANNEL_ID"`, `notifyTelegramChat: "TELEGRAM_CHAT_ID"` and optional `notifyTelegramTopic: 42`. You can specify both platforms. Explicit targets receive the result instead of the default recipient list; a missing transport or failed target never falls back to other recipients. Without these fields, the existing default forwarding remains. `notify: false` disables job progress and result notifications; `notify: error` sends only failed results. A topic requires a chat ID, and malformed targets reject the job during loading.

### Communication
- **Telegram:** text, images, voice, generic documents (including JSON/source files and files without a MIME type), quoted replies and forwarded context. Referenced images/documents/audio are available as files. Voice transcription uses whisper.cpp or an OpenAI-compatible STT endpoint.
- **Discord:** DMs, server mentions/replies, slash commands, voice messages, multiple images, generic files, reply/forward context and reaction feedback. A missing same-channel reply snapshot is fetched before checking whether it replies to the bot. System messages do not invoke Claude.
- **Time-aware messages:** prefixes help the agent reason about delays and daily patterns.
- **Live answer preview:** Telegram and Discord show a bounded draft in the progress message, then replace it with a completion summary and deliver the full final answer separately. `/verbose on` adds detailed tool progress; `/verbose off` keeps the compact preview. Settings persist per conversation.

### Attachments
Both bridges download files up to 20 MiB each. Discord handles up to ten files per message, prioritizing current attachments before referenced files and preserving filenames and origin labels. Download failures and omitted files are reported in the model context. Telegram albums remain separate ordered message updates. Archives are delivered as files; Hermes does not automatically extract them.

Generated files are sent with `[send-file:/absolute/path]`. Claude receives the current conversation's outbox path in its system prompt: `.claude/hermes/outbox/<session-hash>/`. Each output must be a regular file inside that directory and at most 10 MiB; escaping symlinks and aliased outbox roots are rejected. Discord supports this for ordinary messages and skill slash commands. Existing Telegram skills that send files from arbitrary paths must copy outputs into the supplied outbox first. Platform limits may also reject an upload; ambiguous failures are surfaced without resending.

### Discord channel policies
The daemon auto-routes channels by name:
- **`listen-*` / `ask-*`** — free-response mode; the bot replies without needing an @mention.
- **`deliver-*`** — delivery-only, no interactive replies (use for broadcasts).
- **Server channels** — default: per-channel-user memory, reply on mention/reply only.
- **DMs** — default: per-user memory, reply to every message.
- **Manual override:** per-channel `channel_policies` rows in SQLite win over the name-based default. Add `allowedUserIds: ["DISCORD_USER_ID"]` to a Discord guild-channel policy to authorize extra users only there. Threads inherit the parent policy unless explicitly overridden. Messages and slash commands share this check; a channel grant never authorizes a DM or another channel. An empty global list and no channel grant reject everyone. Creating/deleting threads through management messages requires a globally authorized user.

### Conversation sessions (Discord and Telegram)
- **Independent thread sessions:** each Discord thread gets its own Claude CLI session.
- **Parallel processing:** messages in different threads don't block each other.
- **Auto-create:** the first message in a new thread bootstraps a fresh session.
- **Lifecycle:** archive retains context; deletion clears the thread's SQLite session and attributed facts.
- **Isolation:** DMs use per-user sessions, server/group messages use per-channel-user sessions, and Telegram topics include their chat ID.
- **Controls:** `/reset`, `/forget`, `/compact`, `/status` and `/context` address the current conversation. Reset retains memory; forget erases its Hermes history/facts and native auto-memory directory. Context capacity uses model-reported limits when available. Transcript lookup checks the active workspace first, then searches for the exact session UUID after a workspace move.
- **Cancel:** `/cancel` (aliases `/kill`, `/stop`) immediately signals the active Claude task in this conversation, including a task waiting for a process slot. Other conversations and queued future messages remain intact. Attachment preparation and completed side effects are not undone.
- **Model:** `/model sonnet`, `/model opus`, `/model haiku` or `/model <model-id>` persists a conversation override in SQLite; `/model` displays it, and `/model default` restores channel/global routing. Reset retains this setting.
- **Channel policy:** both bridges enforce session/memory scope, delivery role, model selection, allowed skills and automatic threads (Telegram requires a forum group). Explicit shared scope remains shared when a thread is created.

See [docs/MULTI_SESSION.md](docs/MULTI_SESSION.md) for the routing details.

### Reliability and control
- **Connection recovery:** Discord heartbeat/resume recovery uses cancellable generations; Telegram uses abortable polling and bounded request retries that honor `retry_after`.
- **Uncertain outcomes:** network send failures and timed-out tasks are surfaced without automatic replay.
- **Telegram restart:** SQLite receipts and polling offsets survive process restarts. Unconfirmed requests produce a recovery notice; check any partial effects before resending. This does not guarantee exactly-once delivery.
- **Execution:** input order is reserved before attachment/metadata work. Buffered Claude, streaming Claude and local speech transcription share a four-process budget; bridge stop cancels requests, children and queued admissions.
- **Agentic model routing:** classify each turn as `planning` (→ Opus) or `implementation` (→ Sonnet) by keyword/phrase. Modes are fully configurable in `settings.json`; disable to pin a single model.
- **Model fallback:** Claude's native `--fallback-model` handles compatible models within the same provider credentials. Hermes does not replay an entire task across providers after an ambiguous failure.
- **Security levels:** four tool-access tiers, all headless (no permission prompts):
  - `locked` → `Read`, `Grep`, `Glob` only; MCP tools denied.
  - `strict` → everything except `Bash`, `WebSearch`, `WebFetch`.
  - `moderate` → all tools, with the project as the working directory.
  - `unrestricted` → all tools, without additional directory hints.
  These CLI tool rules and directory hints are not an OS filesystem sandbox.
- **Skill auto-promotion:** after ≥20 runs in a 7-day window with ≥85% success rate, a candidate skill is promoted to `active`. If success drops below 70% in the rollback window after promotion, it demotes back to `shadow`. Thresholds live in `src/learning/config.ts` and are tunable.
- **Evolve safety guards:** the self-edit subagent's system prompt is always prefixed with hard rules — no `git stash`, no branch switching, no `--no-verify`, no force push, no writes outside the cwd. The guards live in `prompts/EVOLVE_GUARDS.md` with a conservative inline fallback so they can never go silent.
- **Crash-safe daemon registry:** `~/.claude/hermes/daemons.json` uses atomic tmp-write + rename, so a SIGKILL mid-write can't wipe the registry.
- **Parent-daemon protection:** `/stop`, `/stop-all`, and `/clear` invoked from inside a daemon's own Claude child never kill the daemon that's running them.
- **Rate-limit retries:** Discord reaction PUTs go through a shared `discordApi` helper that honors `Retry-After` on 429s instead of silently dropping.

## Memory

Three layers, stable to volatile:

- **Identity** — `prompts/{SOUL,IDENTITY,USER}.md` + project `CLAUDE.md` + per-workspace overrides in `.claude/hermes/memory/`. Byte-identical across turns so the CLI's prompt cache stays warm.
- **Episodic** — `state.db` logs every successful turn to a `messages` table; FTS5 for search, a small importance heuristic + recency/relevance score for ranking.
- **Proactive recall** — every turn searches relevant older messages with FTS5 before adding recent context. Bridge recall uses the current conversation and attributed facts, with a bounded digest and CJK fallback.
- **Explicit memory** — successful turns persist explicit facts such as “remember that …”, “my editor is …” and “记住：…”, with conversation provenance. Independent notes remain independent; updated facts replace prior values in recall. No extra model request is used for extraction.
- **Native Claude memory** — each bridge conversation has its own auto-memory directory. Refreshed system prompts make new recall effective on resume. `memoryScope: none` disables automatic memory injection, while transcript persistence remains enabled.
- **Primitives** — four opt-in or human-gated pieces, all wired into the runtime:
  - Labeled memory blocks in `.claude/hermes/memory/blocks/` land in the system prompt as `<block:NAME>…</block>`.
  - A scratchpad at `.claude/hermes/memory/agent/` with the six-op protocol (`view / create / strReplace / insert / del / rename`).
  - A nightly `Dream` pass digests old messages and dedupes `MEMORY.md`. Gated by `settings.memory.dreamCron`.
  - Learned skills live under `.claude/hermes/skills/<name>/`. Candidate capture is on by default and records the real tool trace from each successful turn unless `settings.learning.captureCandidateSkills` is explicitly set to `false`; only when *you* mark one `active` does it get mirrored into `.claude/skills/hermes_<name>/` where the spawned agent can see it.

## Verify pipeline

`bun run verify` runs five stages and any failure is fatal:

```
typecheck → lint → unit → smoke → integration
```

The self-evolution loop only commits a change if all five are green; otherwise it `git restore`s and starts a fresh journal entry. Use `bun run verify --fast` for the inner loop (typecheck + unit).

## Development

```bash
bun run typecheck   # tsc --noEmit
bun run lint        # biome check src tests scripts
bun run fmt         # biome format --write
bun test src        # unit tests
bun test tests/smoke
bun test tests/integration
```

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgements

Started as a fork of [moazbuilds/claudeclaw](https://github.com/moazbuilds/claudeclaw); the shared-name files that remain (Telegram + Discord bridges, voice transcription, cron/heartbeat scaffolding) have since been rewritten from scratch against the test suite.

The v1.1.0 bridge improvements adapt selected upstream features and open proposals to Hermes session isolation; see [release notes and upstream references](docs/releases/v1.1.0.md). Skill installation now searches the structured skills.sh API with a timeout and explicit error handling.

The self-evolve cadence (small step, verify-gated, journal-everything) is lifted from [yologdev/yoyo-evolve](https://github.com/yologdev/yoyo-evolve).

The memory layer borrows ideas from several open-source agent-memory projects:
- **Labeled blocks** with per-slot budgets — [Letta](https://github.com/letta-ai/letta) (formerly MemGPT).
- **Six-op agent scratchpad protocol** (`view / create / strReplace / insert / del / rename`) — Anthropic's [`memory_20250818`](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) tool shape.
- **Dream-style offline consolidation** (digest, dedupe, invalidate) — [Honcho](https://github.com/plastic-labs/honcho).
- **`(SKILL.md + description + trajectory)` skill library with FTS retrieval** — [Voyager](https://github.com/MineDojo/Voyager)'s skill library pattern.
- **Importance · recency · relevance scoring** — the Stanford Generative Agents paper ([Park et al., 2023](https://arxiv.org/abs/2304.03442)).
- **Episodic + semantic split, with FTS5 as the retrieval backbone** — echoes [Zep](https://github.com/getzep/zep) and [mem0](https://github.com/mem0ai/mem0), minus the graph / vector store.

## Releasing

Maintainers run `bun run release <version>` from an up-to-date `main`.
The command synchronizes all three version manifests, writes release notes,
verifies, commits and pushes main. GitHub Actions reuses the four-way verification
matrix, checks the manifest versions, then creates the version tag and publishes
the release using `GITHUB_TOKEN`. No personal token or local `gh` login is needed.
Rerunning preserves an existing release; an unpublished tag pointing to a different
commit is rejected. Use `--no-push` to prepare locally, or `--notes-file=<path>`
for custom release notes. The Actions page also supports a manual rerun on main.
