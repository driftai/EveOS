import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { inspectVenv, venvPythonPath } from '../tools/setup/eveos_venv_guard.mjs';

const root = path.resolve(process.cwd(), 'portable-test-root');
const dir = path.join(root, '.venv');
const python = venvPythonPath(root, 'win32');
function fixture({ directory = true, executable = true, info = {}, pythonStatus = 0, pipStatus = 0 } = {}) {
    const existsSync = value => value === dir ? directory : value === python ? executable : false;
    const identity = { prefix: dir, basePrefix: path.join(root, 'global-python'), version: [3, 10], ...info };
    const commands = [];
    const probe = (exe, args) => {
        commands.push({ exe, args });
        return args.includes('-c')
            ? { status: pythonStatus, stdout: JSON.stringify(identity) }
            : { status: pipStatus, stdout: 'pip 25.2' };
    };
    return { options: { root, platform: 'win32', existsSync, probe }, commands };
}

test('a missing virtualenv is created only when truly absent', () => {
    const f = fixture({ directory: false, executable: false });
    assert.equal(inspectVenv(f.options).action, 'create');
    assert.equal(f.commands.length, 0);
});

test('a healthy Python 3.10 project environment is reused rather than recreated', () => {
    const f = fixture();
    const result = inspectVenv(f.options);
    assert.equal(result.action, 'reuse');
    assert.equal(result.version, '3.10');
    assert.equal(f.commands.length, 2);
});

test('Python 3.11 is also accepted', () => {
    const f = fixture({ info: { version: [3, 11] } });
    assert.equal(inspectVenv(f.options).action, 'reuse');
});

test('partial virtualenv cannot be silently overwritten', () => {
    const f = fixture({ executable: false });
    assert.throws(() => inspectVenv(f.options), /no usable Python/);
    assert.equal(f.commands.length, 0);
});

test('in-use or inaccessible Python remains untouched', () => {
    const f = fixture({ pythonStatus: 1 });
    assert.throws(() => inspectVenv(f.options), /failed to start/);
    assert.equal(f.commands.length, 1);
});

test('system Python masquerading as venv is rejected', () => {
    const f = fixture({ info: { prefix: path.join(root, 'global-python') } });
    assert.throws(() => inspectVenv(f.options), /identity does not match/);
});

test('old/unsupported Python version is rejected', () => {
    const f = fixture({ info: { version: [3, 9] } });
    assert.throws(() => inspectVenv(f.options), /outside EveOS supported/);
});

test('unusable pip is diagnosed without replacing virtualenv', () => {
    const f = fixture({ pipStatus: 1 });
    assert.throws(() => inspectVenv(f.options), /no working pip/);
});

test('read-only preflight never requests venv construction or deletion', () => {
    const f = fixture();
    inspectVenv(f.options);
    assert.ok(f.commands.every(({ args }) => args.includes('-c') || args.includes('--version')));
    assert.ok(f.commands.every(({ args }) => !args.includes('venv') && !args.includes('install')));
});

test('executable path follows the target OS rather than the developer machine', () => {
    assert.equal(venvPythonPath(root, 'win32'), path.join(dir, 'Scripts', 'python.exe'));
    assert.equal(venvPythonPath(root, 'linux'), path.join(dir, 'bin', 'python'));
});
