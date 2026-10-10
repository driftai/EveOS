#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const skipBrowser = process.argv.includes('--skip-browser');
const runtimeOnly = process.argv.includes('--runtime-only');
const run = (command, args, label) => {
    console.log(`\n==> ${label}`);
    const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
};
const capture = (command, args) => spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });

function npmCommand(args, label) {
    const npmCli = process.env.npm_execpath;
    if (npmCli && fs.existsSync(npmCli)) return run(process.execPath, [npmCli, ...args], label);
    return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, label);
}

function findPython() {
    const candidates = process.platform === 'win32'
        ? [['py', ['-3.11']], ['py', ['-3.10']], ['python', []]]
        : [['python3.11', []], ['python3.10', []], ['python3', []], ['python', []]];
    for (const [command, prefix] of candidates) {
        const probe = capture(command, [...prefix, '-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")']);
        const version = String(probe.stdout || '').trim();
        if (probe.status === 0 && ['3.10', '3.11'].includes(version)) return { command, prefix, version };
    }
    throw new Error('Python 3.10 or 3.11 is required. Install one, then rerun `node tools/setup/eveos_bootstrap.mjs`.');
}

try {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 20) throw new Error(`Node.js >=20 required; found ${process.versions.node}`);
    npmCommand(['ci'], 'Install locked Node dependencies');
    const python = findPython();
    console.log(`Using Python ${python.version}`);
    run(python.command, [...python.prefix, '-m', 'venv', '.venv'], 'Create isolated EveOS Python environment');
    const venvPython = process.platform === 'win32'
        ? path.join(ROOT, '.venv', 'Scripts', 'python.exe')
        : path.join(ROOT, '.venv', 'bin', 'python');
    const requirementsFile = runtimeOnly ? 'requirements.txt' : 'requirements-dev.txt';
    run(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirementsFile],
        `Install EveOS ${runtimeOnly ? 'runtime' : 'runtime + test'} Python dependencies`);
    if (!skipBrowser) {
        run(process.execPath, [path.join(ROOT, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium'], 'Install Playwright Chromium');
    }
    const doctorArgs = [path.join(ROOT, 'tools', 'setup', 'eveos_doctor.mjs')];
    if (skipBrowser) doctorArgs.push('--skip-browser');
    if (runtimeOnly) doctorArgs.push('--runtime-only');
    run(process.execPath, doctorArgs, 'Verify fresh installation');
    console.log('\nEVEOS_SETUP_OK');
    if (!runtimeOnly) console.log('Run tests through: node tools/setup/eveos_npm.mjs run test:guardrails');
} catch (error) {
    console.error(`\nEVEOS_SETUP_FAILED — ${error.message}`);
    process.exit(1);
}
