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
    'data/runtime/', 'data/modular-state/', 'logs/', 'output/', 'test-results/', 'playwright-report/',
    'node_modules/', '.venv/', 'venv/', '.pytest_cache/', '.spotify-probe-profile/'
];
const forbiddenExact = new Set([
    '.env', 'server_modules/audioflix_allowed_dirs.json', 'spotify-volume-probe.mjs'
]);
const forbiddenPath = file => forbiddenExact.has(file)
    || forbiddenRoots.some(root => file.startsWith(root))
    || file.split('/').includes('__pycache__')
    || /(^|\/)\.env\.(?!example$)/.test(file)
    || /^\.claude\/[^/]*\.local\.json$/i.test(file)
    || /(^|\/)(?:cookies?|credentials?|secrets?|tokens?)(?:\.[^/]+)?$/i.test(file);

for (const file of tracked) if (forbiddenPath(file)) fail.push(`private/runtime path is tracked: ${file}`);

const ignoreContract = [
    'data/runtime/.eveos-ignore-probe', 'data/modular-state/.eveos-ignore-probe', 'logs/.eveos-ignore-probe',
    'output/.eveos-ignore-probe', 'test-results/.eveos-ignore-probe', 'playwright-report/.eveos-ignore-probe',
    '.pytest_cache/.eveos-ignore-probe', '.claude/settings.local.json', '.spotify-probe-profile/.eveos-ignore-probe'
];
for (const probe of ignoreContract) {
    try { runGit(['check-ignore', '-q', '--', probe]); }
    catch { fail.push(`required local/runtime ignore boundary is missing: ${probe}`); }
}

const qualificationRoots = [
    'tools/qualification/audioflix_lane3_runtime_acceptance.mjs',
    'tools/qualification/audioflix_lane3_file_acceptance.mjs',
    'tools/qualification/audioflix_lane3_recovery_acceptance.mjs'
];
const durable = [
    'requirements-dev.txt', ...qualificationRoots,
    'tools/qualification/README.md',
    'tools/qualification/lane3-native-controller.cjs',
    'tools/qualification/lane3-runtime-metrics.cjs',
    'tests/audioflix_queue_view_stability.test.cjs',
    'tools/setup/eveos_bootstrap.mjs',
    'tools/setup/eveos_doctor.mjs',
    'tools/setup/eveos_npm.mjs',
    'tools/setup/python_runtime.cjs',
    'tools/setup/npm_runtime.cjs',
    'tools/audit/smoke-registry-audit.js',
    'docs/FRESH-INSTALL.md', 'docs/FRESH_CLONE.md',
    '.github/workflows/repository-guardrails.yml'
];
for (const file of durable) if (!trackedSet.has(file)) fail.push(`durable repository capability is not tracked: ${file}`);

function resolveRelativeDependency(owner, specifier) {
    const base = posix(path.posix.normalize(path.posix.join(path.posix.dirname(owner), specifier)));
    return [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}/index.js`, `${base}/index.mjs`, `${base}/index.cjs`]
        .find(candidate => trackedSet.has(candidate)) || base;
}
for (const file of qualificationRoots.filter(file => trackedSet.has(file))) {
    const source = fs.readFileSync(path.join(ROOT, ...file.split('/')), 'utf8');
    const specs = [
        ...source.matchAll(/(?:from\s+|import\s*\()['"](\.[^'"]+)['"]/g),
        ...source.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)
    ].map(match => match[1]);
    for (const specifier of specs) {
        const resolved = resolveRelativeDependency(file, specifier);
        if (!trackedSet.has(resolved)) fail.push(`qualification dependency is missing/untracked: ${file} -> ${specifier} (${resolved})`);
        if (resolved.startsWith('data/runtime/')) fail.push(`qualification dependency points into ignored runtime state: ${file} -> ${resolved}`);
    }
}

const executableRoot = file => ['tools/', 'tests/', 'server/', 'server_modules/', 'js/'].some(root => file.startsWith(root));
const isFixtureSource = file => file.startsWith('tools/smoke/') || file.startsWith('tests/')
    || file.includes('/tests/') || /(?:^|\/)(?:fixtures?|samples?)(?:\/|$)/i.test(file);
const absoluteMachinePath = /(?:[A-Za-z]:[\\/]Users[\\/][^\\/'"\s]+|\/(?:home|Users)\/[^/'"\s]+)/g;
const isExplicitExamplePath = value => /^(?:[A-Za-z]:[\\/]Users[\\/](?:ExampleUser|TestUser|User)|\/(?:home|Users)\/(?:you|user|example))(?:[\\/]|$)/i.test(value);
for (const file of tracked.filter(file => executableRoot(file) && !isFixtureSource(file))) {
    if (!/\.(?:[cm]?js|py|json|html|css)$/.test(file)) continue;
    const full = path.join(ROOT, ...file.split('/'));
    let source = '';
    try { source = fs.readFileSync(full, 'utf8'); } catch { continue; }
    const hits = (source.match(absoluteMachinePath) || []).filter(value => !isExplicitExamplePath(value));
    if (hits.length) fail.push(`machine-specific absolute path in tracked executable source: ${file} (${hits[0]})`);
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const scriptTargets = new Set();
for (const [name, command] of Object.entries(manifest.scripts || {})) {
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
console.log(`EVEOS_REPO_HYGIENE_OK tracked=${tracked.length} scriptTargets=${scriptTargets.size} durable=${durable.length} ignoreProbes=${ignoreContract.length} qualificationRoots=${qualificationRoots.length}`);
