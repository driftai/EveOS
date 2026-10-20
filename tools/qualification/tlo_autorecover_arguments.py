"""Parse explicit, bounded TLO recovery authority separately from execution."""
from __future__ import annotations

import argparse
from tlo_autorecover_core import MAX_WORKER_REPAIRS
from tlo_recovery_receipt import RETRY_SAFETY


def parse_recovery_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()

    parser.add_argument("--branch", required=True)
    parser.add_argument("--expected-head", required=True)
    parser.add_argument(
        "--allow-dirty-path",
        action="append",
        default=[],
    )
    parser.add_argument(
        "--repair-file",
        action="append",
        default=[],
    )
    parser.add_argument(
        "--context-file",
        action="append",
        default=[],
    )
    parser.add_argument(
        "--invariant",
        action="append",
        default=[],
    )
    parser.add_argument(
        "--max-attempts",
        type=int,
        default=MAX_WORKER_REPAIRS,
    )
    parser.add_argument("--preserve-file", action="append", default=[])
    parser.add_argument("--retry-safety", choices=sorted(RETRY_SAFETY), default="never")
    parser.add_argument(
        "command",
        nargs=argparse.REMAINDER,
    )

    args = parser.parse_args(argv)
    return args
