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

The recorded complete run checked **12 model instances, 230,590 states and
1,246,335 transitions**, with no invariant violation or nonterminal deadlock.
`results.json` contains per-instance counts, coverage, elapsed time, and negative
control traces. The real-source replay suite passed **5 tests / 18 assertions**
using Bun 1.3.4. Four checker-diagnostic self-tests also pass: deadlock witness
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

Every instance covers all possible orders of its enabled actions. In the budget
model, caller IDs are assigned in request order: callers are otherwise identical,
so this removes permutations of names without removing relative cancellation,
admission, continuation, or completion schedules. For lanes, all eight key patterns
beginning with key 0 are checked, including the all-one-key case. Together these
represent every length-four assignment to at most two keys up to renaming.

These bounds are not an inductive proof for arbitrarily many calls or keys.
Models are verified independently; their concurrent composition is not verified.

## Source correspondence

Reference revision: `e0fbf5a77c29ac4008b899df6d8b9293a3f722ee`, plus the
local transfer-abort correction described below and in the manifest. The final
hash check passed against the working tree containing that correction.
The correspondence is manually reviewed, not mechanically derived or proved.
`source-manifest.json` hashes the modeled modules and the runner's enqueue
function. The hash fence detects **review staleness only**, not correctness or
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
`src/runtime/claude-stream.ts` resolves its wrapper after finalization. These were
reviewed to motivate the callback-settlement abstraction; their OS process,
pipe, parser, and status-sink state machines are **not** modeled or hash-fenced.
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

## Assumptions and exclusions

1. JavaScript runs each synchronous segment to completion. Promise callbacks and
   abort events cannot interleave inside those segments. Asynchronous boundaries
   are modeled with arbitrary order where dependencies permit it; real microtask
   ordering may rule out some modeled schedules.
2. Native Promise resolution is one-shot. Abort signals are monotonic. The model
   does not prove Bun/Node implementations of Promises, EventTarget,
   AsyncLocalStorage, or AbortSignal.any.
3. Work can finish successfully or fail; either releases its owned resources through
   the reviewed `finally`/settlement path. No infinite callback, process that never
   exits, indefinitely blocked sink, or permanently stalled event loop is represented.
4. Eventual progress assumes the scheduler runs enabled work and the external
   creation request eventually resolves or rejects so callers execute `complete`
   or `cancel`. A transfer left unresolved forever can block its lane in real code.
   The bounded model does not establish deadlines or wall-clock responsiveness.
5. Canonical workspace/source/channel/session keys have stable, correct identities.
   No authorization, key collision, workspace changes, persistence race, routing
   metadata, network retry, OS signal delivery, or crash recovery is proved.
6. Only finite single-shot task populations are modeled. There are no dynamically
   arriving unbounded tasks, nested slot acquisition, or recursive self-enqueueing
   callbacks; those can introduce deadlocks beyond the checked scope.
7. Source replays are regression tests and support the manual correspondence.
   They do not turn the abstract state checks into a whole-program proof.

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

All six controls were detected at the expected invariant. They test both the
checker and sensitivity of these particular invariants; they are not a proof that
there are no bugs in this custom checker or in its abstraction.
