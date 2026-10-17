#!/usr/bin/env python3
"""Complete V0.7.1A task-completion notification/restart observability."""

from __future__ import annotations

import codecs
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

BRANCH = "eve/nexus-machine-spaces"
BASE = "9836e39ebac52bb2a5099f6725ac6055b3dc3fd8"

RUNNER = "tools/qualification/tlo_handoff_rehearsal.py"
SUPERVISOR = "tools/qualification/tlo_autorecover.py"
SELF = "tools/qualification/v071a_notification_restart_slice.py"
SUPPORT = "tools/qualification/tlo_rehearsal_support.py"
AUTORECOVER_TEST = "tools/qualification/tlo_autorecover_policy_test.py"
HYGIENE = "tools/qualification/text_hygiene.py"

JOURNAL = "tools/Nexus-Browser/dex/task-completion-journal.js"
TEST = "tools/Nexus-Browser/tests/dex-task-completion-lifecycle-restart.test.js"
WIRING = "tools/Nexus-Browser/tests/dex-task-completion-wiring.test.js"
LEGACY = "tools/Nexus-Browser/tests/task-completion-lifecycle.test.js"

CANDIDATE_PATHS = [
    JOURNAL,
    TEST,
    LEGACY,
    SUPERVISOR,
    SELF,
    SUPPORT,
    AUTORECOVER_TEST,
    HYGIENE,
]


def run(command: list[str], *, check: bool = True, timeout: int = 1200):
    result = subprocess.run(
        command,
        cwd=str(ROOT),
        text=True,
        capture_output=True,
        errors="replace",
        timeout=timeout,
        check=False,
    )

    if result.stdout:
        print(result.stdout, end="" if result.stdout.endswith("\n") else "\n")

    if result.stderr:
        print(
            result.stderr,
            file=sys.stderr,
            end="" if result.stderr.endswith("\n") else "\n",
        )

    if check and result.returncode != 0:
        raise RuntimeError(
            f"Command failed ({result.returncode}): {' '.join(command)}"
        )

    return result


def git(*args: str) -> str:
    result = run(
        ["git", *args],
        check=True,
        timeout=180,
    )
    return result.stdout.strip()


def dirty_paths() -> list[str]:
    modified = run(
        ["git", "diff", "--name-only", "HEAD", "--"],
        check=True,
    ).stdout.splitlines()

    untracked = run(
        ["git", "ls-files", "--others", "--exclude-standard"],
        check=True,
    ).stdout.splitlines()

    return sorted({
        item.strip().replace("\\", "/")
        for item in modified + untracked
        if item.strip()
    })


def guard_precommit() -> None:
    run(
        ["git", "fetch", "--quiet", "origin", BRANCH],
        timeout=180,
    )

    branch = git("branch", "--show-current")
    head = git("rev-parse", "HEAD")
    remote = git("rev-parse", f"origin/{BRANCH}")

    if branch != BRANCH:
        raise RuntimeError(f"Wrong branch: {branch}")

    if head != BASE or remote != BASE:
        raise RuntimeError(
            f"Authority moved: local={head} remote={remote} expected={BASE}"
        )

    dirty = set(dirty_paths())
    unexpected = dirty - set(CANDIDATE_PATHS)

    if unexpected:
        raise RuntimeError(
            "Unexpected dirty paths: " + ", ".join(sorted(unexpected))
        )


def decode(path: Path):
    raw = path.read_bytes()
    bom = raw.startswith(codecs.BOM_UTF8)

    if bom:
        raw = raw[len(codecs.BOM_UTF8):]

    crlf = b"\r\n" in raw

    text = (
        raw.decode("utf-8")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
    )

    return text, crlf, bom


def encode(path: Path, text: str, crlf: bool, bom: bool):
    if crlf:
        text = text.replace("\n", "\r\n")

    raw = text.encode("utf-8")

    if bom:
        raw = codecs.BOM_UTF8 + raw

    path.write_bytes(raw)


def ensure_replace(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text

    count = text.count(old)

    if count != 1:
        raise RuntimeError(
            f"{label}: expected old anchor once, found {count}"
        )

    return text.replace(old, new, 1)


def patch_journal() -> None:
    path = ROOT / JOURNAL
    text, crlf, bom = decode(path)

    text = ensure_replace(
        text,
        "function lifecycleProjection(job) {\n",
        """function timeMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return Date.parse(String(value || ''));
}
function stageAgeMs(stageSince, now) {
  if (!stageSince) return null;
  const started = timeMs(stageSince), current = timeMs(now);
  if (!Number.isFinite(started) || !Number.isFinite(current)) return null;
  return Math.max(0, current - started);
}
function lifecycleProjection(job, now = Date.now()) {
""",
        "lifecycle clock",
    )

    text = ensure_replace(
        text,
        """  return {
    currentStage,
    stageSince,
    acceptedAt,
""",
        """  return {
    currentStage,
    stageSince,
    stageAgeMs: stageAgeMs(stageSince, now),
    acceptedAt,
""",
        "stage age",
    )

    text = ensure_replace(
        text,
        "function compact(job) {\n",
        "function compact(job, now = Date.now()) {\n",
        "compact clock",
    )

    text = ensure_replace(
        text,
        "    lifecycle: lifecycleProjection(job) };\n",
        "    lifecycle: lifecycleProjection(job, now) };\n",
        "compact lifecycle",
    )

    text = ensure_replace(
        text,
        """  const journal = readJournal(filePath, io);
  let recovered = false;
  const registering = new Set();
  for (const job of journal.jobs) {
    if (job.state !== 'sent-unconfirmed') continue;
    job.state = 'outcome-unknown';
    job.deliveryError = 'Server restarted after submission claim; do not automatically resend.';
    recovered = true;
  }
  const stamp = () => new Date(now()).toISOString();
  const save = () => writeJournal(filePath, journal, io);
  if (recovered) save();
""",
        """  const journal = readJournal(filePath, io);
  const stamp = () => new Date(now()).toISOString();
  const save = () => writeJournal(filePath, journal, io);
  let recovered = false;
  const registering = new Set();
  for (const job of journal.jobs) {
    if (job.state !== 'sent-unconfirmed') continue;
    job.state = 'outcome-unknown';
    job.deliveredAt = stamp();
    job.deliveryError = 'Server restarted after submission claim; do not automatically resend.';
    recovered = true;
  }
  if (recovered) save();
  const view = (job) => compact(job, now());
""",
        "restart uncertainty",
    )

    text = ensure_replace(
        text,
        "      return { ok: true, deduplicated: true, job: compact(previous) };\n",
        "      return { ok: true, deduplicated: true, job: view(previous) };\n",
        "deduplicated registration view",
    )

    text = ensure_replace(
        text,
        "    return { ok: true, job: compact(job) };\n",
        "    return { ok: true, job: view(job) };\n",
        "registration view",
    )

    text = ensure_replace(
        text,
        "    return { ok: true, jobs: jobs.slice(-16).map(compact) };\n",
        "    return { ok: true, jobs: jobs.slice(-16).map(view) };\n",
        "status view",
    )

    # Claim has its return on its own line.
    text = ensure_replace(
        text,
        """    job.state = 'sent-unconfirmed'; job.claimedAt = stamp(); save();
    return compact(job);
""",
        """    job.state = 'sent-unconfirmed'; job.claimedAt = stamp(); save();
    return view(job);
""",
        "claim view",
    )

    # ACK is intentionally kept semantically unchanged.
    text = ensure_replace(
        text,
        """    save(); return compact(job);
  }
  function uncertain(id, message) {
""",
        """    save(); return view(job);
  }
  function uncertain(id, message) {
""",
        "ack view",
    )

    text = ensure_replace(
        text,
        """  function uncertain(id, message) {
    const job = journal.jobs.find((entry) => entry.id === id);
    if (!job || job.state !== 'sent-unconfirmed') return null;
    job.state = 'outcome-unknown';
    job.deliveryError = String(message || 'Submission outcome unknown. No automatic replay.').slice(0, 160);
    save(); return compact(job);
  }
""",
        """  function uncertain(id, message) {
    const job = journal.jobs.find((entry) => entry.id === id);
    if (!job || job.state !== 'sent-unconfirmed') return null;
    job.state = 'outcome-unknown';
    job.deliveredAt = stamp();
    job.deliveryError = String(message || 'Submission outcome unknown. No automatic replay.').slice(0, 160);
    save(); return view(job);
  }
""",
        "explicit uncertainty",
    )

    text = ensure_replace(
        text,
        "  const deliveryView = (job) => ({ ...compact(job), requesterTarget: job.requesterTarget,\n",
        "  const deliveryView = (job) => ({ ...view(job), requesterTarget: job.requesterTarget,\n",
        "delivery view",
    )

    text = ensure_replace(
        text,
        "  const all = () => journal.jobs.map(compact);\n",
        "  const all = () => journal.jobs.map(view);\n",
        "all view",
    )

    text = ensure_replace(
        text,
        "    return { total: journal.jobs.length, states, latest: compact(journal.jobs.at(-1)) };\n",
        "    return { total: journal.jobs.length, states, latest: view(journal.jobs.at(-1)) };\n",
        "diagnostics view",
    )

    encode(path, text, crlf, bom)

    print("NOTIFICATION_RESTART_JOURNAL_PATCH_OK")


def tlo_test(test_path: str, dirty: list[str]) -> None:
    command = [
        sys.executable,
        str(ROOT / RUNNER),
        "--test",
        test_path,
    ]

    for path in dirty:
        command.extend([
            "--allow-dirty-path",
            path,
        ])

    result = run(
        command,
        check=False,
        timeout=900,
    )

    if result.returncode != 0:
        raise RuntimeError(
            f"TLO-qualified deterministic test RED: {test_path}"
        )


def regression_family() -> None:
    tests_dir = ROOT / "tools/Nexus-Browser/tests"

    patterns = (
        "task-completion",
        "final-delivery",
        "final-receipt",
        "final-terminal-receipt",
    )

    tests = sorted(
        path
        for path in tests_dir.glob("*.test.js")
        if any(pattern in path.name.lower() for pattern in patterns)
    )

    if not tests:
        raise RuntimeError("No relevant regression tests discovered.")

    print(f"REGRESSION FILES: {len(tests)}")

    for path in tests:
        relative = path.relative_to(ROOT).as_posix()

        print()
        print("---", path.name, "---")

        result = run(
            ["node", "--test", str(path)],
            check=False,
            timeout=600,
        )

        if result.returncode != 0:
            # Let live TLO diagnose the exact first regression failure
            # before returning control to the autorecovery supervisor.
            try:
                tlo_test(
                    relative,
                    CANDIDATE_PATHS,
                )
            except Exception:
                pass

            raise RuntimeError(
                f"Relevant regression RED: {relative}"
            )


def classify_manifest_noise() -> None:
    status = run(
        ["git", "status", "--porcelain=v1", "--untracked-files=all"],
    ).stdout.splitlines()

    if not status:
        return

    manifest = "extension/manifest.json"

    if len(status) != 1 or status[0][3:] != manifest:
        raise RuntimeError(
            "Unexpected post-commit mutation: "
            + " | ".join(status)
        )

    committed = run(
        ["git", "show", "HEAD:extension/manifest.json"],
    ).stdout

    working = (
        ROOT / manifest
    ).read_text(encoding="utf-8-sig")

    if json.loads(committed) != json.loads(working):
        raise RuntimeError(
            "Generated manifest changed semantically."
        )

    run(
        ["git", "restore", "--worktree", "--", manifest],
    )

    print("MANIFEST_FORMATTING_ONLY_RESTORED")


def main() -> int:
    guard_precommit()

    if not (ROOT / TEST).is_file():
        raise RuntimeError("Existing RED falsifier is missing.")

    if not (ROOT / SUPERVISOR).is_file():
        raise RuntimeError("Autorecovery supervisor missing.")

    patch_journal()

    run([
        sys.executable,
        AUTORECOVER_TEST,
    ])

    run([
        sys.executable,
        HYGIENE,
        *[
            path
            for path in CANDIDATE_PATHS
            if path.endswith((".js", ".py"))
        ],
    ])

    for path in (
        JOURNAL,
        TEST,
        SUPERVISOR,
        SELF,
    ):
        if path.endswith(".js"):
            run(["node", "--check", path])

    run(["git", "diff", "--check"])

    print()
    print("=== FOCUSED NOTIFICATION/RESTART -> TLO ===")

    tlo_test(
        TEST,
        CANDIDATE_PATHS,
    )

    print("FOCUSED CONTRACT: GREEN")

    print()
    print("=== DELIVERY/TASK-COMPLETION REGRESSIONS ===")

    regression_family()

    print("REGRESSION FAMILY: GREEN")

    guard_precommit()

    actual_dirty = set(dirty_paths())
    expected_dirty = set(CANDIDATE_PATHS)

    if actual_dirty != expected_dirty:
        raise RuntimeError(
            "Exact mutation fence failed. actual="
            + repr(sorted(actual_dirty))
        )

    run(["git", "diff", "--check"])

    run([
        "git",
        "add",
        "--",
        *CANDIDATE_PATHS,
    ])

    staged = set(
        run(
            ["git", "diff", "--cached", "--name-only"],
        ).stdout.splitlines()
    )

    if staged != expected_dirty:
        raise RuntimeError(
            "Staged set mismatch: "
            + repr(sorted(staged))
        )

    run(["git", "diff", "--cached", "--check"])

    run([
        "git",
        "commit",
        "-m",
        "feat(v0.7.1a): harden autonomous recovery and notification lifecycle",
    ])

    new_head = git("rev-parse", "HEAD")

    classify_manifest_noise()

    if dirty_paths():
        raise RuntimeError(
            "Worktree dirty after commit: "
            + repr(dirty_paths())
        )

    run(
        ["git", "fetch", "--quiet", "origin", BRANCH],
        timeout=180,
    )

    remote_before = git(
        "rev-parse",
        f"origin/{BRANCH}",
    )

    if remote_before != BASE:
        raise RuntimeError(
            "Remote advanced before publication."
        )

    run([
        "git",
        "push",
        "origin",
        f"refs/heads/{BRANCH}:refs/heads/{BRANCH}",
    ], timeout=600)

    run(
        ["git", "fetch", "--quiet", "origin", BRANCH],
        timeout=180,
    )

    local = git("rev-parse", "HEAD")
    remote = git("rev-parse", f"origin/{BRANCH}")

    if local != new_head or remote != new_head:
        raise RuntimeError(
            f"Exact SHA readback mismatch local={local} remote={remote}"
        )

    counts = git(
        "rev-list",
        "--left-right",
        "--count",
        f"HEAD...origin/{BRANCH}",
    ).split()

    if counts != ["0", "0"]:
        raise RuntimeError(
            "Published branch is not 0/0: "
            + repr(counts)
        )

    if dirty_paths():
        raise RuntimeError("Final worktree is dirty.")

    print()
    print("=== PUBLISHED EXACT-HEAD TLO PROOFS ===")

    tlo_test(TEST, [])
    tlo_test(WIRING, [])
    tlo_test(LEGACY, [])

    run([
        sys.executable,
        AUTORECOVER_TEST,
    ])

    print()
    print("=" * 60)
    print("TLO AUTORECOVERY + V0.7.1A NOTIFICATION SLICE: GREEN")
    print("=" * 60)
    print("HEAD:  ", new_head)
    print("REMOTE:", remote)
    print("AHEAD: ", counts[0])
    print("BEHIND:", counts[1])
    print()
    print("AUTORECOVERY:")
    print("  TLO can diagnose small failures")
    print("  TLO can propose bounded exact-text repairs")
    print("  authorized supervisor validates/applies repairs")
    print("  same worker reruns automatically")
    print("  maximum autonomous repair attempts: 3")
    print("  no TLO-provided shell/Git commands are executed")
    print("  autorepair forbidden after HEAD changes")
    print()
    print("NOTIFICATION LIFECYCLE:")
    print("  result-persisted")
    print("    -> notification-attempted")
    print("    -> delivered / failed / uncertain")
    print("  stage age observable")
    print("  restart uncertainty boundary durable")
    print("  uncertain delivery remains non-replayable")
    print()
    print("MAIN:      UNTOUCHED")
    print("ALVIGODOP: UNTOUCHED")
    print("=" * 60)

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(
            f"V071A_WORKER_STOP: {exc}",
            file=sys.stderr,
        )
        raise SystemExit(1)
