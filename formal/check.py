#!/usr/bin/env python3
"""Exhaustive finite-state safety/progress checks for Hermes runtime protocols.

No subprocesses, network, third-party modules, live credentials, or Claude calls.
See README.md for the abstraction relation and the limits of these results.
"""
from __future__ import annotations

import argparse
from collections import deque
from dataclasses import dataclass, replace
import hashlib
import json
from itertools import product
from pathlib import Path
import sys
from time import perf_counter


def changed(values, index, value):
    return values[:index] + (value,) + values[index + 1:]


def require(condition, name):
    if not condition:
        raise Violation(name)


class Violation(Exception):
    pass


@dataclass(frozen=True, slots=True)
class BudgetState:
    # N=new, Q=waiting, A=admitted (continuation pending), R=work running,
    # E=work settled/child exited, D=wrapper settled.
    phase: tuple[str, ...]
    aborted: tuple[bool, ...]
    queue: tuple[int, ...] = ()
    active: int = 0
    started_aborted: bool = False


class Budget:
    def __init__(self, jobs, capacity, mutation=None):
        self.jobs, self.capacity, self.mutation = jobs, capacity, mutation
        self.name = f"budget-{jobs}-jobs-{capacity}-slots"
        self.initial = BudgetState(("N",) * jobs, (False,) * jobs)
        self.covered = set()

    def release(self, s, j):
        s = replace(s, phase=changed(s.phase, j, "D"), active=s.active - 1)
        if s.queue:
            head = s.queue[0]
            s = replace(s, phase=changed(s.phase, head, "A"),
                        queue=s.queue[1:], active=s.active + 1)
        return s

    def next(self, s):
        # Jobs are named by request order: symmetry reduction for identical
        # callers. All cancellation and continuation orders remain arbitrary.
        if "N" in s.phase:
            j = s.phase.index("N")
            if s.aborted[j]:
                out = replace(s, phase=changed(s.phase, j, "D"))
            elif s.active < self.capacity or (
                    self.mutation == "over-admit" and s.active == self.capacity):
                out = replace(s, phase=changed(s.phase, j, "A"), active=s.active + 1)
            else:
                out = replace(s, phase=changed(s.phase, j, "Q"), queue=s.queue + (j,))
            yield f"request({j})", out
        for j, phase in enumerate(s.phase):
            if not s.aborted[j] and phase != "D":
                out = replace(s, aborted=changed(s.aborted, j, True))
                if phase == "Q" and self.mutation != "keep-aborted-waiter":
                    out = replace(out, phase=changed(out.phase, j, "D"),
                                  queue=tuple(k for k in out.queue if k != j))
                yield f"abort({j})", out
            if phase == "A":
                if s.aborted[j] and self.mutation != "omit-abort-recheck":
                    yield f"resume-aborted({j})", self.release(s, j)
                else:
                    yield f"start-work({j})", replace(s, phase=changed(s.phase, j, "R"),
                        started_aborted=s.started_aborted or s.aborted[j])
            if phase == "R":
                yield f"work-settles({j})", replace(s, phase=changed(s.phase, j, "E"))
            if phase == "E":
                yield f"finally-release({j})", self.release(s, j)

    def check(self, s):
        require(0 <= s.active <= self.capacity, "CapacityBound")
        require(s.active == sum(p in "ARE" for p in s.phase), "SlotConservation")
        require(len(set(s.queue)) == len(s.queue), "UniqueWaiters")
        require(set(s.queue) == {j for j, p in enumerate(s.phase) if p == "Q"}, "QueueExactness")
        require(all(not s.aborted[j] for j in s.queue), "AbortedWaiterRemoved")
        require(tuple(sorted(s.queue)) == s.queue, "WaiterFIFO")
        require(not s.started_aborted, "NoStartAfterObservedAbort")
        require(not s.queue or s.active == self.capacity, "NoIdleSlotWithWaiters")
        if s.queue:
            self.covered.add("queued")
        if any(a and p == "A" for a, p in zip(s.aborted, s.phase)):
            self.covered.add("abort-between-admission-and-continuation")
        if any(a and p == "R" for a, p in zip(s.aborted, s.phase)):
            self.covered.add("abort-during-work")

    def rank(self, s):
        return sum({"N": 0, "Q": 1, "A": 2, "R": 3, "E": 4, "D": 5}[p] for p in s.phase) + sum(s.aborted)

    def terminal(self, s):
        return all(p == "D" for p in s.phase) and not s.queue and s.active == 0

    expected_coverage = {"queued", "abort-between-admission-and-continuation", "abort-during-work"}


@dataclass(frozen=True, slots=True)
class LaneState:
    # S=task settled, cleanup microtask pending; D=cleanup finished.
    phase: tuple[str, ...]
    predecessor: tuple[int, ...]
    tail: tuple[int, ...]
    aborted: tuple[bool, ...]


class Lanes:
    def __init__(self, keys=(0, 0, 0, 1), mutation=None):
        self.keys, self.mutation = keys, mutation
        self.name = "bridge-and-runner-lanes-" + "".join(map(str, keys))
        self.initial = LaneState(("N",) * len(keys), (-1,) * len(keys),
                                 (-1,) * (max(keys) + 1), (False,) * len(keys))
        self.covered = set()

    def next(self, s):
        if "N" in s.phase:
            j = s.phase.index("N")
            key = self.keys[j]
            yield f"enqueue({j},key={key})", replace(s,
                phase=changed(s.phase, j, "Q"),
                predecessor=changed(s.predecessor, j, s.tail[key]),
                tail=changed(s.tail, key, j))
        for j, p in enumerate(s.phase):
            if not s.aborted[j] and p not in "SD":
                yield f"abort({j})", replace(s, aborted=changed(s.aborted, j, True))
            if p == "Q" and (s.predecessor[j] == -1 or s.phase[s.predecessor[j]] in "SD"):
                # Rejected and fulfilled predecessor promises enable the same
                # continuation, corresponding to catch/then or then(fn, fn).
                yield f"continuation({j})", replace(s, phase=changed(s.phase, j, "S" if s.aborted[j] else "R"))
            if p == "R":
                yield f"settle-success-or-failure({j})", replace(s, phase=changed(s.phase, j, "S"))
            if p == "S":
                key = self.keys[j]
                tail = s.tail
                if tail[key] == j or self.mutation == "unguarded-cleanup":
                    tail = changed(tail, key, -1)
                yield f"cleanup({j})", replace(s, phase=changed(s.phase, j, "D"), tail=tail)

    def check(self, s):
        for key in range(len(s.tail)):
            running = [j for j, p in enumerate(s.phase) if p == "R" and self.keys[j] == key]
            require(len(running) <= 1, "PerKeyMutualExclusion")
            pending = [j for j, p in enumerate(s.phase) if p in "QR" and self.keys[j] == key]
            require(not pending or s.tail[key] >= max(pending), "NoLostLiveTail")
            for j in running:
                require(all(s.phase[k] in "SD" for k in range(j) if self.keys[k] == key), "SameKeyFIFO")
            if s.tail[key] != -1:
                require(self.keys[s.tail[key]] == key, "TailKeyIsolation")
        if sum(p == "R" for p in s.phase) > 1:
            self.covered.add("different-keys-concurrent")
        if any(p == "S" and s.tail[self.keys[j]] > j for j, p in enumerate(s.phase)):
            self.covered.add("old-cleanup-after-new-tail")
        if any(a and p == "S" for a, p in zip(s.aborted, s.phase)):
            self.covered.add("aborted-predecessor-settled")

    def rank(self, s):
        return sum({"N": 0, "Q": 1, "R": 2, "S": 3, "D": 4}[p] for p in s.phase) + sum(s.aborted)

    def terminal(self, s):
        return all(p == "D" for p in s.phase) and all(t == -1 for t in s.tail)

    expected_coverage = {"different-keys-concurrent", "old-cleanup-after-new-tail", "aborted-predecessor-settled"}


@dataclass(frozen=True, slots=True)
class TransferState:
    # resolution -2=pending, -1=cancelled, 0/1=selected channel
    resolution: int = -2
    initial_resolution: int = -2
    reserve: tuple[str, ...] = ("N", "N")  # N/Q/W/R/D
    control: tuple[str, ...] = ("N", "N")  # N/Q/R/D
    completed: tuple[bool, ...] = (False, False)
    cancelled: bool = False
    ran: tuple[bool, ...] = (False, False)
    lifecycle_aborted: bool = False
    started_aborted: bool = False


class Transfers:
    name = "destination-transfer"
    initial = TransferState()
    expected_coverage = {"cancel-before-complete", "selected-work", "unselected-released", "duplicate-complete", "lifecycle-abort-while-awaiting-destination"}

    def __init__(self, mutation=None):
        self.mutation = mutation
        self.covered = set()

    def resolve(self, s, destination):
        if s.resolution == -2:
            return replace(s, resolution=destination, initial_resolution=destination)
        if self.mutation == "resolve-twice":
            return replace(s, resolution=destination)
        return s

    def next(self, s):
        for j, p in enumerate(s.reserve):
            if p == "N":
                yield f"reserve({j})", replace(s, reserve=changed(s.reserve, j, "Q"))
            if not s.completed[j]:
                out = replace(s, completed=changed(s.completed, j, True))
                if p == "N":
                    out = replace(out, reserve=changed(out.reserve, j, "Q"))
                yield f"complete({j})", self.resolve(out, j)
            if p == "Q":
                yield f"reservation-enters({j})", replace(s, reserve=changed(s.reserve, j, "D" if s.lifecycle_aborted else "W"))
            if p == "W" and s.resolution != -2:
                if s.resolution == j:
                    if s.lifecycle_aborted and self.mutation != "omit-transfer-abort-recheck":
                        yield f"selected-work-rejects-abort({j})", replace(s, reserve=changed(s.reserve, j, "D"))
                    else:
                        yield f"selected-work-starts({j})", replace(s,
                            reserve=changed(s.reserve, j, "R"), ran=changed(s.ran, j, True),
                            started_aborted=s.started_aborted or s.lifecycle_aborted)
                else:
                    yield f"unselected-reservation-ends({j})", replace(s, reserve=changed(s.reserve, j, "D"))
            if p == "R":
                yield f"selected-work-settles({j})", replace(s, reserve=changed(s.reserve, j, "D"))
            # The protocol promises precedence only for controls submitted
            # after destination reservation, not already queued controls.
            c = s.control[j]
            if c == "N" and p != "N":
                yield f"enqueue-later-control({j})", replace(s, control=changed(s.control, j, "Q"))
            if c == "Q" and p == "D":
                yield f"control-starts({j})", replace(s, control=changed(s.control, j, "R"))
            if c == "R":
                yield f"control-settles({j})", replace(s, control=changed(s.control, j, "D"))
        if not s.cancelled:
            yield "cancel-transfer", self.resolve(replace(s, cancelled=True), -1)
        if not s.lifecycle_aborted:
            yield "abort-transfer-lifecycle", replace(s, lifecycle_aborted=True)

    def check(self, s):
        require(not s.started_aborted, "NoTransferStartAfterLifecycleAbort")
        require(s.resolution == s.initial_resolution, "PromiseFirstResolutionWins")
        require(sum(s.ran) <= 1, "AtMostOneDestinationRuns")
        require(all(not ran or s.resolution == j for j, ran in enumerate(s.ran)), "OnlyConfirmedDestinationRuns")
        require(s.resolution != -1 or not any(s.ran), "CancelBeforeCompleteRunsNothing")
        require(all(c not in "RD" or s.reserve[j] == "D" for j, c in enumerate(s.control)), "FirstTurnBeforeLaterControl")
        if s.resolution == -1 and any(s.completed):
            self.covered.add("cancel-before-complete")
        if any(s.ran):
            self.covered.add("selected-work")
        if any(p == "D" and s.resolution != j for j, p in enumerate(s.reserve)):
            self.covered.add("unselected-released")
        if all(s.completed):
            self.covered.add("duplicate-complete")
        if s.lifecycle_aborted and "W" in s.reserve:
            self.covered.add("lifecycle-abort-while-awaiting-destination")

    def rank(self, s):
        return (sum({"N": 0, "Q": 1, "W": 2, "R": 3, "D": 4}[p] for p in s.reserve)
                + sum({"N": 0, "Q": 1, "R": 2, "D": 3}[p] for p in s.control)
                + sum(s.completed) + s.cancelled + s.lifecycle_aborted + (s.resolution != -2))

    def terminal(self, s):
        return (s.cancelled and all(s.completed) and all(p == "D" for p in s.reserve)
                and all(c == "D" for c in s.control))


@dataclass(frozen=True, slots=True)
class ConversationState:
    phase: tuple[str, ...] = ("Q", "Q", "Q")
    registry: tuple[int, ...] = (-1, -1)
    local_abort: tuple[bool, ...] = (False, False, False)
    parent_abort: bool = False


class Conversations:
    name = "conversation-cancellation"
    initial = ConversationState()
    keys = (0, 0, 1)
    expected_coverage = {"two-active-conversations", "local-cancel-isolated", "parent-cancel-propagated"}

    def __init__(self):
        self.covered = set()

    def next(self, s):
        for j, p in enumerate(s.phase):
            key = self.keys[j]
            if p == "Q" and all(s.phase[k] == "D" for k in range(j) if self.keys[k] == key):
                yield f"register-turn({j},key={key})", replace(s,
                    phase=changed(s.phase, j, "R"), registry=changed(s.registry, key, j))
            if p == "R":
                yield f"turn-finally({j})", replace(s,
                    phase=changed(s.phase, j, "D"), registry=changed(s.registry, key, -1))
        for key, j in enumerate(s.registry):
            if j != -1 and not s.local_abort[j]:
                yield f"cancel-conversation(key={key})", replace(s, local_abort=changed(s.local_abort, j, True))
        if not s.parent_abort:
            yield "abort-parent-lifecycle", replace(s, parent_abort=True)

    def check(self, s):
        for key in range(len(s.registry)):
            active = [j for j, p in enumerate(s.phase) if p == "R" and self.keys[j] == key]
            require(len(active) <= 1, "OneControllerPerActiveKey")
            require(s.registry[key] == (active[0] if active else -1), "RegistryExactness")
        require(all(not s.local_abort[j] or s.phase[j] != "Q" for j in range(3)), "NoCancellationOfQueuedTurn")
        if s.phase.count("R") == 2:
            self.covered.add("two-active-conversations")
            effective = [s.parent_abort or s.local_abort[j] for j, p in enumerate(s.phase) if p == "R"]
            if any(effective) and not all(effective):
                self.covered.add("local-cancel-isolated")
            if s.parent_abort and all(effective):
                self.covered.add("parent-cancel-propagated")

    def check_edge(self, before, action, after):
        if action.startswith("cancel-conversation"):
            key = int(action.split("=")[1][:-1])
            target = before.registry[key]
            require(not after.parent_abort or before.parent_abort, "LocalCancelDoesNotAbortParent")
            require(all(before.local_abort[j] == after.local_abort[j] for j in range(3) if j != target), "LocalCancelDoesNotAbortOtherTurn")

    def rank(self, s):
        return sum({"Q": 0, "R": 1, "D": 2}[p] for p in s.phase) + sum(s.local_abort) + s.parent_abort

    def terminal(self, s):
        return all(p == "D" for p in s.phase) and s.parent_abort and all(j == -1 for j in s.registry)


def explore(model):
    """BFS every reachable state; retain predecessors for shortest witnesses.

    This is complete state enumeration, with no depth bound, sampling,
    scheduling heuristic, or state-count cutoff. Equality is structural.
    Strictly increasing rank plus no nonterminal deadlocks establishes finite
    nonstuttering termination within the stated environment abstraction.
    """
    started = perf_counter()
    initial = model.initial
    parents = {initial: None}
    queue = deque([initial])
    transitions = terminals = max_depth = 0
    depths = {initial: 0}
    failure_state = initial
    failure_action = None
    global_check = False
    try:
        model.check(initial)
        while queue:
            state = queue.popleft()
            # A deadlock belongs to this dequeued state, not the last edge
            # explored from a different state in the previous iteration.
            failure_state, failure_action = state, None
            successors = list(model.next(state))
            if not successors:
                require(model.terminal(state), "NoNonterminalDeadlock")
                terminals += 1
            for action, successor in successors:
                transitions += 1
                if successor not in parents:
                    parents[successor] = (state, action)
                    depths[successor] = depths[state] + 1
                    max_depth = max(max_depth, depths[successor])
                    queue.append(successor)
                # Keep the actual edge even if its successor was seen earlier;
                # an edge-local invariant may fail only on this incoming path.
                failure_state, failure_action = state, action
                model.check(successor)
                if hasattr(model, "check_edge"):
                    model.check_edge(state, action, successor)
                require(model.rank(successor) > model.rank(state), "StrictProgressRank")
        # Coverage/reachability obligations describe the entire explored graph;
        # no individual path is a counterexample to missing coverage.
        global_check = True
        require(terminals > 0, "TerminalStateReachable")
        require(model.expected_coverage <= model.covered, "RequiredBoundaryCoverage")
    except Violation as error:
        result = {"model": model.name, "result": "FAIL", "invariant": str(error),
                  "states": len(parents), "transitions": transitions,
                  "diagnostic_scope": "global" if global_check else "trace",
                  "seconds": round(perf_counter() - started, 3)}
        if global_check:
            result["missing_coverage"] = sorted(model.expected_coverage - model.covered)
        else:
            trace = [] if failure_action is None else [failure_action]
            cursor = failure_state
            while parents[cursor] is not None:
                previous, action = parents[cursor]
                trace.append(action)
                cursor = previous
            result["counterexample"] = list(reversed(trace))
        return result
    return {"model": model.name, "result": "PASS", "states": len(parents),
            "transitions": transitions, "terminal_states": terminals,
            "max_shortest_path": max_depth, "coverage": sorted(model.covered),
            "seconds": round(perf_counter() - started, 3)}


def check_sources():
    root = Path(__file__).resolve().parent.parent
    manifest = json.loads((root / "formal/source-manifest.json").read_text())
    changed_files = []
    for entry in manifest["sources"]:
        path = entry["path"]
        content = (root / path).read_text()
        if "start" in entry:
            try:
                content = content.split(entry["start"], 1)[1].split(entry["end"], 1)[0]
            except IndexError:
                changed_files.append(path)
                continue
        actual = hashlib.sha256(content.encode()).hexdigest()
        if actual != entry["sha256"]:
            changed_files.append(path)
    return {"result": "PASS" if not changed_files else "REVIEW_REQUIRED",
            "reference_commit": manifest["reference_commit"], "changed_files": changed_files}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="machine-readable report")
    parser.add_argument("--full", action="store_true", help="explicit exhaustive mode (already the default; no sampling mode)")
    parser.add_argument("--check-source", action="store_true", help="fail on source drift until correspondence is re-reviewed")
    parser.add_argument("--negative-controls", action="store_true", help="also require six deliberate mutants to fail")
    args = parser.parse_args()
    # All two-key assignments of four jobs, quotienting key-name symmetry.
    lane_models = [Lanes((0,) + suffix) for suffix in product((0, 1), repeat=3)]
    for model in lane_models:
        if len(set(model.keys)) == 1:
            model.expected_coverage = Lanes.expected_coverage - {"different-keys-concurrent"}
    models = [Budget(4, 2), Budget(6, 4), *lane_models, Transfers(), Conversations()]
    results = [explore(model) for model in models]
    report = {"checker": "exhaustive-explicit-state", "source_correspondence": check_sources(),
              "checks": results, "negative_controls": []}
    good = all(r["result"] == "PASS" for r in results)
    if args.check_source:
        good &= report["source_correspondence"]["result"] == "PASS"
    if args.negative_controls:
        mutants = [(Budget(4, 2, "over-admit"), "CapacityBound"),
                   (Budget(4, 2, "keep-aborted-waiter"), "AbortedWaiterRemoved"),
                   (Budget(4, 2, "omit-abort-recheck"), "NoStartAfterObservedAbort"),
                   (Lanes(mutation="unguarded-cleanup"), "NoLostLiveTail"),
                   (Transfers(mutation="resolve-twice"), "PromiseFirstResolutionWins"),
                   (Transfers(mutation="omit-transfer-abort-recheck"), "NoTransferStartAfterLifecycleAbort")]
        for model, expected in mutants:
            result = explore(model)
            result["mutation"] = model.mutation
            result["expected_invariant"] = expected
            result["detected_as_expected"] = result.get("invariant") == expected
            report["negative_controls"].append(result)
            good &= result["detected_as_expected"]
    report["instance_count"] = len(results)
    report["total_states"] = sum(r["states"] for r in results)
    report["total_transitions"] = sum(r["transitions"] for r in results)
    report["result"] = "PASS" if good else "FAIL"
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("Source correspondence:", report["source_correspondence"]["result"])
        for r in results:
            print(f"{r['result']:4} {r['model']}: {r['states']:,} states, {r['transitions']:,} transitions ({r['seconds']}s)")
            if r["result"] == "FAIL":
                detail = (" -> ".join(r["counterexample"]) if "counterexample" in r
                          else "global obligation; missing coverage: " + ", ".join(r["missing_coverage"]))
                print(" ", r["invariant"], detail)
        for r in report["negative_controls"]:
            print(f"{'PASS' if r['detected_as_expected'] else 'FAIL'} negative control {r['mutation']}: {r.get('invariant', 'NOT DETECTED')}")
            print(" ", " -> ".join(r.get("counterexample", [])))
        print("Overall:", report["result"])
    return 0 if good else 1


if __name__ == "__main__":
    sys.exit(main())
