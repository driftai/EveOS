'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function probe(command, args = []) {
    if (!command) return false;
    const result = spawnSync(command, [...args, '--version'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: 'pipe'
    });
    return !result.error && result.status === 0;
}

function resolvePython(root = path.resolve(__dirname, '..', '..')) {
    const inherited = [process.env.EVEOS_PYTHON, process.env.PYTHON].filter(Boolean);
    for (const command of inherited) {
        if (probe(command)) return command;
    }

    const venvPython = process.platform === 'win32'
        ? path.join(root, '.venv', 'Scripts', 'python.exe')
        : path.join(root, '.venv', 'bin', 'python');
    if (fs.existsSync(venvPython) && probe(venvPython)) return venvPython;

    const fallback = process.platform === 'win32' ? ['python.exe', 'python'] : ['python3', 'python'];
    for (const command of fallback) {
        if (probe(command)) return command;
    }
    throw new Error('No usable Python interpreter found. Run `node tools/setup/eveos_bootstrap.mjs`.');
}

function environmentForPython(python, env = process.env) {
    const binDir = path.dirname(python);
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
    const current = String(env[pathKey] || '');
    return {
        ...env,
        [pathKey]: current ? `${binDir}${path.delimiter}${current}` : binDir,
        PYTHON: python,
        EVEOS_PYTHON: python
    };
}

module.exports = { environmentForPython, resolvePython };
