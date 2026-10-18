"""Qualification Engine v3 manifest loading, parity, and fingerprint helpers."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import subprocess


ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = Path(__file__).with_name('eveos_qualification_manifest.v3.json')
NPM_RUN = re.compile(r'^npm(?:\.cmd)?\s+run\s+(?:--silent\s+)?([^\s]+)\s*$')
CATEGORIES = {'pure', 'build-dependent', 'service-owned', 'browser-owned', 'integration', 'exclusive'}


class ManifestError(ValueError):
    """Raised when release coverage and its manifest no longer agree."""


def _sha(value):
    if not isinstance(value, (bytes, bytearray)):
        value = str(value).encode('utf-8')
    return hashlib.sha256(value).hexdigest()


def _parts(command):
    return [part.strip() for part in re.split(r'\s*&&\s*', str(command)) if part.strip()]


def _npm_name(command):
    match = NPM_RUN.match(command.strip())
    return match.group(1) if match else None


def load_package(path=None):
    package_path = Path(path) if path else ROOT / 'package.json'
    return json.loads(package_path.read_text(encoding='utf-8'))


def load_manifest(path=None):
    manifest_path = Path(path) if path else MANIFEST_PATH
    return json.loads(manifest_path.read_text(encoding='utf-8'))


def _top_level_scripts(command):
    names = []
    for part in _parts(command):
        name = _npm_name(part)
        if not name:
            raise ManifestError(f'legacy release contains a non-npm gate: {part}')
        names.append(name)
    return names


def _validate_graph(gates):
    by_id = {item['id']: item for item in gates}
    if len(by_id) != len(gates):
        raise ManifestError('qualification gate ids must be unique')
    for item in gates:
        missing = sorted(set(item.get('dependsOn', ())) - set(by_id))
        if missing:
            raise ManifestError(f"gate {item['id']} has missing dependencies: {', '.join(missing)}")
    visiting, visited = set(), set()

    def visit(gate_id):
        if gate_id in visiting:
            raise ManifestError(f'dependency cycle includes {gate_id}')
        if gate_id in visited:
            return
        visiting.add(gate_id)
        for dependency in by_id[gate_id].get('dependsOn', ()): visit(dependency)
        visiting.remove(gate_id); visited.add(gate_id)

    for gate_id in by_id: visit(gate_id)


def _walk_script(name, scripts, *, stack=(), trail=()):
    if name in stack:
        raise ManifestError(f"npm script cycle: {' -> '.join((*stack, name))}")
    if name not in scripts:
        raise ManifestError(f'npm script missing: {name}')
    records = [{'kind': 'script', 'id': name, 'trail': [*trail, name]}]
    for index, part in enumerate(_parts(scripts[name])):
        nested = _npm_name(part)
        if nested:
            records.extend(_walk_script(nested, scripts, stack=(*stack, name), trail=(*trail, name)))
        else:
            records.append({'kind': 'command', 'id': part, 'trail': [*trail, name, f'command:{index}']})
    return records


def transitive_inventory(root_scripts, scripts):
    records = []
    for name in root_scripts:
        records.extend(_walk_script(name, scripts))
    counts = {}
    for record in records:
        if record['kind'] != 'script': continue
        counts[record['id']] = counts.get(record['id'], 0) + 1
    duplicates = [{'script': name, 'count': count} for name, count in sorted(counts.items()) if count > 1]
    return records, duplicates


def validate_manifest(manifest=None, package=None):
    manifest = manifest or load_manifest()
    package = package or load_package()
    scripts = package.get('scripts') or {}
    if manifest.get('schema') != 'eveos.qualification-manifest.v3':
        raise ManifestError('qualification manifest schema drifted')
    gates = manifest.get('gates') or []
    if not gates:
        raise ManifestError('qualification manifest has no release gates')
    _validate_graph(gates)
    for item in gates:
        required = {'id', 'legacyScript', 'script', 'category', 'dependsOn', 'resources',
                    'contracts', 'sourcePatterns'}
        missing = sorted(required - set(item))
        if missing:
            raise ManifestError(f"gate {item.get('id', '<unknown>')} lacks: {', '.join(missing)}")
        if item['category'] not in CATEGORIES:
            raise ManifestError(f"gate {item['id']} has unsupported category {item['category']}")
        if item['legacyScript'] not in scripts or item['script'] not in scripts:
            raise ManifestError(f"gate {item['id']} references an unknown npm script")

    legacy_name = manifest.get('legacyScript')
    if legacy_name not in scripts:
        raise ManifestError(f'legacy release script is missing: {legacy_name}')
    expected = [item['legacyScript'] for item in gates]
    actual = _top_level_scripts(scripts[legacy_name])
    if actual != expected:
        raise ManifestError(f'legacy/manifest parity failed: expected {expected}, observed {actual}')

    legacy_records, legacy_duplicates = transitive_inventory(expected, scripts)
    optimized_roots = [item['script'] for item in gates]
    optimized_records, optimized_duplicates = transitive_inventory(optimized_roots, scripts)
    allowed = {item['script']: item for item in manifest.get('deduplications', [])}
    optimized_duplicate_names = {item['script'] for item in optimized_duplicates}
    if optimized_duplicate_names:
        raise ManifestError('optimized release still repeats npm scripts: ' + ', '.join(sorted(optimized_duplicate_names)))
    legacy_counts = {item['script']: item['count'] for item in legacy_duplicates}
    optimized_counts = {}
    for record in optimized_records:
        if record['kind'] == 'script':
            optimized_counts[record['id']] = optimized_counts.get(record['id'], 0) + 1
    for name, item in allowed.items():
        if legacy_counts.get(name, 0) < 2 or optimized_counts.get(name) != 1:
            raise ManifestError(f'deduplication proof drifted for {name}')
        original = scripts[expected[[gate['id'] for gate in gates].index(item['removedFromGate'])]]
        removed = [part for part in _parts(original) if _npm_name(part) != name]
        if ' && '.join(removed) != scripts[item['optimizedScript']]:
            raise ManifestError(f'optimized script is not an exact one-command subtraction for {name}')

    manifest_identity = _sha(json.dumps(manifest, sort_keys=True, separators=(',', ':')))
    graph_material = {
        'roots': optimized_roots,
        'scripts': {name: scripts[name] for name in sorted({r['id'] for r in optimized_records if r['kind'] == 'script'})}
    }
    return {
        'manifest': manifest,
        'manifestIdentity': manifest_identity,
        'coverageGraphIdentity': _sha(json.dumps(graph_material, sort_keys=True, separators=(',', ':'))),
        'legacyObligations': len(expected),
        'optimizedObligations': len(optimized_roots),
        'legacyDuplicates': legacy_duplicates,
        'optimizedDuplicates': optimized_duplicates,
        'deduplications': manifest.get('deduplications', []),
    }


def gate_specs(validated=None):
    validated = validated or validate_manifest()
    gates = []
    for item in validated['manifest']['gates']:
        gates.append({
            'label': item['id'],
            'argv': ['npm.cmd' if __import__('os').name == 'nt' else 'npm', 'run', '--silent', item['script']],
            'resources': sorted(set(item['resources'])),
            'dependsOn': list(item['dependsOn']),
            'category': item['category'],
            'script': item['script'],
            'legacyScript': item['legacyScript'],
            'contracts': list(item['contracts']),
        })
    return gates


def source_fingerprint(validated=None):
    validated = validated or validate_manifest()
    head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True, capture_output=True, check=False)
    status = subprocess.run(['git', 'status', '--porcelain'], cwd=ROOT, text=True, capture_output=True, check=False)
    material = {
        'head': head.stdout.strip() if head.returncode == 0 else 'UNKNOWN',
        'status': status.stdout.splitlines() if status.returncode == 0 else ['UNKNOWN'],
        'manifestIdentity': validated['manifestIdentity'],
        'coverageGraphIdentity': validated['coverageGraphIdentity'],
    }
    return _sha(json.dumps(material, sort_keys=True, separators=(',', ':'))), material
