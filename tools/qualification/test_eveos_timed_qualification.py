"""Hermetic Qualification Engine v3 invariants; never starts EveOS services."""
import importlib.util
import pathlib
import sys
import unittest


DIRECTORY = pathlib.Path(__file__).parent
sys.path.insert(0, str(DIRECTORY))
spec = importlib.util.spec_from_file_location('timed_qualification', DIRECTORY / 'eveos_timed_qualification.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class TimedQualificationTests(unittest.TestCase):
    def test_time_display(self):
        self.assertEqual(runner.clock(0), '00:00:00')
        self.assertEqual(runner.clock(3661), '01:01:01')

    def test_full_release_is_manifest_driven(self):
        gates, metadata = runner.gate_plan('verify')
        self.assertEqual(len(gates), 41)
        self.assertEqual(gates[0]['label'], 'guardrails')
        self.assertEqual(metadata['coverage']['optimizedDuplicates'], [])
        self.assertEqual(metadata['coverage']['legacyObligations'], 41)

    def test_nexus_is_partial_and_does_not_reinvoke_full_release(self):
        gates, _ = runner.gate_plan('nexus')
        self.assertEqual(gates[0]['label'], 'guardrails')
        self.assertFalse(any(item['argv'][1:] == ['run', 'verify'] for item in gates))
        self.assertTrue(any('playwright' in item['resources'] for item in gates))

    def test_invalid_graphs_fail_closed(self):
        cases = ([runner.gate('a', [], depends=('missing',))],
                 [runner.gate('a', [], depends=('b',)), runner.gate('b', [], depends=('a',))])
        for case in cases:
            with self.assertRaises(ValueError): runner.validate_gate_graph(case)

    def test_resource_coordinator_is_atomic(self):
        coordinator = runner.ResourceCoordinator()
        self.assertTrue(coordinator.acquire('first', ('a', 'b')))
        self.assertFalse(coordinator.acquire('second', ('b', 'c')))
        coordinator.release('first', ('a', 'b'))
        self.assertTrue(coordinator.acquire('second', ('b', 'c')))


if __name__ == '__main__': unittest.main()
