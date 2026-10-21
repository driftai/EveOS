from __future__ import annotations
import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from agent_governor_policy import choose, quota_decision, burn_observation, load_history
import agent_governor as coordinator


def quota(five=80, weekly=90, reset=None, at=None):
    at = at or datetime.now(timezone.utc)
    reset = reset or (at + timedelta(days=3)).isoformat()
    return dict(observedAt=at.isoformat(), state='AVAILABLE', incomplete=False, reached=False,
                fiveHour=dict(remainingPercent=five, resetAt=reset),
                weekly=dict(remainingPercent=weekly, resetAt=reset))


class Tests(unittest.TestCase):
    def test_safe_default_progression(self):
        self.assertEqual(choose('small')['model'], 'gpt-5.6-luna')
        self.assertEqual(choose('medium')['effort'], 'medium')
        self.assertEqual(choose('complex')['model'], 'gpt-5.6-sol')
        for level in ('ultra', 'max', 'xhigh'):
            with self.assertRaises(ValueError): choose('complex', level)
        with self.assertRaises(ValueError): choose('complex', 'high')
        self.assertEqual(choose('complex', 'high', permit_high=True)['effort'], 'high')

    def test_strict_capacity(self):
        p = choose('complex')
        self.assertFalse(quota_decision(quota(15, 80), p)['permitted'])
        self.assertTrue(quota_decision(quota(20, 80), p)['permitted'])
        self.assertFalse(quota_decision({'state': 'UNAVAILABLE'}, p)['permitted'])
        self.assertFalse(quota_decision(quota(90, 2), p)['permitted'])

    def test_burn_delta_after_account_observation(self):
        at = datetime.now(timezone.utc)
        a, b = quota(80, 90, at=at), quota(78, 89, at=at)
        value = burn_observation(a, b, choose('medium'), 30)
        self.assertTrue(value['valid'])
        self.assertEqual(value['windows']['fiveHour'], 2)
        self.assertIn('concurrent', value['caveat'])

    def test_reset_never_calibrates(self):
        at = datetime.now(timezone.utc)
        a, b = quota(80, 90, at=at), quota(100, 100, at=at)
        self.assertFalse(burn_observation(a, b, choose('medium'), 1)['valid'])
        b['fiveHour']['resetAt'] = '2027-01-01T00:00:00+00:00'
        self.assertFalse(burn_observation(a, b, choose('medium'), 1)['valid'])

    def test_empirical_reserve_requires_three_observations(self):
        p = choose('small')
        samples = [dict(model=p['model'], effort=p['effort'], valid=True, windows={'fiveHour': 10, 'weekly': 8}) for _ in range(3)]
        self.assertEqual(quota_decision(quota(15, 80), p, samples[:2])['reserve'], 6)
        self.assertGreater(quota_decision(quota(15, 80), p, samples)['reserve'], 6)

    def test_atomic_receipt_and_event_log(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            state = {}
            coordinator.event(root, state, 'PREFLIGHT')
            coordinator.event(root, state, 'RUNNING')
            self.assertEqual(json.loads((root / 'receipt.json').read_text())['state'], 'RUNNING')
            self.assertEqual(len((root / 'events.jsonl').read_text().splitlines()), 2)

    def test_git_porcelain_preserves_leading_status_column(self):
        from unittest.mock import patch
        class Result:
            returncode = 0
            stdout = ' M package.json\n?? tools/qualification/new.py\n'
        with patch.object(coordinator, 'command', return_value=Result()):
            self.assertEqual(coordinator.changed_files(Path('.')),
                             ['package.json', 'tools/qualification/new.py'])

    def test_rejects_unauthorized_paths(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'x.py').write_text('hi')
            old = coordinator.changed_files
            try:
                coordinator.changed_files = lambda _, exclude=None: ['x.py']
                with self.assertRaisesRegex(RuntimeError, 'UNAUTHORIZED'):
                    coordinator.allowable_files(root, ['y.py'])
                self.assertEqual(coordinator.allowable_files(root, ['x.py']), ['x.py'])
            finally:
                coordinator.changed_files = old

    def test_actual_codex_model_and_effort_are_read_from_log_header(self):
        with tempfile.TemporaryDirectory() as d:
            file = Path(d) / 'codex-run.log'
            file.write_text('Codex startup\nmodel: gpt-5.6-terra\nreasoning effort: medium\n')
            self.assertEqual(coordinator.observed_codex_identity(file), {'model': 'gpt-5.6-terra', 'effort': 'medium'})
            file.write_text('no model evidence')
            self.assertIsNone(coordinator.observed_codex_identity(file)['model'])

    def test_push_is_explicit_named_ref_no_force(self):
        import inspect
        source = inspect.getsource(coordinator.publish)
        self.assertIn("refs/heads/{BRANCH}:refs/heads/{BRANCH}", source)
        self.assertNotIn('force', source)
        self.assertIn('CANONICAL_HOOKS_NOT_ENABLED', source)

    def test_preserved_files_are_excluded_but_hash_fenced(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'source.py').write_text('source')
            (root / 'draft.md').write_text('draft')
            old = coordinator.changed_files
            try:
                coordinator.changed_files = lambda _, exclude=None: [
                    name for name in ['draft.md', 'source.py'] if name not in (exclude or [])]
                self.assertEqual(coordinator.allowable_files(root, ['source.py'], ['draft.md']), ['source.py'])
                hashes = coordinator.hash_files(root, ['draft.md'])
                coordinator.verify_preserved(root, ['draft.md'], hashes)
                (root / 'draft.md').write_text('changed')
                with self.assertRaisesRegex(RuntimeError, 'PRESERVED_FILE_CHANGED'):
                    coordinator.verify_preserved(root, ['draft.md'], hashes)
            finally:
                coordinator.changed_files = old

    def test_preserved_draft_is_shelved_for_push_hook_and_restored_exactly(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            subprocess.run(['git', 'init', '-q'], cwd=root, check=True)
            subprocess.run(['git', 'config', 'user.name', 'Fixture'], cwd=root, check=True)
            subprocess.run(['git', 'config', 'user.email', 'fixture@example.invalid'], cwd=root, check=True)
            (root / 'source.py').write_text('source\n')
            (root / 'draft.md').write_text('baseline\n')
            subprocess.run(['git', 'add', '.'], cwd=root, check=True)
            subprocess.run(['git', 'commit', '-qm', 'baseline'], cwd=root, check=True)
            (root / 'draft.md').write_text('unfinished user draft\n')
            hashes = coordinator.hash_files(root, ['draft.md'])
            shelf = coordinator.shelf_preserved(root, root / 'run-1', ['draft.md'])
            self.assertEqual(coordinator.changed_files(root), [])
            coordinator.restore_preserved(root, shelf, hashes)
            self.assertEqual((root / 'draft.md').read_text(), 'unfinished user draft\n')
            self.assertEqual(coordinator.changed_files(root), ['draft.md'])
            self.assertNotEqual(subprocess.run(
                ['git', 'rev-parse', '--verify', 'refs/stash'], cwd=root,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode, 0)


if __name__ == '__main__': unittest.main(verbosity=2)
