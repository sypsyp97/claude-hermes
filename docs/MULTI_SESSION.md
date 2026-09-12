# Conversation sessions

Production Discord and Telegram handlers resolve a `SessionTarget` shared by
execution, reset, compact, status, context lookup and proactive memory recall.
SQLite `state.db` is authoritative; legacy JSON files are migration inputs.

## Default routing

| Conversation | Canonical key | Sharing |
| --- | --- | --- |
| Discord DM | `user:discord:<user>` | User's DMs |
| Discord server channel | `channel-user:discord:<guild>:<channel>:<user>` | User in channel |
| Discord thread | `thread:discord:<thread>` | Thread participants |
| Explicit Discord shared policy | `shared:discord:<guild>:<channel>` | Channel participants |
| Telegram private chat | `user:telegram:<user>` | Private chat |
| Telegram group | `channel-user:telegram::<chat>:<user>` | User in group |
| Telegram forum topic | `thread:telegram:<chat>:<topic>` | Topic participants |
| CLI/heartbeat without target | `workspace:<workspace-hash>` | Trusted workspace |

Threads inherit parent channel policy; thread-specific overrides take precedence.
Existing Discord thread keys remain valid. Old workspace history is not assigned
to new bridge users. Ambiguous legacy bare Telegram topic IDs are not guessed
into a group. The new bridge conversations start fresh on upgrade.

## Execution and controls

Runner work is serialized by canonical conversation key; idle queue entries are
removed. Different lanes can run concurrently. An omitted target retains the
legacy workspace API; a string retains the source-qualified thread API.

- `/reset` waits behind admitted work and clears this conversation's Claude ID
  and counters. Messages, facts and native auto memory remain searchable. Reset
  is not data erasure.
- `/compact` resumes the addressed session on the same execution lane.
- `/status` and `/context` inspect the addressed conversation.
- Discord archival retains context for unarchival. Rejoin skips archived threads.
  Deletion removes the SQLite session, messages and attributed facts after admitted
  work. Native Claude transcript/memory files have a separate lifecycle.
- Timeout terminates the child before releasing its lane, without replaying the task.

## Memory

Scoped SQLite recall selects the exact key and workspace, plus explicitly shared
workspace facts. Relevant older messages precede recent snippets in the digest.
Native Claude auto memory uses
`.claude/hermes/claude-memory/<sha256-of-conversation-key>/`.
`memoryScope: none` disables automatic injection and native memory creation;
successful transcripts still persist. Project files and native CLI configuration
remain shared under the workspace's trust policy.

See [the reliability review](AGENT_RELIABILITY_REVIEW.md) for Claude version
requirements, TDD coverage and remaining durability/isolation limitations.

## Implementation

| Module | Responsibility |
| --- | --- |
| `src/router/bridge-session.ts` | Transport identity to canonical target |
| `src/runtime/session-target.ts` | Scoped state and native memory arguments |
| `src/runner.ts` | Execution/control queues, child lifetime, persistence |
| `src/memory/runtime-digest.ts` | Bounded recall and provenance filtering |
| `src/adapters/discord/channel-policy.ts` | Defaults, inheritance and overrides |
| `src/adapters/discord/gateway.ts` | Reconnect, resume, heartbeat and cancellation |
| `src/adapters/telegram/polling.ts` | Poll admission, offsets and cancellation |
