#!/usr/bin/env python3
"""Cheap, mutation-tested protection for durable EveOS engineering invariants."""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
import statistics
import subprocess
import sys

from eveos_qualification_manifest import ROOT, load_manifest, load_package, validate_manifest


REGISTRY_PATH = Path(__file__).with_name('eveos_engineering_safeguards.v1.json')
REPORT_ROOT = ROOT / 'data/runtime/smoke-results/timed-qualification'
ENTRYPOINT = 'python -B tools/qualification/eveos_engineering_safeguards.py --self-test'


def load_registry(path=None):
    return json.loads((Path(path) if path else REGISTRY_PATH).read_text(encoding='utf-8'))


def qualification_entry(registry):
    matches = [item for item in registry.get('invariants', [])
               if item.get('id') == 'qualification-engine-v3-release-authority']
    if len(matches) != 1: raise ValueError('registry must contain one qualification-v3 authority entry')
    return matches[0]


def validate_registry(registry):
    errors = []
    if registry.get('schema') != 'eveos.engineering-safeguards.v1':
        errors.append('registry schema must be eveos.engineering-safeguards.v1')
    if not isinstance(registry.get('version'), int) or registry.get('version', 0) < 1:
        errors.append('registry version must be a positive integer')
    ids = set()
    required = {'id', 'owner', 'authoritativeTests', 'originalProblem', 'validatedBehavior',
                'recoveryRef', 'performance', 'intentionalUpgrade'}
    for item in registry.get('invariants', []):
        missing = sorted(required-set(item))
        if missing: errors.append(f"invariant {item.get('id', '<unknown>')} lacks {', '.join(missing)}")
        if item.get('id') in ids: errors.append(f"duplicate invariant id: {item.get('id')}")
        ids.add(item.get('id'))
        if not item.get('authoritativeTests'): errors.append(f"invariant {item.get('id')} has no authoritative tests")
        if not __import__('re').fullmatch(r'[0-9a-f]{40}', str(item.get('recoveryRef', ''))):
            errors.append(f"invariant {item.get('id')} recoveryRef must be a full Git SHA")
    return errors


def current_errors(registry=None, package=None, manifest=None, *, check_git=True):
    registry, package, manifest = registry or load_registry(), package or load_package(), manifest or load_manifest()
    errors = validate_registry(registry); scripts = package.get('scripts') or {}
    try: entry = qualification_entry(registry)
    except ValueError as error: return [*errors, str(error)]
    if scripts.get('verify') != 'python -B tools/qualification/eveos_timed_qualification.py --profile verify':
        errors.append('npm run verify no longer invokes the authoritative full-release engine')
    if not scripts.get('verify:legacy'):
        errors.append('npm run verify:legacy comparison oracle is missing')
    if scripts.get('smoke:engineering-safeguards-contract') != ENTRYPOINT:
        errors.append('engineering safeguards entrypoint drifted or was removed')
    guardrails = scripts.get('test:guardrails', '')
    for required in entry.get('authoritativeTests', []):
        if f'npm run --silent {required}' not in guardrails:
            errors.append(f'test:guardrails lost authoritative regression: {required}')
    try:
        validated = validate_manifest(manifest, package)
        if validated['legacyObligations'] != entry.get('requiredObligations'):
            errors.append('release obligation count changed without updating the safeguards registry')
    except (ValueError, KeyError) as error:
        errors.append(f'qualification manifest parity failed: {error}')
    if check_git and not errors:
        recovery = entry['recoveryRef']+'^{commit}'
        exists = subprocess.run(['git', 'cat-file', '-e', recovery], cwd=ROOT,
                                capture_output=True, check=False)
        if exists.returncode != 0: errors.append('recoveryRef is not available in local Git history')
    return errors


def receipt_errors(receipt, registry=None, manifest=None):
    registry, manifest = registry or load_registry(), manifest or load_manifest()
    entry = qualification_entry(registry)
    expected_manifest = validate_manifest(manifest, load_package())['manifestIdentity']
    errors = []
    checks = [
        (receipt.get('schema') == 'eveos.timed-qualification.v3', 'receipt schema is not v3'),
        (receipt.get('qualificationScope') == 'full-release', 'receipt is not full-release scope'),
        (receipt.get('status') == 'PASS' and receipt.get('releaseEligible') is True, 'receipt is not release eligible'),
        (receipt.get('dependencyClosureComplete') is True, 'dependency closure is incomplete'),
        (receipt.get('dynamicResultsCached') is False, 'dynamic results were cached'),
        (receipt.get('observedGates') == receipt.get('expectedGates') == entry['requiredObligations'],
         'receipt does not contain every required obligation'),
        (receipt.get('coverageManifestIdentity') == expected_manifest, 'receipt manifest identity is stale')]
    errors.extend(message for passed, message in checks if not passed)
    return errors


def performance_warning(registry=None):
    entry = qualification_entry(registry or load_registry()); values = []
    for path in sorted(REPORT_ROOT.glob('verify-*/report.json'), reverse=True):
        try:
            report = json.loads(path.read_text(encoding='utf-8'))
            if report.get('schema') == 'eveos.timed-qualification.v3' and report.get('status') == 'PASS':
                values.append(float(report['elapsedSeconds']))
        except (OSError, ValueError, TypeError, KeyError): pass
        if len(values) == 5: break
    if len(values) < 2: return None
    perf = entry['performance']; reference = min(float(perf['referenceSeconds']), statistics.median(values))
    threshold = max(float(perf['minimumWarningSeconds']), reference*float(perf['warnRatio']))
    if values[0] > threshold:
        return f'latest full release {values[0]:.2f}s exceeds advisory threshold {threshold:.2f}s'
    return None


def _expect_failure(label, registry, package, manifest, fragment):
    errors = current_errors(registry, package, manifest, check_git=False)
    if not any(fragment in error for error in errors):
        raise AssertionError(f'{label} mutation was not rejected: {errors}')


def self_test():
    registry, package, manifest = load_registry(), load_package(), load_manifest()
    errors = current_errors(registry, package, manifest)
    if errors: raise AssertionError('current safeguards failed: '+str(errors))

    missing = copy.deepcopy(manifest); missing['gates'].pop()
    _expect_failure('missing obligation', registry, package, missing, 'manifest parity failed')
    broken = copy.deepcopy(manifest); broken['gates'][1]['dependsOn'] = ['absent-owner']
    _expect_failure('broken dependency', registry, package, broken, 'manifest parity failed')
    altered = copy.deepcopy(package); altered['scripts']['verify'] = 'npm run qualify:fast:timed'
    _expect_failure('altered verify', registry, altered, manifest, 'authoritative full-release')
    bypass = copy.deepcopy(package); bypass['scripts'].pop('verify:legacy')
    _expect_failure('removed recovery oracle', registry, bypass, manifest, 'comparison oracle is missing')
    unregistered = copy.deepcopy(package)
    unregistered['scripts']['test:guardrails'] = unregistered['scripts']['test:guardrails'].replace(
        ' && npm run --silent smoke:engineering-safeguards-contract', '')
    _expect_failure('removed registration', registry, unregistered, manifest, 'lost authoritative regression')

    identity = validate_manifest(manifest, package)['manifestIdentity']
    receipt = {'schema': 'eveos.timed-qualification.v3', 'qualificationScope': 'full-release',
               'status': 'PASS', 'releaseEligible': True, 'dependencyClosureComplete': True,
               'dynamicResultsCached': False, 'observedGates': 41, 'expectedGates': 41,
               'coverageManifestIdentity': identity}
    if receipt_errors(receipt, registry, manifest): raise AssertionError('valid receipt was rejected')
    stale = dict(receipt, observedGates=40, coverageManifestIdentity='stale')
    if len(receipt_errors(stale, registry, manifest)) < 2: raise AssertionError('stale receipt was accepted')

    upgraded_registry, upgraded_package, upgraded_manifest = (copy.deepcopy(registry), copy.deepcopy(package),
                                                               copy.deepcopy(manifest))
    upgraded_package['scripts']['smoke:future-contract'] = 'node -e "process.exit(0)"'
    upgraded_package['scripts']['verify:legacy'] += ' && npm run smoke:future-contract'
    upgraded_manifest['gates'].append({
        'id': 'future-contract', 'legacyScript': 'smoke:future-contract', 'script': 'smoke:future-contract',
        'category': 'pure', 'dependsOn': ['build-asset-versions'], 'resources': [],
        'contracts': ['intentional future invariant'], 'sourcePatterns': ['tools/qualification/']})
    qualification_entry(upgraded_registry)['requiredObligations'] = 42
    if current_errors(upgraded_registry, upgraded_package, upgraded_manifest, check_git=False):
        raise AssertionError('coherent intentional upgrade was rejected')
    print('EVEOS_ENGINEERING_SAFEGUARDS_OK cases=7 current=true intentionalUpgrade=true')


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        try: self_test()
        except Exception as error:
            print(f'EVEOS_ENGINEERING_SAFEGUARDS_FAIL {error}', file=sys.stderr); return 1
        warning = performance_warning()
        if warning: print('EVEOS_ENGINEERING_SAFEGUARDS_WARNING '+warning, file=sys.stderr)
        return 0
    errors = current_errors()
    if errors:
        print('EVEOS_ENGINEERING_SAFEGUARDS_FAIL '+json.dumps(errors), file=sys.stderr); return 1
    print('EVEOS_ENGINEERING_SAFEGUARDS_OK current=true'); return 0


if __name__ == '__main__': sys.exit(main())
