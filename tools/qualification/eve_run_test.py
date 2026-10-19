from __future__ import annotations

import argparse
import unittest
from unittest import mock

import eve_run


class EveRunTests(unittest.TestCase):
    def test_wrapper_adds_authority_and_preserves_command_arguments(self):
        args = argparse.Namespace(
            branch=None,
            expected_head=None,
            repair_file=["tools/safe.js"],
            context_file=["tools/context.js"],
            invariant=["preserve receipts"],
            max_attempts=1,
            retry_safety="idempotent",
            command=["--", "node", "tools/test.js", "arg with space"],
        )
        with mock.patch.object(eve_run, "git_text", side_effect=["eve/nexus-machine-spaces", "a" * 40]):
            built = eve_run.build_autorecover_argv(args)
        self.assertEqual(built[:4], ["--branch", "eve/nexus-machine-spaces", "--expected-head", "a" * 40])
        self.assertIn("--allow-dirty-path", built)
        self.assertEqual(built[built.index("--") + 1:], ["node", "tools/test.js", "arg with space"])

    def test_detached_head_is_rejected_without_explicit_branch(self):
        args = argparse.Namespace(branch=None, expected_head="a" * 40, repair_file=["x"],
            context_file=[], invariant=[], max_attempts=1, retry_safety="never",
            command=["--", "node", "x.js"])
        with mock.patch.object(eve_run, "git_text", return_value=""):
            with self.assertRaisesRegex(RuntimeError, "Detached HEAD"):
                eve_run.build_autorecover_argv(args)


if __name__ == "__main__":
    unittest.main()
