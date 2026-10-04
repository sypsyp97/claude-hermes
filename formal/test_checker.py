"""Small diagnostic regressions for the state-space exploration engine."""
import unittest

from check import explore, require


class ToyModel:
    name = "checker-diagnostic-fixture"
    initial = 0
    expected_coverage = frozenset()

    def __init__(self, edges, terminals, coverage=()):
        self.edges = edges
        self.terminals = terminals
        self.covered = set(coverage)

    def next(self, state):
        return self.edges.get(state, ())

    def check(self, state):
        pass

    def rank(self, state):
        return state

    def terminal(self, state):
        return state in self.terminals


class CheckerDiagnostics(unittest.TestCase):
    def test_deadlock_witness_ends_at_deadlocked_state_not_last_successor(self):
        # The final edge examined from 0 leads to 2, but BFS next visits the
        # deadlock at 1. The old bookkeeping incorrectly reported "other".
        model = ToyModel({0: [("dead-end", 1), ("other", 2)]}, {2})
        result = explore(model)
        self.assertEqual(result["invariant"], "NoNonterminalDeadlock")
        self.assertEqual(result["diagnostic_scope"], "trace")
        self.assertEqual(result["counterexample"], ["dead-end"])

    def test_missing_coverage_is_global_and_has_no_fabricated_witness(self):
        model = ToyModel({0: [("finish", 1)]}, {1})
        model.expected_coverage = {"unreachable-boundary"}
        result = explore(model)
        self.assertEqual(result["invariant"], "RequiredBoundaryCoverage")
        self.assertEqual(result["diagnostic_scope"], "global")
        self.assertEqual(result["missing_coverage"], ["unreachable-boundary"])
        self.assertNotIn("counterexample", result)

    def test_edge_failure_preserves_actual_path_to_previously_seen_state(self):
        model = ToyModel({0: [("via-one", 1), ("direct", 2)],
                          1: [("bad-edge", 2)]}, {2})
        model.check_edge = lambda before, action, after: require(action != "bad-edge", "EdgeSafety")
        result = explore(model)
        self.assertEqual(result["invariant"], "EdgeSafety")
        self.assertEqual(result["counterexample"], ["via-one", "bad-edge"])

    def test_initial_state_failure_has_empty_witness(self):
        model = ToyModel({}, {0})
        model.check = lambda state: require(False, "InitialSafety")
        result = explore(model)
        self.assertEqual(result["invariant"], "InitialSafety")
        self.assertEqual(result["counterexample"], [])


if __name__ == "__main__":
    unittest.main()
