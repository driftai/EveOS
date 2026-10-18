"""Hermetic invariants; never run EveOS or touch its services."""
import importlib.util
import pathlib
import tempfile
import unittest
import json
import os
import sys

MODULE = pathlib.Path(__file__).with_name('eveos_timed_qualification.py')
spec = importlib.util.spec_from_file_location('timed_qualification', MODULE)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

class TimedQualificationTests(unittest.TestCase):
    def test_time_display(self):
        self.assertEqual(runner.clock(0), '00:00:00')
        self.assertEqual(runner.clock(3661), '01:01:01')

    def test_mandatory_full_verify_once_in_each_profile(self):
        for profile in ('verify', 'nexus'):
            units, serial = runner.gate_plan(profile)
            all_commands = units + serial
            verify = [a for _, a in all_commands if a[1:] == ['run','verify']]
            self.assertEqual(len(verify),1)
            self.assertEqual(serial[-1][0], 'verify')
            self.assertEqual(serial[-1][1][1:], ['run','verify'])
            self.assertTrue(all('verify' not in a for _,a in units))

    def test_disjoint_parallel_lane_is_pure_tests_and_syntax(self):
        unit, serial = runner.gate_plan('nexus')
        self.assertEqual(len(unit), 5)
        for _, args in unit:
            self.assertEqual(args[0], 'node')
            self.assertIn(args[1], ('--test','--check'))
        self.assertTrue(all('playwright' not in ' '.join(a) for _,a in unit))
        self.assertTrue(any('playwright' in ' '.join(a) for _,a in serial))

    def test_stage_parser_tracks_npm_banners(self):
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d)/'fake.log'
            p.write_text('> eveos@0.7.0 verify\nnoise\n> eveos@0.7.0 smoke:world-book\n', encoding='utf-8')
            off,buf,stages,new=runner.collect_stages(p,0,'',[],10.0)
            self.assertEqual(new,'smoke:world-book')
            self.assertEqual(len(stages),1)
            with p.open('a',encoding='utf-8') as f:
                f.write('more data\n> eveos@0.7.0 smoke:bookmark-intel\n')
            off,buf,stages,new=runner.collect_stages(p,off,buf,stages,19.0)
            self.assertEqual(new,'smoke:bookmark-intel')
            self.assertEqual(stages[0]['end'],19.0)

    def test_fail_closed_stops_before_following_gates(self):
        with tempfile.TemporaryDirectory() as d:
            old=runner.gate_plan
            runner.gate_plan=lambda profile: ([], [
                ('bad',[sys.executable,'-c','import sys;sys.exit(9)']),
                ('must-not-run',[sys.executable,'-c','print("oops")'])])
            try:
                r=runner.run('verify',pathlib.Path(d), heartbeat=15,timeout=60)
            finally:
                runner.gate_plan=old
            self.assertEqual(r['status'],'FAIL')
            self.assertEqual(r['observedGates'],1)
            self.assertEqual(json.loads((pathlib.Path(d)/'report.json').read_text())['status'],'FAIL')

    def test_success_does_not_claim_publication(self):
        with tempfile.TemporaryDirectory() as d:
            old=runner.gate_plan
            runner.gate_plan=lambda profile: ([], [('good',[sys.executable,'-c','print("OK")'])])
            try: r=runner.run('verify',pathlib.Path(d),heartbeat=15,timeout=60)
            finally: runner.gate_plan=old
            self.assertEqual(r['status'],'PASS')
            self.assertFalse(r['publicationPerformed'])

if __name__ == '__main__': unittest.main()
