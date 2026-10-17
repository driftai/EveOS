#!/usr/bin/env python3

from pathlib import Path

import tempfile
import unittest

import tlo_autorecover as ar
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
