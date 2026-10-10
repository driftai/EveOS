#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const posix = value => value.replaceAll('\\', '/').replace(/^\.\//, '');
const fail = [];
const runGit = args => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });
const tracked = runGit(['ls-files', '-z']).split('\0').filter(Boolean).map(posix);
const trackedSet = new Set(tracked);

const forbiddenRoots = [
    'data/runtime/', 'data/modular-state/', 'logs/', 'test-results/', 'playwright-report/',
    'node_modules/', '.venv/', 'venv/', '.pytest_cache/', '.spotify-probe-profile/'
];
const forbiddenExact = new Set([
    '.env', 'server_modules/audioflix_allowed_dirs.json', 'spotify-volume-probe.mjs'
]);
const forbiddenPath = file => forbiddenExact.has(file)
    || forbiddenRoots.some(root => file.startsWith(root))
    || file.split('/').includes('__pycache__')
    || /(^|\/)\.env\.(?!example$)/.test(file)
    || /(^|\/)(?:cookies?|credentials?|secrets?|tokens?)(?:\.[^/]+)?$/i.test(file);

for (const file of tracked) {
    if (forbiddenPath(file)) fail.push(`private/runtime path is tracked: ${file}`);
}

const durable = [
    'tools/qualification/audioflix_lane3_runtime_acceptance.mjs',
    'tools/qualification/audioflix_lane3_file_acceptance.mjs',
    'tools/qualification/audioflix_lane3_recovery_acceptance.mjs'
];
for (const file of durable) {
    if (!trackedSet.has(file)) fail.push(`durable qualification driver is not tracked: ${file}`);
}

const codeRoots = ['tools/', 'tests/', 'server/', 'server_modules/', 'js/'];
const absoluteMachinePath = /(?:[A-Za-z]:[\\/]Users[\\/][^\\/'"\s]+|\/(?:home|Users)\/[^/'"\s]+)/g;
for (const file of tracked.filter(file => codeRoots.some(root => file.startsWith(root)))) {
    if (!/\.(?:[cm]?js|py|json|md|html|css)$/.test(file)) continue;
    const full = path.join(ROOT, ...file.split('/'));
    let source = '';
    try { source = fs.readFileSync(full, 'utf8'); } catch { continue; }
    const hits = source.match(absoluteMachinePath) || [];
    if (hits.length) fail.push(`machine-specific absolute path in tracked source: ${file} (${hits[0]})`);
}

const manifestPath = path.join(ROOT, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const scripts = manifest.scripts || {};
const scriptTargets = new Set();
for (const [name, command] of Object.entries(scripts)) {
    const matcher = /(?:^|\s)(?:node|python3?|py(?:\s+-3)?)\s+([^\s;&|]+)/g;
    for (const match of String(command).matchAll(matcher)) {
        const target = posix(match[1].replace(/^['"]|['"]$/g, ''));
        if (!/^(?:tools|tests|server|server_modules)\//.test(target)) continue;
        scriptTargets.add(target);
        if (!trackedSet.has(target)) fail.push(`npm script ${name} points at missing/untracked file: ${target}`);
    }
}

if (fail.length) {
    console.error('EVEOS_REPO_HYGIENE_FAILED');
    for (const issue of [...new Set(fail)]) console.error(`- ${issue}`);
    process.exit(1);
}
console.log(`EVEOS_REPO_HYGIENE_OK tracked=${tracked.length} scriptTargets=${scriptTargets.size} durable=${durable.length}`);
