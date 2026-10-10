#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const require = createRequire(import.meta.url);
const { environmentForPython, resolvePython } = require('./python_runtime.cjs');

const args = process.argv.slice(2);
if (!args.length) {
    console.error('Usage: node tools/setup/eveos_npm.mjs <npm arguments...>');
    process.exit(2);
}

try {
    const python = resolvePython(ROOT);
    const env = environmentForPython(python);
    const npmCli = process.env.npm_execpath;
    const command = npmCli && fs.existsSync(npmCli)
        ? { exe: process.execPath, args: [npmCli, ...args] }
        : { exe: process.platform === 'win32' ? 'npm.cmd' : 'npm', args };
    const result = spawnSync(command.exe, command.args, {
        cwd: ROOT,
        env,
        stdio: 'inherit',
        windowsHide: true
    });
    if (result.error) throw result.error;
    process.exit(result.status ?? 1);
} catch (error) {
    console.error(`EVEOS_NPM_ENV_FAILED — ${error.message}`);
    process.exit(1);
}
