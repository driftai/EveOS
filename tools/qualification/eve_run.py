#!/usr/bin/env python3
"""Ergonomic guarded command launcher backed by TLO autorecovery."""

from __future__ import annotations

import argparse

from tlo_autorecover_workflow import main as autorecover_main
from tlo_rehearsal_support import git_text


def build_autorecover_argv(args: argparse.Namespace) -> list[str]:
    branch = args.branch or git_text("branch", "--show-current")
    expected_head = args.expected_head or git_text("rev-parse", "HEAD")
    if not branch:
        raise RuntimeError("Detached HEAD requires an explicit --branch.")
    command = list(args.command)
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        raise RuntimeError("No command supplied after --.")
    result = ["--branch", branch, "--expected-head", expected_head]
    result.extend(("--retry-safety", args.retry_safety))
    for path in args.repair_file:
        result.extend(("--allow-dirty-path", path, "--repair-file", path))
    for path in args.preserve_file:
        result.extend(("--preserve-file", path))
    for path in args.context_file:
        result.extend(("--context-file", path))
    for value in args.invariant:
        result.extend(("--invariant", value))
    result.extend(("--max-attempts", str(args.max_attempts), "--", *command))
    return result


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run one explicitly authorized command with bounded TLO repair standby."
    )
    parser.add_argument("--branch")
    parser.add_argument("--expected-head")
    parser.add_argument("--repair-file", action="append", required=True)
    parser.add_argument("--preserve-file", action="append", default=[])
    parser.add_argument("--context-file", action="append", default=[])
    parser.add_argument("--invariant", action="append", default=[])
    parser.add_argument("--max-attempts", type=int, default=1)
    parser.add_argument("--retry-safety", choices=("never", "launch-only", "idempotent"), default="never")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    print("EVE_RUN supervised command; TLO inference occurs only after a confirmed failure.")
    return autorecover_main(build_autorecover_argv(args))


if __name__ == "__main__":
    raise SystemExit(main())
