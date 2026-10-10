#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const skipBrowser = process.argv.includes('--skip-browser');
const runtimeOnly = process.argv.includes('--runtime-only');
const errors = [], warnings = [], ok = [];
const pass = message => ok.push(message);
const need = (condition, message) => condition ? pass(message) : errors.push(message);
const exists = relative => fs.existsSync(path.join(ROOT, ...relative.split('/')));

const nodeMajor = Number(process.versions.node.split('.')[0]);
need(nodeMajor >= 20, `Node.js >=20 required (found ${process.versions.node})`);
for (const file of [
    'package.json', 'package-lock.json', 'requirements.txt', 'requirements-dev.txt', 'EveOS.html', 'start-server.bat',
    'docs/FRESH_CLONE.md', 'tools/qualification/README.md',
    'config/eveos-ports.json', 'tools/setup/python_runtime.cjs', 'tools/setup/eveos_npm.mjs',
    'tools/setup/eveos_verify.mjs',
    'tools/qualification/audioflix_lane3_runtime_acceptance.mjs',
    'tools/qualification/audioflix_lane3_file_acceptance.mjs',
    'tools/qualification/audioflix_lane3_recovery_acceptance.mjs',
    'tools/qualification/lane3-native-controller.cjs',
    'tools/qualification/lane3-runtime-metrics.cjs'
]) need(exists(file), `required repository file present: ${file}`);

try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    need(pkg.name === 'eveos' && lock.name === pkg.name, 'package-lock belongs to EveOS');
    need(Number(lock.lockfileVersion) >= 3, `package-lock lockfileVersion >=3 (found ${lock.lockfileVersion})`);
} catch (error) { errors.push(`package metadata readable: ${error.message}`); }

try {
    const ports = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/eveos-ports.json'), 'utf8'));
    const webPort = Number(ports?.ports?.EVEOS_WEB_PORT?.port);
    need(Number.isInteger(webPort) && webPort > 0 && webPort < 65536, 'EVEOS_WEB_PORT is registered and valid');
} catch (error) { errors.push(`port registry readable: ${error.message}`); }

for (const modulePath of ['node_modules/playwright/package.json', 'node_modules/esbuild/package.json', 'node_modules/@google/genai/package.json']) {
    need(exists(modulePath), `Node dependency installed: ${modulePath.replace('/package.json', '')}`);
}

const venvPython = process.platform === 'win32'
    ? path.join(ROOT, '.venv', 'Scripts', 'python.exe')
    : path.join(ROOT, '.venv', 'bin', 'python');
if (!fs.existsSync(venvPython)) {
    errors.push('Python virtual environment missing: run `node tools/setup/eveos_bootstrap.mjs`');
} else {
    const version = spawnSync(venvPython, ['--version'], { encoding: 'utf8', windowsHide: true });
    const text = `${version.stdout || ''}${version.stderr || ''}`.trim();
    need(version.status === 0, `EveOS virtualenv Python starts (${text || 'unknown version'})`);
    const match = text.match(/Python\s+(\d+)\.(\d+)/i);
    if (match && !(['3.10', '3.11'].includes(`${match[1]}.${match[2]}`))) {
        warnings.push(`Python ${match[1]}.${match[2]} is outside the tested 3.10-3.11 range`);
    }
    const pipCheck = spawnSync(venvPython, ['-m', 'pip', 'check'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    need(pipCheck.status === 0, `Python dependencies are internally consistent${pipCheck.status ? `: ${(pipCheck.stdout || pipCheck.stderr || '').trim()}` : ''}`);
    if (!runtimeOnly) {
        const pytest = spawnSync(venvPython, ['-m', 'pytest', '--version'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
        need(pytest.status === 0, `pytest is installed in the EveOS virtualenv${pytest.status ? `: ${(pytest.stdout || pytest.stderr || '').trim()}` : ''}`);
    }
}

if (!skipBrowser && exists('node_modules/playwright/package.json')) {
    const probe = spawnSync(process.execPath, ['-e', "const {chromium}=require('playwright');const fs=require('fs');process.exit(fs.existsSync(chromium.executablePath())?0:2)"],
        { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    need(probe.status === 0, 'Playwright Chromium runtime installed');
} else if (skipBrowser) {
    warnings.push('Playwright Chromium runtime check skipped by explicit --skip-browser');
}

for (const message of ok) console.log(`OK   ${message}`);
for (const message of warnings) console.warn(`WARN ${message}`);
if (errors.length) {
    for (const message of errors) console.error(`FAIL ${message}`);
    console.error('\nEVEOS_DOCTOR_FAILED — run `node tools/setup/eveos_bootstrap.mjs`, then rerun this doctor.');
    process.exit(1);
}
console.log(`EVEOS_DOCTOR_OK checks=${ok.length} warnings=${warnings.length} mode=${runtimeOnly ? 'runtime' : 'development'}`);
