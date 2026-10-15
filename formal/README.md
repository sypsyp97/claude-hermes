# Runtime protocol model checking

This directory contains an **independent, exhaustive explicit-state model checker**
for the concurrency protocols in claude-hermes. It is not TLA+/TLC, a TypeScript
verifier, or a proof of the whole application. It checks finite, source-corresponding
transition systems and replays selected boundary traces against the real code.

## Run locally

No dependencies, credentials, network, or Claude calls are needed for the checker.
It requires Python 3.10 or later. The source replays additionally require Bun and
this repository's normal dependencies.

```sh
bun run verify:formal
# Or run each layer separately:
python3 -B -m unittest discover -s formal -p 'test_*.py'
python3 formal/check.py --full --check-source --negative-controls
python3 formal/check.py --full --check-source --negative-controls --json
bun test formal/replay.test.ts
```

`--full` is an explicit alias for the default: **every run is exhaustive**. There
is no random sampling, depth cutoff, state limit, or partial-search success mode.
`--json` emits the report to stdout; redirect it to reproduce `results.json`.
The process exits nonzero for a violated invariant, nonterminal deadlock, missing
coverage condition, undetected/wrongly detected requested mutation, or source
drift when `--check-source` is set.

The checker performs breadth-first search with structural state equality. Every
reachable state and transition is checked, including edges into previously seen
states. State/edge failures include a shortest discovered action trace for that failure.
Global missing-coverage obligations are labeled `diagnostic_scope: global` and
report missing conditions without inventing a trace. A strictly increasing
integer rank is checked on every edge, and every sink must be a designated terminal
state. This proves termination of **nonstuttering executions of these finite
models**, conditional on the environment actions described below. It does not
prove that a subprocess, network call, or arbitrary callback eventually returns.

## Checked bounds and results

The recorded complete run checked **20 model instances, 403,350 states and
1,769,207 transitions**, with no invariant violation or nonterminal deadlock.
`results.json` contains per-instance counts, coverage, elapsed time, and negative
control traces. The real-source replay suite passed **10 tests / 47 assertions**
using Windows Bun 1.3.14. It preserves the original six replays, adds three direct
SQLite/guard traces, and wraps the existing ownership/generation integration
suites in an isolated Bun process. That wrapper is **reused coverage**, not a new
formal proof of those suites. Four checker-diagnostic self-tests also pass: deadlock witness
accuracy, edge-local failures to already-seen states, initial-state failures, and
global missing-coverage reporting. Counts exclude mutation searches, which stop
at their first failure.

| Model | Bounds | States | Transitions |
|---|---|---:|---:|
| Execution budget | 4 calls, 2 slots | 2,000 | 7,008 |
| Execution budget | 6 calls, actual 4 slots | 193,984 | 1,132,224 |
| Bridge/runner lane family | 4 calls, all 8 assignments up to 2 keys, modulo key renaming | 32,160 | 98,064 |
| Destination transfer | 1 transfer, 2 destinations, 1 later control each, lifecycle abort | 2,316 | 8,750 |
| Conversation cancellation | 3 turns across 2 keys, 1 shared parent signal | 130 | 289 |
| Durable generations | first turn, reset, explicit generation | 20 | 21 |
| Durable generations | first turn, forget/recreate, explicit generation | 45 | 51 |
| Durable generations | existing source, reset, explicit generation | 33 | 45 |
| Durable generations | existing source, forget/recreate, explicit generation | 68 | 95 |
| Durable generations | existing source, reset, writer captures generation | 60 | 83 |
| Durable leases | 2 processes, same key | 8,626 | 21,544 |
| Durable leases | 2 processes, independent keys | 3,737 | 12,047 |
| Durable leases | preowned lease + 2 recovery contenders, same key | 160,171 | 488,986 |

Every instance covers all possible orders of its enabled actions. In the budget
model, caller IDs are assigned in request order: callers are otherwise identical,
so this removes permutations of names without removing relative cancellation,
admission, continuation, or completion schedules. For lanes, all eight key patterns
beginning with key 0 are checked, including the all-one-key case. Together these
represent every length-four assignment to at most two keys up to renaming.

These bounds are not an inductive proof for arbitrarily many calls or keys.
Models are verified independently; their concurrent composition is not verified.

## Source correspondence

Reference revision: `d66adfdc4195343bc45f4104648ffa3dddb7d97b` (merged PR #4),
including the transfer-abort correction described below. The October 6 review
retains the original runtime hashes and adds the unchanged memory file-lock
protocol to the source correspondence fence.
The session-generation and cross-process lease extension was manually reviewed
against the working-tree fixes on base
`4aa3ffb09a8178515c589059292c68f1c9142573`. Its additional source fences cover
the modules and runner slices mapped below; original source digests are retained.
The correspondence is manually reviewed, not mechanically derived or proved.
`source-manifest.json` hashes the reviewed modules and selected runner/reset
slices. The hash fence detects **review staleness only**, not correctness or
refinement. The runner slice deliberately excludes unrelated environment policy
and execution/output changes. If a relevant hash changes, review the abstraction
again and only then update the recorded digest. Passing unchanged hashes cannot
establish that the abstraction is complete.

### Budget: `src/runtime/execution-budget.ts`

- `request`: the initial abort check and synchronous Promise executor, including
  either `enter()` or `waiting.push(enter)`
- `abort` while queued: synchronous abort listener, removal by identity, rejection
- `A` (admitted): `active++` occurred, but the continuation after `await` has not run
- `start-work` / `resume-aborted`: the second abort check, deliberately separated
  from admission so an intervening abort is explored
- `work-settles`: the callback returns or throws; success and failure have identical
  slot behavior and are collapsed into one transition
- `finally-release`: decrement followed by synchronous FIFO admission of the next
  waiter; the handoff is one atomic JavaScript segment

Invariants: capacity, exact slot accounting, unique/exact ordered waiters,
immediate removal of cancelled waiters, no work start after an already observed
abort, and no idle slot while waiters exist. Aborting a running callback does not
release its slot in the model. It must settle first.

`src/runtime/process.ts` waits for `proc.exited` after interruption, and
`src/runtime/claude-stream.ts` resolves its wrapper after finalization. These
motivate the callback-settlement abstraction. Their guarded launch boundaries
are now mapped and hash-fenced for the lease model; OS process termination,
pipes, parsing, and status sinks remain **outside** the transition systems.
The budget proof alone cannot prove that live processes always equal slot holders.

### Lanes: `src/runtime/bridge-queue.ts:enqueueBridge`, `src/runner.ts:enqueue`

`enqueue` snapshots the current tail synchronously; `continuation` requires the
predecessor to have settled. Settled work and its later cleanup are separate
states. Cleanup only deletes a map entry when it still owns the current tail.
Promise rejection is treated like fulfillment for enabling the successor, matching
`.catch(...).then(...)` / `.then(fn, fn)`.

Invariants: same-key mutual exclusion and FIFO order, no loss of a live tail,
and key isolation. Coverage requires an older settled task awaiting cleanup after
a newer tail is installed, rejection/cancellation followed by settlement, and
simultaneous work on different keys (for the two-key instances).

The abort-and-skip transition specifically corresponds to the bridge's abort
check. For the runner, this is also an abstraction of a callback rejecting before
useful work; the runner's queue itself has no such abort check. The cancellation
behavior of arbitrary runner callback bodies is not inferred from this model.

### Memory writers: `src/memory/file-lock.ts`

The existing Lanes model also covers this lock as a **non-cancellable subset**:
`pending[key]` is the tail, the prior tail is captured synchronously before
`pending.set`, and `predecessor.catch().then(work)` waits for settlement even
when the prior writer rejects. `result.catch()` supplies the stored tail and
identity-guarded `finally` removes only its own tail. Extra catch microtasks
are stuttering steps; they do not permit overlapping work for one key.

The new source replay rejects an earlier writer while a newer tail exists,
queues another writer, and checks FIFO plus independent-key progress. Agent
memory mutation callers provide canonical physical workspace-root keys, ordering
rename/delete with child edits. `file-lock` alone normalizes lexical paths; it
does not prove aliases are equivalent. The checked bounds are unchanged.

This mapping assumes finite enqueues, callback settlement and Promise progress,
with no recursively awaited same-key acquisition. It proves no cross-process
exclusion, symlink-race defense, read consistency, filesystem atomicity or crash
durability. Those are outside this transition system. Stable symlink rejection,
exclusive create and atomic edit replacement have separate regression tests.

### Transfers: `src/runtime/bridge-queue.ts:prepareBridgeTransfer`

`reserve` creates one reservation per channel; duplicate calls return the same
promise and have no state change. `complete` reserves before resolving `ready`.
`cancel` resolves `ready` to null. The first Promise resolution is immutable.
A selected reservation rechecks the captured lifecycle signal before executing
one callback; unselected reservations settle without calling it. Aborting before
reservation admission also rejects without running its callback. Later controls
(submitted under an independently live lifecycle) wait for the reservation to
settle, whether it resolves or rejects.

Invariants: first resolution wins, at most one destination runs, only the confirmed
destination runs, cancellation before completion runs nothing, and a later
same-destination control cannot pass the first turn. A ghost flag records whether
work ever started with its captured lifecycle signal already aborted; that flag
must stay false even when abort occurs during the await on `ready`. The finite environment tries
both destination completions and cancellation in all orders, including repeated
completion attempts for distinct destinations. A cancel **after** completion does
not undo the first resolution or stop already running work.

Precedence is guaranteed only for controls submitted **after reservation**. The
model intentionally does not promise that a late reservation jumps ahead of work
already queued. Reservation deduplication and Promise single-resolution semantics
are assumed as specified by JavaScript. `cancel()` of the transfer and aborting
its bridge signal are modeled as different operations. Abort does not interrupt
already-running arbitrary work, and does not itself resolve `ready`. The model
allows a reservation waiting on an unresolved `ready` to remain waiting until a
caller invokes `complete` or `cancel`.

### Actual defect found and corrected

The first transfer abstraction omitted bridge lifecycle signals; it established
selection and ordering only. A source audit and real Bun trace exposed the missing
boundary: reserve a destination, let its callback suspend on `await ready`, abort
the captured lifecycle, then complete creation. In the reference source,
`enqueueBridge` had checked the signal before the wait, but destination work began
after the abort without another check. The callback was observed running with
`bridgeSignal().aborted === true`.

The local correction calls `signal?.throwIfAborted()` after `ready` resolves and
before selected destination work. The model now includes lifecycle abort and the
`NoTransferStartAfterLifecycleAbort` invariant. Restoring the old behavior as the
`omit-transfer-abort-recheck` mutation fails with this four-action witness:

```text
complete(0)
reservation-enters(0)
abort-transfer-lifecycle
selected-work-starts(0)
```

(The equally valid real-source regression first reserves/enters, aborts, then
completes.) `src/runtime/bridge-queue.test.ts` contains the regression: completion
rejects, destination work does not run, and the lane remains usable. The initial
model's missing signal dimension was an abstraction limitation, not evidence of
source correctness; it was expanded before the final reported result.

### Conversation controls: `src/runtime/conversation-controls.ts`, `bridge-context.ts`

A runner-admitted turn registers one controller under its key; its effective signal
is the OR of parent lifecycle abort and its own controller's abort. Cancellation
addresses the active controller for the requested key. Completion unregisters it.
A second turn for the same key starts only after the first completes.

Invariants: one exact registration per active key, no cancellation of queued turns,
and an edge-local check that targeted cancellation changes neither the parent
signal nor another turn's controller. Coverage includes simultaneous conversations,
isolated local cancellation, and parent cancellation reaching both active turns.
The per-key runner serialization requirement is an explicit precondition.

### Durable generations: `session_models.py:Generations`

`src/state/migrations/006_session_runtime.sql` stores runtime generation and lease
ownership independently of the optional `sessions` row. Five finite instances
cover a first turn with no source row, an existing source, reset versus
forget/recreate, explicit runner generations, and the writer's own capture when
no generation option is supplied. Each instance has one turn, one extractor,
one control, and at most one recreation. Source IDs are two distinct identities;
they are not reused after deletion.

The manually reviewed transition mapping is:

- `capture-turn-generation`: `runner.ts:execClaude` reads `leaseGeneration()`
  under `withOwnedConversation` / `withSessionLease` before awaiting session use.
- `persist-turn-immediate`: `runner.ts:persistTurn` checks generation and writes
  the session context, both messages and turn metadata in **one SQLite immediate
  transaction**. The model collapses those inseparable successful writes into
  one durable-history effect. A mismatch writes none of them, even when the
  first turn has never created a session row.
- `reset-immediate`: `state/repos/sessions.ts:resetByKey` increments generation
  and clears Claude context/counters in one immediate transaction. It retains
  source ID, attributed facts, and transcript. Public workspace/scoped reset and
  CLI clear adapters were reviewed to reach this boundary. Backup-file creation
  before reset is not modeled.
- `forget-immediate` / `recreate-source-immediate`: the scoped forget transaction
  deletes attributed facts and the session, invalidates its independent runtime
  generation, then a later `replaceSession` invalidates again and creates a new
  source ID. Native-file deletion preceding forget is an environment precondition.
- `capture-source-before-extractor-immediate`: `memory/nudge.ts` resolves the
  requested source ID/key and its generation before extraction. Missing sources
  reject immediately. Runner callers retain their explicit earlier generation;
  standalone callers without one use this captured source generation.
- `extractor-resolves` and `commit-attributed-fact-immediate` are separate. The
  latter transaction rechecks source ID and generation before writing facts.
  Reset or deletion may interleave with the await. A stale attributed operation
  cannot become an unattributed append to shared memory.

Invariants: `GenerationFencesTurnPersistence`, `GenerationFencesFacts`,
`StableMemorySourceAttribution`, and `ResetPreservesDurableHistory`. Required
coverage includes current successful writes, stale turn/fact rejection, first-turn
invalidation without a session row, preserved reset identity/history, deleted
sources without fallback, and rejection after a source is recreated. Old facts
that committed **before** reset intentionally remain durable; the generation
check governs new commits, not a blanket deletion of historical data.

### Durable leases: `session_models.py:Leases`

The lease graph has two one-shot contenders, or an initially owned lease A plus
contenders B/C. All processes share one physical workspace/database; instances
use the same key or two independent keys. `paths.ts:canonicalWorkspace`,
`state/shared-db.ts` physical database-path identity, and `state/db.ts` busy timeout
were reviewed as preconditions. Path aliases map to one modeled physical DB.
The graph does not prove filesystem identity, case/symlink stability, migration
concurrency, or SQLite itself. The integration wrapper includes real alias and
independent-process regression traces.

Acquisition is deliberately **not** one atomic acquire/run operation:

1. `acquire-free-immediate` or `read-occupied-immediate` corresponds to the initial
   SQLite immediate transaction. A busy read captures token, owner PID and child
   PID; it does not hold the writer lock across a probe.
2. `native-probe-live/dead/unknown` occurs later and records an observation of that
   captured ownership. Unknown outcomes reject the acquisition episode. A live
   observation ends this bounded attempt as waiting; real source waits and loops.
3. `recover-dead-owner-cas-immediate` rechecks **all three captured ownership
   fields** using `sameLease`. A stale death snapshot cannot erase a successor.
   Coverage requires A's death, B's dead snapshot, C acquiring and launching its
   own registered child, then B's CAS rejection. Recovery reads the current
   generation after CAS; generation is not part of `sameLease`'s compare predicate.
4. `spawn-guard-no-permission` creates only the guarded helper selected by
   `process-tree.ts:taskProcessArgs`. It cannot do useful work yet.
5. `register-child-cas-immediate` maps `registerLeaseProcess`'s generation/token/
   owner/child checks and immediate CAS. The graph has one child launch per owner,
   so registration's optional probe for a **previous** child group is excluded.
6. `send-permission` maps the abort/deadline check then stdin permission in
   `process.ts` / `claude-stream.ts`. `lease-child.ts` must receive exactly
   `run\n` before launching useful work. Owner death before permission closes its
   pipe; a guarded unregistered child may overlap recovery but never useful work.

`owner-crash` permanently ends that process's code. It never resumes a crashed
callback. The child group can remain alive, or its leader can exit while
descendants remain live. Such a recorded group fences recovery until its last
live member exits. Normal work may also settle after the leader exits while a
background descendant retains the fence. Finalization has separate native-probe
and token/owner/child-guarded cleanup transitions; live or unknown results retain
the token/child and retire the owner PID. Failed native probes never establish
death. The actual SQL uses owner PID `0` for retirement; the model uses sentinel
`-2`, which likewise never names a live process.

Clear changes generation and leaves active token/owner/child fields intact. A
clear **before registration** rejects the old generation's registration. A clear
**after successful registration** may still let the parent send permission and
old-generation useful work run: source has no generation recheck at that boundary.
Its lease remains held; the separate generation model checks rejection of its
stale session/message/fact writes. This is a compositional argument with explicit
shared-generation assumptions, not an exhaustively checked graph of both models
running concurrently.

Invariants: `CrossProcessMutualExclusion` for useful live child groups,
`LiveChildRetainsFence`, `RecoveryRequiresConfirmedDead`,
`SnapshotCASPreventsSteal`, `PermissionRequiresDurableRegistration`,
`GenerationFencesRegistration`, `AbortedWaiterNeverStartsChild`,
`ClearPreservesLease`, and `UnknownFinalProbeRetainsFence`. Required coverage
exercises each launch/crash boundary, abort before child creation, live owner and
orphan rejection, unknown acquisition/finalization probes, stale CAS after a
successor child starts, background descendants under a retired owner, concurrent
useful work for independent keys, and clear between registration and permission.

The graph also admits an explicitly labelled **adversarial retired-token cleanup
command** after supersession. `StaleCleanupPreservesSuccessor` checks the SQL
token/owner/child guards against that stale input. It is a defensive command
property; its reachability does **not** assert that a crashed owner can execute a
later callback. Source additionally rejects inactive AsyncLocalStorage lease
contexts in `activeLease()`; arbitrary detached callback lifetimes are not modeled.

Each contender makes one acquisition attempt. Live, unknown, stale or aborted
attempts may finish without admission. There is no state cutoff, retry heuristic,
or partial-search PASS. Strict rank checks cover this finite episode, including
crash/child/probe/cleanup transitions. They do not prove eventual admission of a
real retrying waiter, fair scheduling, or eventual OS process settlement.

The three new direct real-source traces verify (a) reset before a first session
exists retains the active lease and rejects stale guarded registration, (b) reset
between registration and permission still permits work while preserving the
lease/generation separation, and (c) an explicit stale turn generation is rejected
even when extraction starts **after** reset, while current writes retain their
original source ID. A missing requested source does not call extraction or touch
shared notes. All run against temporary SQLite databases and local Bun children;
they call no real Claude service and send no messages.

## Assumptions and exclusions

1. JavaScript runs each synchronous segment to completion. Promise callbacks and
   abort events cannot interleave inside those segments. Asynchronous boundaries
   are modeled with arbitrary order where dependencies permit it; real microtask
   ordering may rule out some modeled schedules.
2. Native Promise resolution is one-shot. Abort signals are monotonic. The model
   does not prove Bun/Node implementations of Promises, EventTarget,
   AsyncLocalStorage, or AbortSignal.any.
3. Non-crashed work can finish successfully or fail through the reviewed
   `finally`/settlement path. The lease graph additionally permits owner crashes
   with surviving child fences. No infinite callback, process that never exits,
   indefinitely blocked sink, or permanently stalled event loop is represented.
4. Eventual progress assumes the scheduler runs enabled work and the external
   creation request eventually resolves or rejects so callers execute `complete`
   or `cancel`. A transfer left unresolved forever can block its lane in real code.
   The bounded model does not establish deadlines or wall-clock responsiveness.
5. Canonical workspace/source/channel/session keys have stable, correct identities.
   Bounded lease recovery and generation persistence races are covered only as
   mapped above. Authorization, key collisions, workspace identity changes,
   routing metadata, network retries and OS signal delivery are excluded.
6. Only finite single-shot task populations are modeled. There are no dynamically
   arriving unbounded tasks, nested slot acquisition, or recursive self-enqueueing
   callbacks; those can introduce deadlocks beyond the checked scope.
7. Source replays are regression tests and support the manual correspondence.
   They do not turn the abstract state checks into a whole-program proof.
8. Lease PIDs/groups have stable, nonreused identities. A successful native probe
   is assumed to classify owner/group liveness soundly; unknown results fail
   closed. The model does not prove POSIX `ps`/zombie classification, Windows CIM
   ancestry closure, PID reuse behavior, or process reparenting. In particular,
   current Windows parent rows may omit an already vanished intermediate ancestor
   of a live descendant; the abstraction does not establish detection in that case.
9. SQLite committed visibility and writer serialization are assumed. WAL/fsync,
   power loss, disk corruption, unique-token randomness and database permissions
   are not proved. Native-memory filesystem mutation and arbitrary callback/
   extractor content remain outside these protocol graphs.

## Negative controls

`--negative-controls` deliberately changes the model transition relation and
requires every listed safety failure to be detected. A detected mutant is recorded
as `FAIL` inside its result with `detected_as_expected: true`; that is a successful
negative control, not a production failure.

| Mutation | Required violated invariant | Short witness |
|---|---|---|
| Allow admission at capacity | CapacityBound | admit 0, admit 1, admit 2 with capacity 2 |
| Leave an aborted waiter queued | AbortedWaiterRemoved | fill slots, queue 2, abort 2 |
| Omit the post-admission abort check | NoStartAfterObservedAbort | admit 0, abort 0, start 0 |
| Remove the tail identity cleanup guard | NoLostLiveTail | enqueue 0/1, abort 0, settle 0, cleanup 0 |
| Allow `ready` to resolve twice | PromiseFirstResolutionWins | complete destination 0, complete destination 1 |
| Omit the transfer abort recheck | NoTransferStartAfterLifecycleAbort | complete 0, enter reservation 0, abort lifecycle, start work 0 |
| Omit turn generation check | GenerationFencesTurnPersistence | capture, reset, persist stale turn |
| Omit fact generation check | GenerationFencesFacts | capture source, reset, extract, commit stale fact |
| Fall back when attributed source is missing | StableMemorySourceAttribution | forget, extract without source, shared append |
| Erase history during reset | ResetPreservesDurableHistory | reset an existing source |
| Recover a live owner | RecoveryRequiresConfirmedDead | acquire owner, observe live, steal |
| Recover after unknown native probe | RecoveryRequiresConfirmedDead | acquire owner, unknown probe, recover |
| Start useful work without acquiring occupied lease | CrossProcessMutualExclusion | owner work, contender bypasses lease |
| Drop child fence on owner crash | LiveChildRetainsFence | registered useful child, owner crashes |
| Omit snapshot CAS comparison | SnapshotCASPreventsSteal | dead snapshot, successor acquire, stale recovery |
| Send permission before registration | PermissionRequiresDurableRegistration | acquire, guard spawn, premature permission |
| Omit registration generation check | GenerationFencesRegistration | acquire, clear, register stale generation |
| Omit waiter/launch abort checks | AbortedWaiterNeverStartsChild | abort, acquire, guard spawn |
| Release active lease during clear | ClearPreservesLease | acquire, clear |
| Treat unknown final probe as dead | UnknownFinalProbeRetainsFence | recorded child, unknown final probe |
| Execute unguarded retired-token cleanup | StaleCleanupPreservesSuccessor | retire owner, successor acquire, stale cleanup |

All **21 controls** were detected at the expected invariant. The 15 new controls
provide semantic RED evidence for the generation/lease requirements; syntax,
type or missing-fixture failures do not count as RED. They test both the
checker and sensitivity of these particular invariants; they are not a proof that
there are no bugs in this custom checker or in its abstraction.
