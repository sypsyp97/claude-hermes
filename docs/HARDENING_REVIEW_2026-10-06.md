# Repository hardening review — 2026-10-06

## Scope and baseline

This pass starts from `d66adfdc4195343bc45f4104648ffa3dddb7d97b`, the merge of
PR #4. It does not re-submit that PR's runtime compatibility fixes. A fresh
Linux checkout of that baseline passed typecheck, lint, 1,218 unit, 36 smoke
and 120 integration tests under Bun 1.3.4.

The review covered subprocess/result handling, status backpressure, configuration
and authorization boundaries, outgoing transports, agent memory and learned
skills, SQLite startup, plugin preflight, scheduled work, and evolve Git safety.
Changes target reproduced defects and bounded optimizations; this is not a claim
that every code path or external integration is correct.

## Reproduced defects and corrections

- **Buffered result handling:** exit-zero incomplete JSON output no longer creates
  a successful turn. Buffered first turns accept NDJSON consistently, legacy error
  results fail, explicit empty successful replies remain valid, and interrupted
  compaction always closes an opened status sink.
- **Slow status transports:** maintain at most one active flush and one pending
  latest update. Final flush waits for in-flight work; failure and disposal do
  not leave an edit backlog. A deterministic slow-Discord regression reduces five
  redundant preview edits to two (first and latest), without dropping final output.
- **Configuration boundaries:** tokenize complete JSON values before preserving
  large Discord IDs. Nested lookalikes, duplicate/escaped keys, malformed ID
  fragments and precision loss no longer silently change the allowlist or channel
  targets. Telegram IDs are validated as positive safe integers. Prompt reads
  reject stable symlink escapes while permitting ordinary dot-prefixed filenames.
- **CLI delivery:** reuse the platform transports for complete Unicode-safe
  chunking, mention suppression, and API-result validation. Invalid recipient/
  platform combinations fail before inference or transmission.
- **Agent memory:** reject stable symlink ancestors, serialize root-scoped mutations
  using canonical workspace identity, create exclusively, replace complete edited
  files atomically, and treat replacement text literally. Rename/delete participate
  in the same in-process lane as edits.
- **Database startup:** close handles on failed initialization, evict rejected
  shared-cache attempts so a repaired database can reopen, and recheck migration
  versions inside an immediate transaction rather than trusting a stale snapshot.
- **Learned skills:** validate filesystem path segments at read/write entrypoints.
  Explicitly disabled skills remain disabled across both promotion mechanisms and
  asynchronous verification races.
- **Installer preflight:** preserve malformed/unreadable existing settings rather
  than replacing them with defaults. Validate manifest-controlled names, source/
  skill paths and copy trees before replacing existing installations; honor a
  plugin's declared source directory. These guards are not a package sandbox.
- **Scheduled jobs:** per-daemon, per-name single-flight admission coalesces ticks
  while a run and its cleanup are pending. Failed jobs may retry; different jobs
  remain independent. Successful one-shots leave the in-memory list immediately,
  and an older concurrent reload cannot restore their stale schedule.
- **Cron:** reject ignored trailing range/step separators and non-finite steps;
  advance absolute UTC minutes across host DST transitions. Precompute field
  membership for long scans while retaining the low-overhead ordinary tick path.
- **Evolve subprocesses:** a timed-out child cannot become successful by exiting
  zero in its signal handler. Decode split UTF-8 correctly, filter inherited Claude
  parent-session state, honor streaming kill-escalation settings, and stop waiting
  on descendant-inherited pipes once an interrupted direct child has exited.
- **Evolve Git operations:** preserve exact NUL-delimited filenames, enumerate
  untracked files individually, use literal pathspecs, and commit only selected
  paths so unrelated staged work is not included. Rollback classifies against
  HEAD, including staged additions/deletions/renames, and surfaces Git failures.
  Evolve now refuses a dirty worktree before journaling or executing: users must
  commit or save their existing changes first. This deliberate precondition avoids
  restoring user WIP to HEAD without a complete snapshot. Generated journal files
  are ignored. A clean tree at admission is not protection against an external
  editor/Git process modifying the tree during the iteration.

Defect-specific regression failures were observed against the affected baseline
implementations before the associated fixes. Existing behavior and boundary
tests then ran against the fixes. Temporary repositories, databases, synthetic filesystem trees and fake
Claude/HTTP endpoints provide deterministic isolation.

## Performance evidence

A five-run Linux/Bun-1.3.4 microbenchmark of the bounded impossible-date search
(`0 0 30 2 *` from January 1, 2026) measured median wall times of approximately
88 ms before and 60 ms after field-membership compilation (about 32% lower).
This small local measurement is environment-dependent, not an end-to-end daemon
throughput guarantee. Scan equivalence is separately checked against individual
minute evaluation across multiple schedules and offsets.

Reproduce the measurement with:

```sh
bun -e 'import { nextCronMatch } from "./src/cron.ts"; for(let i=0;i<5;i++){let t=performance.now();nextCronMatch("0 0 30 2 *",new Date("2026-01-01Z")); console.log(performance.now()-t)}'
```

The status optimization is covered by controlled deferred-transport tests rather
than external rate-limit benchmarks. It bounds redundant pending edits; it cannot
make an indefinitely blocked transport finish.

## Formal correspondence

The original 12 exhaustive finite models and six faulty-model negative controls
remain required. The original modeled runtime source hashes are unchanged. The same lane model
now also has a reviewed correspondence to the non-cancellable memory-writer lock,
with a source hash fence and an additional real-source failure/FIFO replay.

See [formal/README.md](../formal/README.md) for exact bounds and assumptions.
These are source-corresponding abstract models, not a whole-program or unbounded
proof. The new memory mapping does not prove filesystem security or durability.

## Claude Code compatibility

The official npm package and native Linux binary at **2.1.291** were inspected in
an isolated temporary configuration with no account credentials. Only version and
plugin validation commands were executed. The validator still rejects the
`claude-hermes` reserved prefix in both manifests, and warns that root `CLAUDE.md`
is not automatically loaded as plugin context.

[Current official documentation](https://code.claude.com/docs/en/plugins-reference#name)
says the naming checks apply to `plugin validate`, `plugin init`, and `plugin tag`;
existing names still install and load. The October 4 review's description of this
as an installation blocker was too broad and is corrected. Neither pass performs
a live installation/loading acceptance test. Public plugin/marketplace/command
identities are unchanged; a namespace migration needs a separate decision.

## Verification and remaining limits

Final Linux checks pass on **Bun 1.3.4 and 1.4.2**: typecheck, lint,
**1,299 unit + 37 smoke + 119 integration tests** per runtime (1,455 total).
The two verification-harness tests and fresh fast verification also pass.
Formal verification passes four checker self-tests, **12 model instances /
230,590 states / 1,246,335 transitions**, all six expected faulty-mutant
controls, the source correspondence fence, and six source replays (22 assertions).

Independent reviews covered the modified runtime, configuration/delivery,
preflight ordering, memory/state/skills, evolve, cron and formal correspondence.
The complete integration suite uses distinct numeric Discord test IDs after
validation was tightened; identity/isolation assertions are preserved. Existing
evolve tests that tolerated discarded user WIP now assert refusal/preservation.
GitHub matrix results for the exact published commit are recorded in the PR.

Reproduction:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run verify --json
bun test scripts/verify.test.ts
bun run verify:formal
```

No live model requests, provider logins, bot connections, real user messages,
production state, release publication, merge or deployment are part of this pass.
The OS/network and third-party service contracts are not formally verified.

Memory locking is in-process; it does not exclude external writers or malicious
concurrent symlink swaps. Atomic rename provides whole-file replacement, not
power-loss durability. Skill segment validation is not an OS sandbox. Tests do
not establish all provider combinations or indefinite resource-bound behavior.
