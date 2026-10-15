"""Finite session protocols; helper injection keeps the explorer's exception type.

No OS or database implementation is simulated. Atomic SQLite segments and awaited
native observations are separate transitions. See README.md for correspondence.
"""
from dataclasses import dataclass, replace


def changed(values, index, value):
    return values[:index] + (value,) + values[index + 1:]


@dataclass(frozen=True, slots=True)
class GenerationState:
    generation: int = 0
    session: int = -1
    context: bool = False
    history: bool = False
    prior_fact: bool = False
    turn: int = 0  # capture, run, completed
    captured: int = -1
    persisted_id: int = -1
    fact: int = 0  # capture source, await extractor, commit, completed
    source_id: int = -1
    source_generation: int = -1
    reset: bool = False
    recreated: bool = False
    bad_turn: bool = False
    bad_fact: bool = False
    shared_fallback: bool = False
    fact_id: int = -1
    turn_rejected: bool = False
    fact_rejected: bool = False


class Generations:
    def __init__(self, require, existing=True, operation="reset", explicit=True, mutation=None):
        self.require, self.existing, self.operation = require, existing, operation
        self.explicit, self.mutation = explicit, mutation
        self.name = f"session-generation-{'existing' if existing else 'first'}-{operation}-{'explicit' if explicit else 'captured'}"
        self.bounds = {"turns": 1, "extractors": 1, "controls": 1, "source_initially_exists": existing,
                       "operation": operation, "explicit_turn_generation": explicit,
                       "recreations": int(operation == "forget")}
        self.initial = GenerationState(session=1 if existing else -1, context=existing,
                                       history=existing, prior_fact=existing)
        self.covered = set()
        self.expected_coverage = {"current-turn-persists", "stale-turn-rejected",
                                  "current-fact-attributed", "stale-fact-rejected"}
        if not existing:
            self.expected_coverage |= {"first-turn-invalidated-without-session"}
        if operation == "reset" and existing:
            self.expected_coverage |= {"reset-retains-source-history", "source-id-survives-reset"}
        if operation == "forget":
            self.expected_coverage |= {"deleted-source-no-shared-fallback", "replacement-rejects-old-extraction"}

    def next(self, s):
        if s.turn == 0:
            yield "capture-turn-generation", replace(s, turn=1, captured=s.generation)
        if s.turn == 1:
            valid = s.captured == s.generation
            if valid or self.mutation == "omit-turn-generation":
                identity = s.session if s.session != -1 else (2 if s.recreated else 1)
                yield "persist-turn-immediate", replace(s, turn=2, session=identity, context=True,
                    history=True, persisted_id=identity, bad_turn=not valid)
            else:
                yield "reject-stale-turn-immediate", replace(s, turn=2, turn_rejected=True)
        if not s.reset:
            forgotten = self.operation == "forget"
            yield f"{self.operation}-immediate", replace(s, generation=s.generation + 1,
                reset=True, session=-1 if forgotten else s.session, context=False,
                history=False if forgotten or self.mutation == "reset-erases-history" else s.history,
                prior_fact=False if forgotten or self.mutation == "reset-erases-history" else s.prior_fact)
        if self.operation == "forget" and s.reset and not s.recreated:
            yield "recreate-source-immediate", replace(s, recreated=True, generation=s.generation + 1,
                                                      session=2, context=True)
        if s.fact == 0 and (not self.explicit or s.turn > 0):
            identity = 1 if self.existing else s.persisted_id
            if identity == -1 and s.turn != 2:
                return
            source_exists = identity != -1 and s.session == identity
            if source_exists:
                generation = s.captured if self.explicit else s.generation
                yield "capture-source-before-extractor-immediate", replace(s, fact=1,
                    source_id=identity, source_generation=generation)
            elif self.mutation == "missing-source-falls-back":
                yield "missing-source-extracts-without-attribution", replace(s, fact=1, source_id=identity,
                    source_generation=s.captured if self.explicit else s.generation)
            else:
                yield "reject-missing-source-before-extraction", replace(s, fact=3, source_id=identity,
                    fact_rejected=True)
        if s.fact == 1:
            yield "extractor-resolves", replace(s, fact=2)
        if s.fact == 2:
            same_source = s.source_id != -1 and s.session == s.source_id
            same_generation = s.source_generation == s.generation
            if self.mutation == "missing-source-falls-back" and not same_source:
                yield "append-unattributed-shared-fact", replace(s, fact=3, shared_fallback=True)
            elif same_source and (same_generation or self.mutation == "omit-fact-generation"):
                yield "commit-attributed-fact-immediate", replace(s, fact=3, fact_id=s.source_id,
                    bad_fact=not same_generation)
            else:
                yield "reject-stale-fact-immediate", replace(s, fact=3, fact_rejected=True)

    def check(self, s):
        self.require(not s.bad_turn, "GenerationFencesTurnPersistence")
        self.require(not s.bad_fact, "GenerationFencesFacts")
        self.require(not s.shared_fallback and (s.fact_id == -1 or s.fact_id == s.source_id),
                     "StableMemorySourceAttribution")
        if s.persisted_id != -1:
            self.covered.add("current-turn-persists")
        if s.turn_rejected:
            self.covered.add("stale-turn-rejected")
            if not self.existing and s.session == -1:
                self.covered.add("first-turn-invalidated-without-session")
        if s.fact_id != -1:
            self.covered.add("current-fact-attributed")
        if s.fact_rejected and s.source_id != -1 and s.source_generation != -1:
            self.covered.add("stale-fact-rejected")
        if s.reset and self.operation == "reset" and self.existing and s.session == 1 and s.prior_fact:
            self.covered |= {"reset-retains-source-history", "source-id-survives-reset"}
        if s.fact_rejected and s.reset and self.operation == "forget":
            if s.session == -1:
                self.covered.add("deleted-source-no-shared-fallback")
            if s.recreated and s.source_id == 1 and s.source_generation != -1:
                self.covered.add("replacement-rejects-old-extraction")

    def check_edge(self, before, action, after):
        if action == "reset-immediate":
            self.require((before.session, before.history, before.prior_fact) ==
                         (after.session, after.history, after.prior_fact), "ResetPreservesDurableHistory")

    def rank(self, s):
        return s.turn + s.fact + s.reset + s.recreated

    def terminal(self, s):
        return s.turn == 2 and s.fact == 3 and s.reset and (self.operation != "forget" or s.recreated)


@dataclass(frozen=True, slots=True)
class LeaseState:
    phase: tuple[str, ...]
    token: tuple[int, ...]
    owner: tuple[int, ...]
    child: tuple[int, ...]
    generation: tuple[int, ...]
    captured: tuple[int, ...]
    alive: tuple[bool, ...]
    children: tuple[int, ...]  # 0 absent, 1 guarded, 2 useful, 3 leader dead/live descendants, 4 dead
    snapshot: tuple[tuple[int, int, int], ...]
    observation: tuple[int, ...]  # -1 pending, 0 confirmed dead, 1 live, 2 unknown
    cleanup: tuple[tuple[int, int, int], ...]
    retain: tuple[bool, ...]
    aborted: bool = False
    cleared: bool = False
    crashed: bool = False
    bad_recovery: bool = False
    bad_permission: bool = False
    bad_abort: bool = False
    cas_rejected: bool = False
    unknown_rejected: bool = False
    live_rejected: bool = False
    registered_clear: bool = False
    stale_command: bool = False


class Leases:
    # One acquisition attempt per contender. A rejected/live/unknown probe ends
    # that episode; it does not pretend to establish eventual waiter admission.
    ranks = {"N": 0, "P": 1, "C": 2, "H": 3, "G": 4, "R": 5,
             "U": 6, "F": 7, "L": 8, "D": 9}

    def __init__(self, require, scenario="same-key", mutation=None):
        self.require, self.scenario, self.mutation = require, scenario, mutation
        recovery = scenario == "recovery-race"
        self.keys = (0, 0, 0) if recovery else ((0, 1) if scenario == "independent-keys" else (0, 0))
        n, k = len(self.keys), max(self.keys) + 1
        self.name = f"durable-lease-{scenario}"
        self.bounds = {"processes": n, "physical_workspaces": 1, "keys": k,
                       "acquisition_attempts_per_contender": 1, "owner_crashes": 1,
                       "clear_operations": 1, "aborts": 1, "preowned_lease": recovery,
                       "adversarial_retired_token_command": 1}
        self.initial = LeaseState(
            phase=("H", "N", "N") if recovery else ("N",) * n,
            token=(0,) if recovery else (-1,) * k,
            owner=(0,) if recovery else (-1,) * k, child=(-1,) * k,
            generation=(0,) * k, captured=(0,) * n, alive=(True,) * n,
            children=(0,) * n, snapshot=((-1, -1, -1),) * n,
            observation=(-1,) * n, cleanup=((-1, -1, -1),) * n, retain=(False,) * n)
        self.covered = set()
        self.expected_coverage = {"guard-spawn-before-registration", "registered-before-permission",
            "clear-keeps-active-lease", "clear-between-register-and-permission", "stale-generation-registration-rejected",
            "abort-before-acquire-no-child", "owner-crash-before-registration", "owner-crash-after-registration",
            "owner-crash-after-permission", "descendants-live-after-leader-death", "unknown-final-probe-retains-fence",
            "old-generation-permission-keeps-fence", "retired-owner-live-descendant-fence"}
        if scenario != "independent-keys":
            self.expected_coverage |= {"live-owner-blocks-contender", "live-orphan-blocks-recovery", "unknown-probe-rejects"}
        else:
            self.expected_coverage |= {"independent-keys-useful-work"}
        if recovery:
            self.expected_coverage |= {"stale-death-snapshot-cas-rejected", "confirmed-dead-recovery",
                "three-process-death-snapshot-after-successor-child", "retired-token-cleanup-preserves-successor"}

    def row(self, s, key):
        return s.token[key], s.owner[key], s.child[key]

    def install(self, s, j):
        key = self.keys[j]
        return replace(s, phase=changed(s.phase, j, "H"), token=changed(s.token, key, j),
            owner=changed(s.owner, key, j), child=changed(s.child, key, -1),
            captured=changed(s.captured, j, s.generation[key]))

    def live(self, s, row):
        _, owner, child = row
        return ((owner >= 0 and s.alive[owner]) or
                (child >= 0 and s.children[child] in (1, 2, 3)))

    def next(self, s):
        n = len(self.keys)
        if not s.aborted:
            yield f"abort-waiter({n - 1})", replace(s, aborted=True)
        if not s.cleared:
            out = replace(s, cleared=True,
                generation=changed(s.generation, 0, 1),
                registered_clear=s.registered_clear or any(p == "R" and self.keys[j] == 0 for j, p in enumerate(s.phase)))
            if self.mutation == "clear-releases-lease":
                out = replace(out, token=changed(s.token, 0, -1), owner=changed(s.owner, 0, -1),
                              child=changed(s.child, 0, -1))
            yield "clear-generation-immediate(key=0)", out
        for j, phase in enumerate(s.phase):
            key = self.keys[j]
            abort = s.aborted and j == n - 1
            if phase == "N":
                if abort and self.mutation != "omit-waiter-abort":
                    yield f"reject-aborted-waiter({j})", replace(s, phase=changed(s.phase, j, "D"))
                elif s.token[key] == -1:
                    yield f"acquire-free-immediate({j})", self.install(s, j)
                else:
                    yield f"read-occupied-immediate({j})", replace(s, phase=changed(s.phase, j, "P"),
                        snapshot=changed(s.snapshot, j, self.row(s, key)))
                    if self.mutation == "duplicate-useful-work" and any(
                            self.keys[other] == key and child in (2, 3) for other, child in enumerate(s.children)):
                        yield f"bypass-lease-start-useful-work({j})", replace(s,
                            phase=changed(s.phase, j, "U"), children=changed(s.children, j, 2))
            if phase == "P":
                if abort and self.mutation != "omit-waiter-abort":
                    yield f"reject-aborted-probe({j})", replace(s, phase=changed(s.phase, j, "D"))
                else:
                    outcome = 1 if self.live(s, s.snapshot[j]) else 0
                    yield f"native-probe-{'live' if outcome else 'dead'}({j})", replace(s,
                        phase=changed(s.phase, j, "C"), observation=changed(s.observation, j, outcome))
                    yield f"native-probe-unknown({j})", replace(s,
                        phase=changed(s.phase, j, "C"), observation=changed(s.observation, j, 2))
            if phase == "C":
                outcome = s.observation[j]
                invalid = abort and self.mutation != "omit-waiter-abort"
                can_recover = outcome == 0 or self.mutation == "recover-unknown" and outcome == 2 or self.mutation == "steal-live" and outcome == 1
                if invalid:
                    yield f"reject-aborted-before-cas({j})", replace(s, phase=changed(s.phase, j, "D"))
                elif can_recover:
                    matches = self.row(s, key) == s.snapshot[j]
                    if matches or self.mutation == "omit-snapshot-cas":
                        yield f"recover-dead-owner-cas-immediate({j})", replace(self.install(s, j),
                            bad_recovery=s.bad_recovery or outcome != 0)
                    else:
                        yield f"reject-stale-snapshot-cas-immediate({j})", replace(s,
                            phase=changed(s.phase, j, "D"), cas_rejected=True)
                else:
                    yield f"{'reject-unknown' if outcome == 2 else 'wait-live'}-end-episode({j})", replace(s,
                        phase=changed(s.phase, j, "D"), unknown_rejected=s.unknown_rejected or outcome == 2,
                        live_rejected=s.live_rejected or outcome == 1)
            if phase == "H":
                if abort and self.mutation != "omit-waiter-abort":
                    yield f"abort-before-guard-spawn({j})", replace(s, phase=changed(s.phase, j, "F"))
                else:
                    yield f"spawn-guard-no-permission({j})", replace(s, phase=changed(s.phase, j, "G"),
                        children=changed(s.children, j, 1), bad_abort=s.bad_abort or abort)
            if phase == "G":
                valid = self.row(s, key)[:2] == (j, j) and (
                    s.generation[key] == s.captured[j] or self.mutation == "omit-register-generation")
                if abort and self.mutation != "omit-waiter-abort" or not valid:
                    yield f"reject-registration-or-abort({j})", replace(s, phase=changed(s.phase, j, "F"),
                        children=changed(s.children, j, 4))
                else:
                    yield f"register-child-cas-immediate({j})", replace(s, phase=changed(s.phase, j, "R"),
                        child=changed(s.child, key, j))
                    if self.mutation == "permission-before-registration":
                        yield f"send-permission-without-registration({j})", replace(s, phase=changed(s.phase, j, "U"),
                            children=changed(s.children, j, 2), bad_permission=True)
            if phase == "R":
                if abort and self.mutation != "omit-waiter-abort":
                    yield f"abort-before-permission({j})", replace(s, phase=changed(s.phase, j, "F"),
                        children=changed(s.children, j, 4))
                else:
                    # Source intentionally does not recheck generation here.
                    yield f"send-permission({j})", replace(s, phase=changed(s.phase, j, "U"),
                        children=changed(s.children, j, 2), bad_abort=s.bad_abort or abort,
                        bad_permission=s.bad_permission or self.row(s, key) != (j, j, j))
            if phase == "U" and s.children[j] in (3, 4):
                yield f"work-settles({j})", replace(s, phase=changed(s.phase, j, "F"))
            if phase == "F":
                row = self.row(s, key)
                live = row[2] >= 0 and s.children[row[2]] in (1, 2, 3)
                yield f"finally-native-probe-{'live' if live else 'dead'}({j})", replace(s,
                    phase=changed(s.phase, j, "L"), cleanup=changed(s.cleanup, j, row), retain=changed(s.retain, j, live))
                if row[2] != -1:
                    yield f"finally-native-probe-unknown({j})", replace(s,
                        phase=changed(s.phase, j, "L"), cleanup=changed(s.cleanup, j, row),
                        retain=changed(s.retain, j, self.mutation != "unknown-final-probe-releases"))
            if phase == "L":
                out = replace(s, phase=changed(s.phase, j, "D"))
                if s.cleanup[j][0] == j and self.row(s, key) == s.cleanup[j]:
                    retained = s.retain[j]
                    out = replace(out, token=changed(s.token, key, j if retained else -1),
                        owner=changed(s.owner, key, -2 if retained else -1),
                        child=changed(s.child, key, s.cleanup[j][2] if retained else -1))
                yield f"finally-token-owner-child-cas({j})", out
            if j == 0 and not s.crashed and phase in ("H", "G", "R", "U", "F", "L"):
                out = replace(s, crashed=True, alive=changed(s.alive, j, False),
                    phase=changed(s.phase, j, "D"))
                if self.mutation == "drop-orphan-child-fence":
                    out = replace(out, child=changed(s.child, key, -1))
                yield f"owner-crash({phase})", out
            if s.children[j] == 1 and not s.alive[j]:
                yield f"guard-eof-without-permission({j})", replace(s, children=changed(s.children, j, 4))
            if s.children[j] == 2:
                yield f"child-group-exits({j})", replace(s, children=changed(s.children, j, 4))
                yield f"leader-exits-descendants-live({j})", replace(s, children=changed(s.children, j, 3))
            if s.children[j] == 3:
                yield f"last-descendant-exits({j})", replace(s, children=changed(s.children, j, 4))
        # Defensive command scenario, not a resumed crashed callback. A retired
        # token is presented after a successor owns the row; source guards no-op.
        if not s.stale_command and s.phase[0] == "D" and s.token[0] != 0:
            out = replace(s, stale_command=True)
            if self.mutation == "unguarded-retired-cleanup":
                out = replace(out, token=changed(s.token, 0, -1), owner=changed(s.owner, 0, -1),
                              child=changed(s.child, 0, -1))
            yield "adversarial-retired-token-cleanup(0)", out

    def check(self, s):
        self.require(not s.bad_recovery, "RecoveryRequiresConfirmedDead")
        self.require(not s.bad_permission, "PermissionRequiresDurableRegistration")
        self.require(not s.bad_abort, "AbortedWaiterNeverStartsChild")
        for key in range(len(s.token)):
            workers = [j for j in range(len(self.keys)) if self.keys[j] == key and s.children[j] in (2, 3)]
            self.require(len(workers) <= 1, "CrossProcessMutualExclusion")
            self.require(all(s.token[key] == j and s.child[key] == j for j in workers), "LiveChildRetainsFence")
        if "G" in s.phase:
            self.covered.add("guard-spawn-before-registration")
        if "R" in s.phase:
            self.covered.add("registered-before-permission")
        if s.registered_clear:
            self.covered.add("clear-between-register-and-permission")
        if any(p == "U" and s.generation[self.keys[j]] != s.captured[j] for j, p in enumerate(s.phase)):
            self.covered.add("old-generation-permission-keeps-fence")
        if any(owner == -2 and child >= 0 and s.children[child] == 3 for owner, child in zip(s.owner, s.child)):
            self.covered.add("retired-owner-live-descendant-fence")
        if s.aborted and s.phase[-1] == "D" and s.children[-1] == 0:
            self.covered.add("abort-before-acquire-no-child")
        if 3 in s.children:
            self.covered.add("descendants-live-after-leader-death")
        if len(s.token) > 1 and sum(c in (2, 3) for c in s.children) == 2:
            self.covered.add("independent-keys-useful-work")
        if s.unknown_rejected:
            self.covered.add("unknown-probe-rejects")

    def check_edge(self, before, action, after):
        if action.startswith("clear-generation"):
            self.require((before.token, before.owner, before.child) == (after.token, after.owner, after.child),
                         "ClearPreservesLease")
            if before.token[0] != -1:
                self.covered.add("clear-keeps-active-lease")
        if action.startswith("recover-dead-owner-cas"):
            j = int(action.split("(")[1][:-1])
            key = self.keys[j]
            self.require(self.row(before, key) == before.snapshot[j], "SnapshotCASPreventsSteal")
            self.covered.add("confirmed-dead-recovery")
        if action.startswith("reject-stale-snapshot"):
            self.covered.add("stale-death-snapshot-cas-rejected")
            j = int(action.split("(")[1][:-1])
            key = self.keys[j]
            if before.child[key] >= 0 and before.children[before.child[key]] in (2, 3):
                self.covered.add("stale-death-snapshot-after-successor-child")
            if (self.scenario == "recovery-race" and j == 1 and before.snapshot[j][0] == 0
                    and not before.alive[0] and before.token[key] == 2 and before.child[key] == 2
                    and before.children[2] in (2, 3)):
                self.covered.add("three-process-death-snapshot-after-successor-child")
        if action.startswith("reject-registration"):
            j = int(action.split("(")[1][:-1])
            if before.generation[self.keys[j]] != before.captured[j]:
                self.covered.add("stale-generation-registration-rejected")
        if action.startswith("register-child-cas"):
            j = int(action.split("(")[1][:-1])
            self.require(before.generation[self.keys[j]] == before.captured[j], "GenerationFencesRegistration")
        if action.startswith("owner-crash"):
            phase = action.split("(")[1][:-1]
            if phase in ("H", "G"):
                self.covered.add("owner-crash-before-registration")
            if phase == "R":
                self.covered.add("owner-crash-after-registration")
            if phase == "U":
                self.covered.add("owner-crash-after-permission")
        if action.startswith("wait-live"):
            j = int(action.split("(")[1][:-1])
            row = before.snapshot[j]
            if row[1] >= 0 and before.alive[row[1]]:
                self.covered.add("live-owner-blocks-contender")
            if row[2] >= 0 and before.children[row[2]] in (2, 3) and (row[1] < 0 or not before.alive[row[1]]):
                self.covered.add("live-orphan-blocks-recovery")
        if action.startswith("finally-native-probe-unknown"):
            j = int(action.split("(")[1][:-1])
            self.require(after.retain[j], "UnknownFinalProbeRetainsFence")
            self.covered.add("unknown-final-probe-retains-fence")
        if action == "adversarial-retired-token-cleanup(0)":
            self.require(self.row(before, 0) == self.row(after, 0), "StaleCleanupPreservesSuccessor")
            if before.token[0] > 0:
                self.covered.add("retired-token-cleanup-preserves-successor")

    def rank(self, s):
        return sum(self.ranks[p] for p in s.phase) + sum(s.children) + s.aborted + s.cleared + s.stale_command

    def terminal(self, s):
        return all(p == "D" for p in s.phase) and all(c in (0, 4) for c in s.children) and s.aborted and s.cleared
