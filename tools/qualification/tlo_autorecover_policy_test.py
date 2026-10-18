#!/usr/bin/env python3

import copy
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

import tlo_autorecover as ar
import tlo_autorecover_workflow as workflow
import tlo_rehearsal_support as support
import text_hygiene as th


class TloAutorecoveryPolicyTest(unittest.TestCase):

    def test_safe_label_cannot_hide_missing_evidence(self):
        plan = {
            "classification": "SAFE_SMALL_RECOVERY",
            "confidence": "high",
            "reason": (
                "The source evidence is cut off. "
                "I need to see the full implementation."
            ),
            "evidenceRequest": "",
            "edits": [],
            "rerunSameCommand": False,
        }

        self.assertTrue(
            ar.evidence_deficit(plan)
        )

    def test_explicit_evidence_request_wins_over_label(self):
        plan = {
            "classification": "SAFE_SMALL_RECOVERY",
            "confidence": "high",
            "reason": "Likely small recovery.",
            "evidenceRequest": (
                "Show the lifecycleProjection implementation."
            ),
            "edits": [],
            "rerunSameCommand": False,
        }

        self.assertTrue(
            ar.evidence_deficit(plan)
        )

    def test_real_safe_plan_is_not_evidence_deficit(self):
        plan = {
            "classification": "SAFE_SMALL_RECOVERY",
            "confidence": "high",
            "reason": "Exact stale compatibility fixture.",
            "evidenceRequest": "",
            "edits": [
                {
                    "path": (
                        "tools/Nexus-Browser/tests/"
                        "task-completion-lifecycle.test.js"
                    ),
                    "old": "old",
                    "new": "new",
                }
            ],
            "rerunSameCommand": True,
        }

        self.assertFalse(
            ar.evidence_deficit(plan)
        )

    def test_invalid_safe_plan_is_retryable_proposal_rejection(self):
        with self.assertRaises(
            ar.RepairProposalRejected
        ):
            ar.validate_plan(
                {
                    "classification": "SAFE_SMALL_RECOVERY",
                    "confidence": "high",
                    "reason": "Small change.",
                    "evidenceRequest": "",
                    "edits": [],
                    "rerunSameCommand": False,
                },
                {
                    "tools/Nexus-Browser/tests/"
                    "task-completion-lifecycle.test.js"
                },
            )

    def test_balanced_json_extraction_survives_model_prose(self):
        value = support.parse_json_object(
            'Here is the result:\n```json\n'
            '{"classification":"SAFE_SMALL_RECOVERY",'
            '"reason":"brace { inside string }"}'
            '\n```\nDone.'
        )

        self.assertEqual(
            value["classification"],
            "SAFE_SMALL_RECOVERY",
        )

    def test_terminal_blank_lines_normalize_idempotently(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "candidate.js"

            path.write_bytes(
                b"const x = 1;\n\n\n"
            )

            self.assertTrue(
                th.normalize_terminal_newline(path)
            )

            self.assertEqual(
                path.read_bytes(),
                b"const x = 1;\n",
            )

            self.assertFalse(
                th.normalize_terminal_newline(path)
            )

    def test_symbol_context_contains_current_lifecycle_contract(self):
        score, content = ar.snippet(
            "tools/Nexus-Browser/dex/"
            "task-completion-journal.js",
            [
                "lifecycleProjection",
                "stageAgeMs",
            ],
        )

        self.assertGreater(score, 0)
        self.assertIn(
            "lifecycleProjection",
            content,
        )
        self.assertIn(
            "stageAgeMs",
            content,
        )

    def test_success_revalidates_authority_before_green(self):
        authority_calls = []
        receipts = []

        def authority_guard(*args):
            authority_calls.append(args)
            if len(authority_calls) == 2:
                raise RuntimeError("post-run authority drift")

        def write_json(_path, value):
            receipts.append(copy.deepcopy(value))

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            argv = [
                "tlo_autorecover.py",
                "--branch", "eve/test",
                "--expected-head", "expected-head",
                "--allow-dirty-path", "candidate.js",
                "--repair-file", "candidate.js",
                "--", "python", "fake-worker.py",
            ]
            with (
                mock.patch.object(sys, "argv", argv),
                mock.patch.object(workflow, "ROOT", root),
                mock.patch.object(workflow, "RESULT_DIR", root / "results"),
                mock.patch.object(workflow, "rel", side_effect=lambda value: value),
                mock.patch.object(workflow, "validate_tlo"),
                mock.patch.object(workflow, "authority_guard", side_effect=authority_guard),
                mock.patch.object(workflow, "run", return_value={
                    "status": 0, "stdout": "", "stderr": "", "durationMs": 1,
                }),
                mock.patch.object(workflow, "write_json", side_effect=write_json),
                mock.patch("sys.stdout", new_callable=io.StringIO),
            ):
                with self.assertRaisesRegex(RuntimeError, "post-run authority drift"):
                    workflow.main()

        self.assertEqual(len(authority_calls), 2)
        self.assertFalse(any(receipt.get("outcome") == "GREEN" for receipt in receipts))


def main():
    stream = io.StringIO()
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(TloAutorecoveryPolicyTest)
    result = unittest.TextTestRunner(stream=stream, verbosity=2).run(suite)
    if result.wasSuccessful():
        print(f"TLO_AUTORECOVERY_POLICY_TEST_OK ({result.testsRun}/{result.testsRun})")
        return 0

    artifact = Path(__file__).resolve().parents[2] / "data" / "runtime" / "smoke-results" / "tlo-autorecovery-policy-failure.txt"
    artifact.parent.mkdir(parents=True, exist_ok=True)
    artifact.write_text(stream.getvalue(), encoding="utf-8")
    print("TLO_AUTORECOVERY_POLICY_TEST_FAIL", file=sys.stderr)
    for test, _traceback in result.failures + result.errors:
        print(f"FAIL {test.id()}", file=sys.stderr)
    print(f"DIAGNOSTIC {artifact.relative_to(Path(__file__).resolve().parents[2]).as_posix()}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
