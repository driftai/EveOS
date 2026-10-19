from __future__ import annotations

import unittest

from tlo_recovery_receipt import create_receipt, retry_disposition, transition


class RecoveryReceiptTests(unittest.TestCase):
    def test_retry_contract_is_fail_closed(self):
        self.assertEqual(retry_disposition("never", {"started": True, "failureClass": "process-exit"}),
                         (False, "AWAITING_APPROVAL"))
        self.assertEqual(retry_disposition("launch-only", {"started": False, "failureClass": "launch-failure"}),
                         (True, "RETRY_ELIGIBLE"))
        self.assertEqual(retry_disposition("launch-only", {"started": True, "failureClass": "process-exit"}),
                         (False, "AWAITING_APPROVAL"))
        self.assertEqual(retry_disposition("idempotent", {"started": True, "failureClass": "process-exit"}),
                         (True, "RETRY_ELIGIBLE"))

    def test_timeout_is_never_replayed_automatically(self):
        self.assertEqual(retry_disposition("idempotent", {
            "started": True, "failureClass": "timeout-outcome-unknown",
        }), (False, "OUTCOME_UNKNOWN"))

    def test_versioned_receipt_keeps_ordered_lifecycle(self):
        receipt = create_receipt(run_id="run", branch="branch", expected_head="head", command=["x"],
            repair_files=["x"], context_files=["x"], invariants=[], retry_safety="never")
        transition(receipt, "PREFLIGHT")
        transition(receipt, "DISPATCHED", attempt=1)
        self.assertEqual(receipt["schemaVersion"], 3)
        self.assertEqual([row["state"] for row in receipt["events"]], ["CREATED", "PREFLIGHT", "DISPATCHED"])


if __name__ == "__main__":
    unittest.main()
