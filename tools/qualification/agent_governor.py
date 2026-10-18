#!/usr/bin/env python3
"""Durable, quota-aware Codex execution / qualification / explicit guarded publication.

New run requires a clean, exact Git baseline. No automatic replay of a dispatched
Codex command. Resuming qualification or publication is a separate explicit action.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from agent_governor_policy import choose, quota_decision, burn_observation, load_history

BRANCH = 'eve/nexus-machine-spaces'
GATES = [
    ('governor', ['python', '-B', 'tools/qualification/agent_governor_test.py']),
    ('nexus', ['npm', '--prefix', 'tools/Nexus-Browser', 'test']),
    ('ai-control', ['npm', 'run', '--silent', 'test:ai-control']),
    ('security', ['npm', 'run', '--silent', 'test:security']),
    ('verify', ['npm', 'run', 'verify']),
]


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path: Path, value: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f'.{os.getpid()}.tmp')
    with tmp.open('w', encoding='utf-8') as stream:
        json.dump(value, stream, sort_keys=True, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, path)


def event(folder: Path, receipt: dict, status: str, **details):
    receipt.update({'state': status, 'updatedAt': now_iso()})
    receipt.update(details)
    atomic_json(folder / 'receipt.json', receipt)
    row = {'at': receipt['updatedAt'], 'state': status}
    with (folder / 'events.jsonl').open('a', encoding='utf-8') as log:
        log.write(json.dumps(row, sort_keys=True) + '\n')
        log.flush()
        os.fsync(log.fileno())
    print('GOVERNOR', status, flush=True)


def command(argv: list[str], *, cwd: Path, timeout=90, stdout=None, stdin=None):
    command_line = [shutil.which(argv[0]) or argv[0], *argv[1:]]
    return subprocess.run(command_line, cwd=str(cwd), input=stdin, stdout=stdout or subprocess.PIPE,
                          stderr=subprocess.PIPE if stdout is None else subprocess.STDOUT,
                          text=stdout is None, timeout=timeout, check=False)


def git(repo: Path, *args: str) -> str:
    result = command(['git', *args], cwd=repo, timeout=30)
    if result.returncode:
        raise RuntimeError('GIT_COMMAND_FAILED: ' + args[0])
    return result.stdout.rstrip('\r\n')  # Preserve leading Git porcelain status columns.


def remote_sha(repo: Path, branch=BRANCH):
    result = git(repo, 'ls-remote', '--heads', 'origin', f'refs/heads/{branch}').splitlines()
    if len(result) != 1:
        raise RuntimeError('REMOTE_NOT_UNIQUE')
    return result[0].split()[0]


def verify_baseline(repo: Path, expected_head: str, *, clean: bool, branch=BRANCH):
    if git(repo, 'branch', '--show-current') != branch or git(repo, 'rev-parse', 'HEAD') != expected_head:
        raise RuntimeError('UNEXPECTED_BRANCH_OR_HEAD')
    if clean and git(repo, 'status', '--porcelain=v1', '--untracked-files=all'):
        raise RuntimeError('NONEMPTY_WORKTREE')
    if not (repo / 'tools/hooks/pre-push').is_file():
        raise RuntimeError('PUBLICATION_HOOK_NOT_FOUND')


def changed_files(repo: Path):
    raw = git(repo, 'status', '--porcelain=v1', '--untracked-files=all')
    rows = [line for line in raw.splitlines() if line]
    if any(line[:2] not in (' M', 'M ', '??') or ' -> ' in line for line in rows):
        raise RuntimeError('UNSUPPORTED_GIT_CHANGE_TYPE')
    return sorted(line[3:].strip('"') for line in rows)


def allowable_files(repo: Path, authorized: list[str]) -> list[str]:
    real = changed_files(repo)
    if not real:
        raise RuntimeError('NO_CODE_CHANGES_TO_QUALIFY')
    if set(real) != set(authorized):
        raise RuntimeError('UNAUTHORIZED_FILE_SET')
    for name in real:
        target = (repo / name).resolve()
        if not target.is_relative_to(repo.resolve()) or not target.is_file() or target.is_symlink():
            raise RuntimeError('UNSAFE_WORKTREE_PATH')
        if name.startswith('data/runtime/') or name.startswith('.git/'):
            raise RuntimeError('RUNTIME_OR_GIT_PATH_FORBIDDEN')
    return real


def hash_files(repo: Path, paths: list[str]) -> dict:
    return {p: hashlib.sha256((repo / p).read_bytes()).hexdigest() for p in paths}


def quota(repo: Path, folder: Path, label: str) -> dict:
    script = 'tools/Nexus-Browser/scripts/codex-quota-cli.js'
    result = command(['node', script, '--require-fresh'], cwd=repo, timeout=20)
    try:
        out = json.loads(result.stdout)
    except (ValueError, TypeError):
        out = {'state': 'UNAVAILABLE', 'reason': 'NO_VALID_QUOTA_OUTPUT'}
    atomic_json(folder / (label + '-quota.json'), out)
    return out


def codex_command(repo: Path, folder: Path, plan: dict) -> list[str]:
    from codex_exec_bootstrap import check_contract, find_codex_executable, build_argv
    exe = find_codex_executable()
    if not exe:
        raise RuntimeError('CODEX_EXECUTABLE_UNAVAILABLE')
    check_contract(exe)
    help_result = command([exe, 'exec', '--help'], cwd=repo, timeout=15)
    help_text = (help_result.stdout or '') + '\n' + (help_result.stderr or '')
    if help_result.returncode or ('--model' not in help_text and '-m' not in help_text) or ('--config' not in help_text and '-c' not in help_text):
        raise RuntimeError('CODEX_MODEL_EFFORT_FLAGS_UNAVAILABLE')
    base = build_argv(exe, repo, folder / 'codex-final.txt')
    if base[-1] != '-':
        raise RuntimeError('UNEXPECTED_CODEX_BOOTSTRAP_LAYOUT')
    return [*base[:-1], '--model', plan['model'], '--config', f'model_reasoning_effort="{plan["effort"]}"', '-']


def run_codex(repo: Path, folder: Path, mission: Path, plan: dict):
    cmd = codex_command(repo, folder, plan)
    with mission.open('rb') as inp, (folder / 'codex-run.log').open('wb') as out:
        proc = subprocess.run(cmd, cwd=repo, stdin=inp, stdout=out, stderr=subprocess.STDOUT, check=False)
    return proc.returncode



def observed_codex_identity(log_path: Path) -> dict:
    """Check the actual model/effort that Codex wrote in its startup header."""
    try:
        with log_path.open('rb') as f:
            head = f.read(12000).decode('utf-8', errors='replace')
    except OSError:
        return {'model': None, 'effort': None}
    model = re.search(r'(?im)^\s*model:\s*([a-z0-9.-]+)\s*$', head)
    effort = re.search(r'(?im)^\s*reasoning effort:\s*([a-z0-9_-]+)\s*$', head)
    return {'model': model.group(1) if model else None,
            'effort': effort.group(1) if effort else None}


def run_gates(repo: Path, folder: Path, receipt: dict):
    event(folder, receipt, 'QUALIFYING')
    for name, args in GATES:
        with (folder / (name + '.log')).open('wb') as log:
            proc = command(args, cwd=repo, stdout=log, timeout=3600)
        if proc.returncode:
            event(folder, receipt, 'QUALIFICATION_FAILED', failedGate=name)
            return False
    event(folder, receipt, 'QUALIFIED')
    return True


def publish(repo: Path, folder: Path, receipt: dict, allowed: list[str]):
    if receipt['state'] != 'QUALIFIED':
        raise RuntimeError('NOT_QUALIFIED')
    baseline = receipt['expectedHead']
    verify_baseline(repo, baseline, clean=False)
    allowable_files(repo, allowed)
    if hash_files(repo, allowed) != receipt.get('sourceHashes'):
        raise RuntimeError('SOURCE_CHANGED_SINCE_QUALIFICATION')
    if remote_sha(repo) != baseline:
        raise RuntimeError('REMOTE_ADVANCED')
    # Git hook is mandatory, no bypass environment or alternative push route.
    if git(repo, 'config', '--local', '--get', 'core.hooksPath') != 'tools/hooks':
        raise RuntimeError('CANONICAL_HOOKS_NOT_ENABLED')
    check = command(['git', 'diff', '--check'], cwd=repo)
    if check.returncode:
        raise RuntimeError('DIFF_CHECK_FAILED')
    stage = command(['git', 'add', '--', *allowed], cwd=repo)
    if stage.returncode:
        raise RuntimeError('STAGE_FAILED')
    if sorted(git(repo, 'diff', '--cached', '--name-only').splitlines()) != sorted(allowed):
        raise RuntimeError('STAGED_FILE_SET_MISMATCH')
    event(folder, receipt, 'COMMITTING')
    commit = command(['git', 'commit', '-m', 'feat(nexus): govern Codex dispatch and quota evidence'], cwd=repo, timeout=120)
    if commit.returncode:
        raise RuntimeError('COMMIT_FAILED_PRESERVE_INDEX')
    candidate = git(repo, 'rev-parse', 'HEAD')
    event(folder, receipt, 'LOCAL_COMMIT', candidate=candidate)
    if changed_files(repo):
        raise RuntimeError('POST_COMMIT_DIRTY')
    if remote_sha(repo) != baseline:
        raise RuntimeError('REMOTE_ADVANCED_AFTER_COMMIT')
    # Pre-push hook compares against the local tracking reference.
    refspec = f'refs/heads/{BRANCH}:refs/remotes/origin/{BRANCH}'
    if command(['git', 'fetch', '--no-tags', 'origin', refspec], cwd=repo, timeout=120).returncode:
        raise RuntimeError('FETCH_FAILED')
    if git(repo, 'rev-parse', f'refs/remotes/origin/{BRANCH}') != baseline:
        raise RuntimeError('STALE_TRACKING_REFERENCE')
    push_ref = f'refs/heads/{BRANCH}:refs/heads/{BRANCH}'
    push = command(['git', 'push', 'origin', push_ref], cwd=repo, timeout=3600)
    if push.returncode:
        raise RuntimeError('PUSH_BLOCKED_LOCAL_COMMIT_PRESERVED')
    if remote_sha(repo) != candidate:
        raise RuntimeError('REMOTE_READBACK_MISMATCH')
    event(folder, receipt, 'PUBLISHED', published=candidate)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('phase', choices=['plan', 'run', 'qualify', 'publish', 'status'])
    ap.add_argument('--repo', type=Path, required=True)
    ap.add_argument('--run-dir', type=Path, required=True)
    ap.add_argument('--expected-head')
    ap.add_argument('--mission', type=Path)
    ap.add_argument('--tier', choices=list(__import__('agent_governor_policy').TIERS), default='medium')
    ap.add_argument('--effort', choices=['low', 'medium', 'high'])
    ap.add_argument('--permit-high', action='store_true')
    ap.add_argument('--allow-file', action='append', default=[])
    ap.add_argument('--authorize-publish', action='store_true')
    args = ap.parse_args(argv)
    repo, folder = args.repo.resolve(), args.run_dir.resolve()
    root = (repo / 'data/runtime/smoke-results/agent-governor').resolve()
    if not folder.is_relative_to(root) or folder == root:
        raise SystemExit('RUN_DIR_MUST_BE_UNDER_IGNORED_AGENT_GOVERNOR_ROOT')
    if args.phase == 'status':
        f = folder / 'receipt.json'
        print(f.read_text(encoding='utf-8') if f.is_file() else 'NO_RECEIPT')
        return 0
    if args.phase == 'plan':
        plan = choose(args.tier, args.effort, args.permit_high)
        print(json.dumps({'modelPolicy': plan, 'publishRequiresAuthorization': True,
                          'estimatedPlusRate': 'UNAVAILABLE_NOT_FIXED',
                          'measurement': 'account-level five-hour/weekly deltas only'}, indent=2))
        return 0
    folder.mkdir(parents=True, exist_ok=True)
    lock_path = folder / 'governor.lock'
    try:
        fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise SystemExit('LOCK_PRESENT_MANUAL_INSPECTION_REQUIRED')
    os.close(fd)
    try:
        receipt_file = folder / 'receipt.json'
        if args.phase == 'run':
            if receipt_file.exists() or not args.expected_head or not args.mission:
                raise RuntimeError('NEW_RUN_REQUIRES_UNUSED_FOLDER_HEAD_AND_MISSION')
            verify_baseline(repo, args.expected_head, clean=True)
            plan = choose(args.tier, args.effort, args.permit_high)
            mission = args.mission.resolve(strict=True)
            if not mission.is_relative_to((repo / 'data/runtime').resolve()):
                raise RuntimeError('MISSION_MUST_RESIDE_IN_IGNORED_RUNTIME')
            allowed = sorted(set(args.allow_file))
            if not allowed:
                raise RuntimeError('EXACT_ALLOW_FILE_SET_REQUIRED')
            receipt = {'schema': 'eveos.agent-governor.v1', 'expectedHead': args.expected_head,
                       'branch': BRANCH, 'plan': plan, 'allowedFiles': allowed,
                       'missionSha256': hashlib.sha256(mission.read_bytes()).hexdigest()}
            event(folder, receipt, 'PREFLIGHT')
            before = quota(repo, folder, 'before')
            decision = quota_decision(before, plan, load_history(root / 'history.jsonl'))
            receipt['dispatchDecision'] = decision
            if not decision['permitted']:
                event(folder, receipt, 'QUOTA_BLOCKED')
                return 3
            cmd = codex_command(repo, folder, plan)  # Check all flags before dispatch.
            if not cmd:
                raise RuntimeError('CODEX_COMMAND_NOT_AVAILABLE')
            event(folder, receipt, 'RUNNING')
            start = time.monotonic()
            code = run_codex(repo, folder, mission, plan)
            after = quota(repo, folder, 'after')
            observation = burn_observation(before, after, plan, time.monotonic() - start)
            observed = observed_codex_identity(folder / 'codex-run.log')
            receipt['observedCodexIdentity'] = observed
            if code or observed != {'model': plan['model'], 'effort': plan['effort']}:
                observation['valid'] = False
                observation['reason'] = 'EXECUTION_FAILED_OR_MODEL_EFFORT_UNVERIFIED'
            with (root / 'history.jsonl').open('a', encoding='utf-8') as f:
                f.write(json.dumps(observation, sort_keys=True) + '\n')
                f.flush(); os.fsync(f.fileno())
            receipt['exitCode'] = code
            receipt['burnObservationValid'] = observation['valid']
            if code:
                event(folder, receipt, 'UNKNOWN_EXECUTION_OUTCOME_NO_RETRY')
                return 4
            if observed != {'model': plan['model'], 'effort': plan['effort']}:
                event(folder, receipt, 'MODEL_OR_EFFORT_UNVERIFIED_NO_RETRY')
                return 4
            event(folder, receipt, 'EXECUTED_NOT_QUALIFIED')
        else:
            receipt = json.loads(receipt_file.read_text(encoding='utf-8'))
            if receipt.get('schema') != 'eveos.agent-governor.v1':
                raise RuntimeError('INVALID_RECEIPT')
            if args.phase == 'qualify' and receipt['state'] not in ('EXECUTED_NOT_QUALIFIED', 'QUALIFICATION_FAILED'):
                raise RuntimeError('QUALIFY_REQUIRES_COMPLETED_RUN')
            if args.phase == 'publish' and receipt['state'] != 'QUALIFIED':
                raise RuntimeError('PUBLISH_REQUIRES_QUALIFIED_RECEIPT')
        if args.phase in ('run', 'qualify'):
            verify_baseline(repo, receipt['expectedHead'], clean=False)
            allowed = allowable_files(repo, receipt['allowedFiles'])
            receipt['sourceHashes'] = hash_files(repo, allowed)
            if not run_gates(repo, folder, receipt):
                return 5
            verify_baseline(repo, receipt['expectedHead'], clean=False)
            allowable_files(repo, allowed)
            if hash_files(repo, allowed) != receipt['sourceHashes']:
                event(folder, receipt, 'SOURCE_DRIFT_AFTER_QUALIFICATION')
                return 6
        if args.phase == 'publish' or (args.phase == 'run' and args.authorize_publish):
            if not args.authorize_publish:
                raise RuntimeError('EXPLICIT_PUBLISH_AUTHORIZATION_REQUIRED')
            publish(repo, folder, receipt, receipt['allowedFiles'])
        return 0
    except Exception as exc:
        # Preserve exact evidence and any local commit; never attempt blind compensation.
        if (folder / 'receipt.json').exists():
            existing = json.loads((folder / 'receipt.json').read_text(encoding='utf-8'))
            event(folder, existing, 'STOP_REVIEW_REQUIRED', stopReason=str(exc)[:200])
        else:
            print('GOVERNOR_STOP', type(exc).__name__, str(exc)[:200], file=sys.stderr)
        return 7
    finally:
        lock_path.unlink(missing_ok=True)


if __name__ == '__main__':
    raise SystemExit(main())
