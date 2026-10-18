#!/usr/bin/env python3
"""Conservative qualification planner: concurrent pure unit gates, serial stateful gates.

Do not replace full verify: the original npm run verify runs unchanged, exactly once.
No external publication, caching, test exclusions, branch mutations or provider inference.
"""
from __future__ import annotations
import argparse
import concurrent.futures
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = ROOT / 'data/runtime/smoke-results/timed-qualification'
LOCK = threading.Lock()
BANNER = re.compile(r'^> (?:eveos@[^ ]+) ([a-zA-Z0-9:_-]+)(?:\s|$)')


def clock(seconds):
    seconds = max(0, round(seconds))
    return f'{seconds // 3600:02d}:{(seconds // 60) % 60:02d}:{seconds % 60:02d}'


def say(*values):
    with LOCK:
        print(*values, flush=True)


def npm(*arguments):
    return [('npm.cmd' if os.name == 'nt' else 'npm'), *arguments]


def gate_plan(profile):
    if profile == 'verify':
        return [], [('verify', npm('run', 'verify'))]
    if profile != 'nexus':
        raise ValueError('Supported profiles: verify, nexus')
    nb = 'tools/Nexus-Browser'
    # Proven pure Node tests and syntax checking; each is a separate process.
    unit = [
        ('tui-chat-unit', ['node', '--test', f'{nb}/tests/dex-room-tui-chat.test.js']),
        ('tui-launch-unit', ['node', '--test', f'{nb}/tests/dex-room-tui-launch.test.js']),
        ('dex-any-room-unit', ['node', '--test', f'{nb}/tests/dex-room-general-send.test.js']),
        ('terminal-regression', ['node', '--test', f'{nb}/tests/dex-terminal-operator.test.js', f'{nb}/tests/dex-room-terminal-client.test.js', f'{nb}/tests/dex-terminal-routing-safety.test.js']),
        ('server-syntax', ['node', '--check', f'{nb}/server.js']),
    ]
    # UI, services, runtime, ports, builds and the full verifier stay serial.
    serial = [
        ('playwright-open-button', ['node', f'{nb}/scripts/dex-tui-ui-playwright-qualify.js']),
        ('nexus', npm('--prefix', nb, 'test')),
        ('machine-spaces', ['node', '--test', f'{nb}/tests/machine-spaces-supervised-controller-safety.test.js',
                            f'{nb}/tests/machine-spaces-supervised-ui.test.js',
                            f'{nb}/tests/machine-spaces-terminal-qualify.test.js']),
        ('ai-control', npm('run', 'test:ai-control')),
        ('security', npm('run', 'test:security')),
        ('verify', npm('run', 'verify')),
    ]
    return unit, serial


def collect_stages(log, offset, leftover, ongoing, now):
    """Incrementally discover npm script banners in the unmodified verify log."""
    if not log.exists():
        return offset, leftover, ongoing, None
    with log.open('rb') as file:
        file.seek(offset)
        chunk = file.read()
    if not chunk:
        return offset, leftover, ongoing, None
    offset += len(chunk)
    body = leftover + chunk.decode('utf-8', 'replace')
    lines = body.split('\n')
    leftover = lines.pop()
    new_stage = None
    for line in lines:
        match = BANNER.match(line.strip())
        if not match:
            continue
        name = match.group(1)
        if name == 'verify':
            continue
        if ongoing and ongoing[-1]['name'] == name:
            continue
        if ongoing and ongoing[-1].get('end') is None:
            ongoing[-1]['end'] = now
        ongoing.append({'name': name, 'start': now, 'end': None})
        new_stage = name
    return offset, leftover, ongoing, new_stage


def run_gate(label, argv, evidence, *, heartbeat=15, timeout=3600, cwd=ROOT):
    dest = evidence / f'{label}.log'
    started = time.monotonic()
    say('RUNNING', label, 'at', datetime.datetime.now().astimezone().isoformat(timespec='seconds'))
    stages = []
    last_notice = started
    offset, leftover = 0, ''
    slow_warning_issued = False
    with dest.open('wb') as log:
        try:
            process = subprocess.Popen(argv, cwd=cwd, stdout=log, stderr=subprocess.STDOUT,
                                       shell=False, stdin=subprocess.DEVNULL)
        except OSError as error:
            log.write((str(error) + '\n').encode('utf-8', 'replace'))
            return {'gate': label, 'status': 'FAIL', 'seconds': round(time.monotonic() - started, 2),
                    'exitCode': None, 'log': str(dest), 'reason': str(error), 'steps': []}
        while process.poll() is None:
            time.sleep(0.4)
            now = time.monotonic()
            if label == 'verify':
                offset, leftover, stages, step = collect_stages(dest, offset, leftover, stages, now)
                if step:
                    say('VERIFY_STEP', step, 'total_elapsed', clock(now - started))
            if now - last_notice >= heartbeat:
                current = stages[-1]['name'] if stages else 'starting'
                say('IN_PROGRESS', label, 'elapsed', clock(now - started),
                    *(('step', current) if label == 'verify' else ()))
                last_notice = now
            if now - started > timeout and not slow_warning_issued:
                # Slow advisory ONLY: do not terminate an npm command that may own nested services.
                # Only an explicit user interrupt or the command's own exit ends a stateful gate.
                say('SLOW_GATE_WARNING', label, 'elapsed', clock(now-started), 'still waiting; no process was killed')
                slow_warning_issued = True
        exit_code = process.wait()
    ended = time.monotonic()
    if label == 'verify':
        offset, leftover, stages, _ = collect_stages(dest, offset, leftover, stages, ended)
    if stages and stages[-1]['end'] is None:
        stages[-1]['end'] = ended
    summary_stages = [{'name': s['name'], 'elapsedSeconds': round((s['end'] or ended) - s['start'], 2)} for s in stages]
    status = 'PASS' if exit_code == 0 else 'FAIL'
    result = {'gate': label, 'status': status, 'seconds': round(ended - started, 2),
              'exitCode': exit_code, 'log': str(dest.relative_to(ROOT)) if dest.is_relative_to(ROOT) else str(dest), 'steps': summary_stages}
    say(status, label, 'time', clock(ended-started), 'log', result['log'])
    if status != 'PASS':
        tail = dest.read_text(encoding='utf-8', errors='replace').splitlines()[-24:]
        say('FAILURE_TAIL', label, '\n'.join(tail))
    return result


def run(profile, evidence, *, jobs=3, heartbeat=15, timeout=3600):
    unit, serial = gate_plan(profile)
    results = []
    begun = time.monotonic()
    started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    say('QUALIFICATION_STARTED', 'profile', profile, 'parallel_unit_jobs', min(jobs, len(unit)), 'evidence', evidence)
    if unit:
        say('PARALLEL_UNIT_LANE', len(unit), 'independent checks; max_workers', jobs)
        with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
            futures = {pool.submit(run_gate, label, argv, evidence, heartbeat=heartbeat, timeout=timeout): label
                       for label, argv in unit}
            for completed in concurrent.futures.as_completed(futures):
                results.append(completed.result())
        if any(item['status'] != 'PASS' for item in results):
            say('STOP', 'parallel unit lane failed; stateful and full verify gates were NOT started')
    if not any(item['status'] != 'PASS' for item in results):
        for label, argv in serial:
            result = run_gate(label, argv, evidence, heartbeat=heartbeat, timeout=timeout)
            results.append(result)
            if result['status'] != 'PASS':
                break
    all_pass = len(results) == len(unit) + len(serial) and all(item['status'] == 'PASS' for item in results)
    report = {'schema': 'eveos.timed-qualification.v1', 'profile': profile,
              'startedAt': started_at,
              'status': 'PASS' if all_pass else 'FAIL',
              'elapsedSeconds': round(time.monotonic() - begun, 2),
              'expectedGates': len(unit)+len(serial), 'observedGates': len(results),
              'unitConcurrency': min(jobs, len(unit)), 'gates': results,
              'fullVerifyUnchanged': True, 'publicationPerformed': False}
    (evidence / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    say('QUALIFICATION_'+report['status'], 'elapsed', clock(report['elapsedSeconds']),
        'gates', len(results), '/', len(unit)+len(serial), 'report', evidence / 'report.json')
    return report


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--profile', choices=['verify','nexus'], default='verify')
    p.add_argument('--jobs', type=int, choices=[1, 2, 3], default=3,
                   help='Max independent unit tests only. Never runs service or browser gates concurrently.')
    p.add_argument('--heartbeat', type=int, default=15)
    p.add_argument('--slow-warning', type=int, default=3600, dest='timeout',
                   help='Advisory only; never terminates nested service tests.')
    a = p.parse_args()
    if not (5 <= a.heartbeat <= 120) or not (60 <= a.timeout <= 14400):
        p.error('Heartbeat must be 5..120 seconds; slow-warning must be 60..14400 seconds.')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    evidence = EVIDENCE / f'{a.profile}-{stamp}'
    evidence.mkdir(parents=True, exist_ok=False)
    report = run(a.profile, evidence, jobs=a.jobs, heartbeat=a.heartbeat, timeout=a.timeout)
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
