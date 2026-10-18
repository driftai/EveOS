#!/usr/bin/env python3
"""Timed, fail-closed EveOS qualification with conservative resource locking.

Full release still invokes the canonical, uncached ``npm run verify`` unchanged.
Fast/affected/integration are explicitly narrower evidence profiles and never claim
release qualification. Dynamic browser/service/provider results are never cached.
"""
from __future__ import annotations
import argparse
import concurrent.futures
import contextlib
import datetime
import io
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
PRINT_LOCK = threading.Lock()
BANNER = re.compile(r'^> (?:eveos@[^ ]+) ([a-zA-Z0-9:_-]+)(?:\s|$)')
RETRY = re.compile(r'\bretr(?:y|ies|ying)\b', re.I)
TIMEOUT = re.compile(r'\btime(?:d?\s*out|out)\b', re.I)


def clock(seconds):
    seconds = max(0, round(seconds))
    return f'{seconds // 3600:02d}:{(seconds // 60) % 60:02d}:{seconds % 60:02d}'


def say(*values):
    with PRINT_LOCK:
        print(*values, flush=True)


def npm(*arguments):
    return [('npm.cmd' if os.name == 'nt' else 'npm'), *arguments]


def gate(label, argv, resources=()):
    return {'label': label, 'argv': argv, 'resources': sorted(set(resources))}


def changed_files(base):
    names = set()
    for argv in (['git', 'diff', '--name-only', f'{base}...HEAD'],
                 ['git', 'diff', '--name-only'], ['git', 'diff', '--name-only', '--cached']):
        result = subprocess.run(argv, cwd=ROOT, text=True, capture_output=True, check=False)
        if result.returncode == 0:
            names.update(line.strip().replace('\\', '/') for line in result.stdout.splitlines() if line.strip())
    status = subprocess.run(['git', 'status', '--porcelain'], cwd=ROOT, text=True,
                            capture_output=True, check=False)
    if status.returncode == 0:
        names.update(line[3:].strip().replace('\\', '/') for line in status.stdout.splitlines() if len(line) > 3)
    return sorted(names)


def affected_plan(base):
    files = changed_files(base)
    serial = [gate('guardrails', npm('run', '--silent', 'test:guardrails'), ('build-output',))]
    paths, labels = '\n'.join(files).lower(), set()
    if 'audioflix' in paths:
        if 'spotify' in paths:
            serial.append(gate('audioflix-spotify-managed', npm('run', '--silent', 'smoke:audioflix-spotify-managed'),
                               ('audioflix-runtime', 'playwright')))
            serial.append(gate('audioflix-spotify-playback', npm('run', '--silent', 'smoke:audioflix-spotify-playback'),
                               ('audioflix-runtime', 'playwright')))
            labels.add('audioflix-spotify')
        serial.append(gate('audioflix-playback', npm('run', '--silent', 'smoke:audioflix-playback'),
                           ('audioflix-runtime', 'playwright')))
        labels.add('audioflix')
    if 'tools/nexus-browser/' in paths or '/nexus/' in paths or 'machine_spaces' in paths:
        serial.append(gate('ai-control', npm('run', '--silent', 'test:ai-control'),
                           ('nexus-runtime', 'playwright', 'ports')))
        labels.add('nexus')
    if any(token in paths for token in ('server_modules/', 'server/', 'js/modules/core/', 'state-sync')):
        serial.append(gate('deep', npm('run', '--silent', 'test:deep'), ('services', 'ports', 'playwright')))
        labels.add('shared-runtime')
    if not labels:
        serial.append(gate('fast', npm('run', '--silent', 'test:smoke'), ('build-output',)))
        labels.add('fast-fallback')
    unique, seen = [], set()
    for item in serial:
        key = tuple(item['argv'])
        if key not in seen:
            seen.add(key); unique.append(item)
    return [], unique, {'base': base, 'changedFiles': files, 'affectedClasses': sorted(labels)}


def gate_plan(profile, base='origin/main'):
    if profile in {'verify', 'release'}:
        return [], [gate('verify', npm('run', 'verify'), ('all-services', 'build-output', 'ports', 'playwright'))], {}
    if profile == 'fast':
        return [], [gate('fast', npm('run', '--silent', 'test:smoke'), ('build-output',))], {}
    if profile == 'integration':
        return [], [gate('deep', npm('run', '--silent', 'test:deep'), ('services', 'ports', 'playwright'))], {}
    if profile == 'affected':
        return affected_plan(base)
    if profile != 'nexus':
        raise ValueError('Supported profiles: fast, affected, integration, verify/release, nexus')
    nb = 'tools/Nexus-Browser'
    parallel = [
        gate('tui-chat-unit', ['node', '--test', f'{nb}/tests/dex-room-tui-chat.test.js']),
        gate('tui-launch-unit', ['node', '--test', f'{nb}/tests/dex-room-tui-launch.test.js']),
        gate('dex-any-room-unit', ['node', '--test', f'{nb}/tests/dex-room-general-send.test.js']),
        gate('terminal-regression', ['node', '--test', f'{nb}/tests/dex-terminal-operator.test.js',
             f'{nb}/tests/dex-room-terminal-client.test.js', f'{nb}/tests/dex-terminal-routing-safety.test.js']),
        gate('server-syntax', ['node', '--check', f'{nb}/server.js']),
    ]
    serial = [
        gate('playwright-open-button', ['node', f'{nb}/scripts/dex-tui-ui-playwright-qualify.js'], ('playwright',)),
        gate('nexus', npm('--prefix', nb, 'test'), ('nexus-runtime', 'ports')),
        gate('machine-spaces', ['node', '--test', f'{nb}/tests/machine-spaces-supervised-controller-safety.test.js',
             f'{nb}/tests/machine-spaces-supervised-ui.test.js', f'{nb}/tests/machine-spaces-terminal-qualify.test.js'],
             ('machine-spaces',)),
        gate('ai-control', npm('run', 'test:ai-control'), ('nexus-runtime', 'playwright', 'ports')),
        gate('security', npm('run', 'test:security'), ('ports',)),
        gate('verify', npm('run', 'verify'), ('all-services', 'build-output', 'ports', 'playwright')),
    ]
    return parallel, serial, {}


class ResourceCoordinator:
    def __init__(self):
        self._guard = threading.Lock()
        self._locks = {}

    def acquire(self, resources):
        with self._guard:
            locks = [self._locks.setdefault(name, threading.Lock()) for name in sorted(resources)]
        begun = time.monotonic()
        for lock in locks: lock.acquire()
        waited = time.monotonic() - begun
        return waited, lambda: [lock.release() for lock in reversed(locks)]


def collect_stages(log, offset, leftover, ongoing, now):
    if not log.exists(): return offset, leftover, ongoing, None
    with log.open('rb') as file:
        file.seek(offset); chunk = file.read()
    if not chunk: return offset, leftover, ongoing, None
    offset += len(chunk)
    lines = (leftover + chunk.decode('utf-8', 'replace')).split('\n')
    leftover, new_stage = lines.pop(), None
    for line in lines:
        match = BANNER.match(line.strip())
        if not match or match.group(1) == 'verify': continue
        name = match.group(1)
        if ongoing and ongoing[-1]['name'] == name: continue
        if ongoing and ongoing[-1].get('end') is None: ongoing[-1]['end'] = now
        ongoing.append({'name': name, 'start': now, 'end': None}); new_stage = name
    return offset, leftover, ongoing, new_stage


def nested_reports(started_epoch):
    reports, root = [], ROOT / 'data/runtime/smoke-results'
    for path in root.glob('**/latest.json') if root.exists() else []:
        try:
            if path.stat().st_mtime + 0.01 < started_epoch: continue
            data = json.loads(path.read_text(encoding='utf-8'))
            if data.get('schema') == 'eveos.quiet-child-suite.v1':
                reports.append({'path': str(path.relative_to(ROOT)), 'name': data.get('name'),
                                'totalSeconds': data.get('totalSeconds'), 'results': data.get('results', [])})
        except (OSError, ValueError): pass
    return reports


def run_gate(spec, evidence, *, coordinator, heartbeat=15, timeout=3600, cwd=ROOT):
    label, argv, resources = spec['label'], spec['argv'], spec.get('resources', [])
    wait_seconds, release = coordinator.acquire(resources)
    started, started_epoch, cpu_before = time.monotonic(), time.time(), os.times()
    dest = evidence / f'{label}.log'
    say('RUNNING', label, 'queue_wait', f'{wait_seconds:.3f}s', 'resources', ','.join(resources) or 'none')
    stages, last_notice, offset, leftover, slow_warning = [], started, 0, '', False
    try:
        with dest.open('wb') as log:
            try:
                process = subprocess.Popen(argv, cwd=cwd, stdout=log, stderr=subprocess.STDOUT,
                                           shell=False, stdin=subprocess.DEVNULL)
            except OSError as error:
                log.write((str(error) + '\n').encode('utf-8', 'replace'))
                return {'gate': label, 'status': 'FAIL', 'seconds': 0,
                        'queueWaitSeconds': round(wait_seconds, 3), 'exitCode': None,
                        'log': str(dest), 'reason': str(error), 'steps': [], 'execution': 'executed'}
            while process.poll() is None:
                time.sleep(0.4); now = time.monotonic()
                if label == 'verify':
                    offset, leftover, stages, step = collect_stages(dest, offset, leftover, stages, now)
                    if step: say('VERIFY_STEP', step, 'total_elapsed', clock(now-started))
                if now-last_notice >= heartbeat:
                    remaining = max(0, float(spec.get('estimateSeconds') or 0)-(now-started))
                    say('IN_PROGRESS', label, 'elapsed', clock(now-started),
                        'remaining_estimate', clock(remaining) if spec.get('estimateSeconds') else 'UNKNOWN',
                        *(('step', stages[-1]['name']) if stages else ()))
                    last_notice = now
                if now-started > timeout and not slow_warning:
                    say('SLOW_GATE_WARNING', label, clock(now-started), 'advisory only; process remains owned')
                    slow_warning = True
            exit_code = process.wait()
        ended, cpu_after = time.monotonic(), os.times()
        if label == 'verify': offset, leftover, stages, _ = collect_stages(dest, offset, leftover, stages, ended)
        if stages and stages[-1]['end'] is None: stages[-1]['end'] = ended
        text = dest.read_text(encoding='utf-8', errors='replace')
        status = 'PASS' if exit_code == 0 else 'FAIL'
        result = {'gate': label, 'status': status, 'seconds': round(ended-started, 2),
                  'queueWaitSeconds': round(wait_seconds, 3), 'resources': resources,
                  'cpuSeconds': round((cpu_after.children_user+cpu_after.children_system)
                                      -(cpu_before.children_user+cpu_before.children_system), 3),
                  'exitCode': exit_code, 'execution': 'executed', 'log': str(dest.relative_to(ROOT)),
                  'retryMentions': len(RETRY.findall(text)), 'timeoutMentions': len(TIMEOUT.findall(text)),
                  'steps': [{'name': s['name'], 'elapsedSeconds': round((s['end'] or ended)-s['start'], 2)} for s in stages],
                  'nestedReports': nested_reports(started_epoch)}
        say(status, label, 'time', clock(ended-started), 'log', result['log'])
        if status != 'PASS': say('FAILURE_TAIL', label, '\n'.join(text.splitlines()[-24:]))
        return result
    finally:
        release()


def prior_report(profile, current):
    candidates = []
    for path in EVIDENCE.glob(f'{profile}-*/report.json') if EVIDENCE.exists() else []:
        if current in path.parents: continue
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
            if data.get('profile') == profile and data.get('status') == 'PASS': candidates.append(data)
        except (OSError, ValueError): pass
    return max(candidates, key=lambda item: item.get('startedAt', ''), default=None)


def make_report(profile, evidence, results, expected, begun, started_at, jobs, metadata, interrupted=False):
    complete = len(results) == expected and all(item['status'] == 'PASS' for item in results) and not interrupted
    prior, elapsed, slow = prior_report(profile, evidence), round(time.monotonic()-begun, 2), []
    for item in results:
        slow.append({'id': item['gate'], 'seconds': item['seconds']})
        for nested in item.get('nestedReports', []):
            slow.extend({'id': f"{nested['name']}::{child['id']}", 'seconds': child['seconds']}
                        for child in nested.get('results', []))
    return {'schema': 'eveos.timed-qualification.v2', 'profile': profile, 'startedAt': started_at,
            'status': 'PASS' if complete else ('INTERRUPTED' if interrupted else 'FAIL'),
            'qualificationScope': 'full-release' if profile in {'verify', 'release'} else 'partial',
            'elapsedSeconds': elapsed, 'expectedGates': expected, 'observedGates': len(results),
            'workerLimit': jobs, 'executedChecks': len(results), 'reusedChecks': 0,
            'workerUtilization': round(sum(item.get('seconds', 0) for item in results)
                                       / max(.001, elapsed*max(1, jobs)), 3),
            'criticalPathSeconds': elapsed,
            'resourceContentionSeconds': round(sum(item.get('queueWaitSeconds', 0) for item in results), 3),
            'slowest': sorted(slow, key=lambda item: item['seconds'], reverse=True)[:12],
            'previousPassSeconds': prior.get('elapsedSeconds') if prior else None,
            'estimatedSeconds': prior.get('elapsedSeconds') if prior else None,
            'estimateBasis': 'last successful same-profile run' if prior else 'unavailable',
            'metadata': metadata, 'gates': results, 'fullVerifyUnchanged': True,
            'dynamicResultsCached': False, 'publicationPerformed': False}


def run(profile, evidence, *, jobs=3, heartbeat=15, timeout=3600, base='origin/main'):
    parallel, serial, metadata = gate_plan(profile, base)
    preflight = [gate('guardrails', npm('run', '--silent', 'test:guardrails'), ('build-output',))] if profile == 'nexus' else []
    results, coordinator, begun = [], ResourceCoordinator(), time.monotonic()
    started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    previous = prior_report(profile, evidence)
    previous_gates = {item.get('gate'): item.get('seconds') for item in (previous or {}).get('gates', [])}
    for item in [*preflight, *parallel, *serial]:
        if previous_gates.get(item['label']): item['estimateSeconds'] = previous_gates[item['label']]
    say('QUALIFICATION_STARTED', 'profile', profile, 'workers', min(jobs, max(1, len(parallel))),
        'estimate', clock(previous['elapsedSeconds']) if previous else 'UNKNOWN', 'evidence', evidence)
    interrupted = False
    try:
        for item in preflight:
            result = run_gate(item, evidence, coordinator=coordinator, heartbeat=heartbeat, timeout=timeout)
            results.append(result)
            if result['status'] != 'PASS': break
        if parallel and not any(item['status'] != 'PASS' for item in results):
            with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
                futures = [pool.submit(run_gate, item, evidence, coordinator=coordinator,
                                       heartbeat=heartbeat, timeout=timeout) for item in parallel]
                for completed in concurrent.futures.as_completed(futures): results.append(completed.result())
        if not any(item['status'] != 'PASS' for item in results):
            for item in serial:
                result = run_gate(item, evidence, coordinator=coordinator, heartbeat=heartbeat, timeout=timeout)
                results.append(result)
                if result['status'] != 'PASS': break
    except KeyboardInterrupt:
        interrupted = True; say('INTERRUPTED', 'current qualification remains incomplete')
    report = make_report(profile, evidence, results, len(preflight)+len(parallel)+len(serial), begun, started_at,
                         min(jobs, max(1, len(parallel))), metadata, interrupted)
    (evidence/'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    say('QUALIFICATION_'+report['status'], 'elapsed', clock(report['elapsedSeconds']), 'gates',
        len(results), '/', len(preflight)+len(parallel)+len(serial), 'report', evidence/'report.json')
    return report


def self_test():
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    evidence = EVIDENCE/f'self-test-{stamp}'; evidence.mkdir(parents=True)
    coordinator = ResourceCoordinator()
    sleeper = lambda label, resource, code=0: gate(label,
        [sys.executable, '-c', f'import time; time.sleep(.12); raise SystemExit({code})'], (resource,))
    with contextlib.redirect_stdout(io.StringIO()):
        begun = time.monotonic()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            serialised = list(pool.map(lambda item: run_gate(item, evidence, coordinator=coordinator, heartbeat=120),
                                       [sleeper('lock-a', 'shared'), sleeper('lock-b', 'shared')]))
        lock_elapsed = time.monotonic()-begun
        failed = run_gate(sleeper('intentional-failure', 'failure', 7), evidence,
                          coordinator=coordinator, heartbeat=120)
    assert lock_elapsed >= .20 and sum(item['queueWaitSeconds'] for item in serialised) >= .08
    assert failed['status'] == 'FAIL' and failed['exitCode'] == 7
    partial = make_report('self-test', evidence, [failed], 2, time.monotonic(),
                          datetime.datetime.now(datetime.timezone.utc).isoformat(), 2, {}, False)
    assert partial['status'] == 'FAIL' and partial['observedGates'] < partial['expectedGates']
    print('EVEOS_TIMED_QUALIFICATION_CONTRACT_OK resourceLocks=true failClosed=true partialRejected=true')
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--profile', choices=['fast','affected','integration','verify','release','nexus'], default='verify')
    p.add_argument('--base', default='origin/main', help='Git base for the affected profile only.')
    p.add_argument('--jobs', type=int, choices=[1,2,3,4], default=3)
    p.add_argument('--heartbeat', type=int, default=15)
    p.add_argument('--slow-warning', type=int, default=3600, dest='timeout')
    p.add_argument('--self-test', action='store_true')
    a = p.parse_args()
    if a.self_test: return self_test()
    if not (5 <= a.heartbeat <= 120) or not (60 <= a.timeout <= 14400):
        p.error('Heartbeat must be 5..120 seconds; slow-warning must be 60..14400 seconds.')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    evidence = EVIDENCE/f'{a.profile}-{stamp}'; evidence.mkdir(parents=True, exist_ok=False)
    report = run(a.profile, evidence, jobs=a.jobs, heartbeat=a.heartbeat, timeout=a.timeout, base=a.base)
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
