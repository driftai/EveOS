import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PYTHON_INFO = 'import json, os, sys; print(json.dumps({"prefix": os.path.abspath(sys.prefix), "basePrefix": os.path.abspath(sys.base_prefix), "version": [sys.version_info.major, sys.version_info.minor]}))';
const SUPPORTED = new Set(['3.10', '3.11']);

export function venvPythonPath(root, platform = process.platform) {
    return path.join(root, '.venv', platform === 'win32' ? 'Scripts' : 'bin',
        platform === 'win32' ? 'python.exe' : 'python');
}

function comparable(value, platform) {
    const normalized = path.normalize(path.resolve(value));
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** Read-only: never overwrites, removes, or repairs an existing environment. */
export function inspectVenv({
    root,
    platform = process.platform,
    existsSync = fs.existsSync,
    probe = (exe, args) => spawnSync(exe, args, {
        encoding: 'utf8', windowsHide: true, timeout: 10000
    })
}) {
    if (!root) throw new Error('EveOS root is required.');
    const directory = path.join(root, '.venv');
    const python = venvPythonPath(root, platform);
    if (!existsSync(directory)) return { action: 'create', python, reason: 'no-existing-venv' };
    if (!existsSync(python)) {
        throw new Error('An existing .venv has no usable Python executable. Leave it intact; inspect or repair it manually before bootstrap.');
    }
    const result = probe(python, ['-c', PYTHON_INFO]);
    if (result?.error || result?.status !== 0) {
        throw new Error('Existing .venv Python failed to start. Close running EveOS processes and repair it; bootstrap will not overwrite it.');
    }
    let info;
    try { info = JSON.parse(String(result.stdout || '').trim()); }
    catch { throw new Error('Existing .venv did not report valid Python identity. Refusing to overwrite it.'); }
    const version = Array.isArray(info.version) ? info.version.join('.') : '';
    if (!SUPPORTED.has(version)) {
        throw new Error(`Existing .venv uses Python ${version || 'unknown'}, outside EveOS supported 3.10-3.11. Refusing to overwrite it.`);
    }
    if (!info.prefix || !info.basePrefix ||
        comparable(info.prefix, platform) !== comparable(directory, platform) ||
        comparable(info.prefix, platform) === comparable(info.basePrefix, platform)) {
        throw new Error('Existing .venv interpreter identity does not match this EveOS checkout. Refusing to overwrite it.');
    }
    const pip = probe(python, ['-m', 'pip', '--version']);
    if (pip?.error || pip?.status !== 0) {
        throw new Error('Existing .venv has no working pip. Repair it manually; bootstrap will not overwrite it.');
    }
    return { action: 'reuse', python, version, reason: 'verified-existing-venv' };
}
