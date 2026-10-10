#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const strict = process.argv.includes('--strict');
const prunePromoted = process.argv.includes('--prune-promoted');
const toPosix = value => value.replaceAll('\\', '/');
const exists = relative => fs.existsSync(path.join(ROOT, ...relative.split('/')));
const tracked = relative => {
    try {
        execFileSync('git', ['-C', ROOT, 'ls-files', '--error-unmatch', '--', relative], { stdio: 'ignore' });
        return true;
    } catch { return false; }
};

const promoted = new Map([
    ['data/runtime/smoke-results/lane3-runtime-acceptance.mjs', 'tools/qualification/audioflix_lane3_runtime_acceptance.mjs'],
    ['data/runtime/smoke-results/lane3-file-acceptance.mjs', 'tools/qualification/audioflix_lane3_file_acceptance.mjs'],
    ['data/runtime/smoke-results/lane3-native-controller.cjs', 'tools/qualification/lane3-native-controller.cjs'],
    ['data/runtime/smoke-results/lane3-runtime-metrics.cjs', 'tools/qualification/lane3-runtime-metrics.cjs']
]);

if (prunePromoted) {
    for (const [legacy, canonical] of promoted) {
        const legacyPath = path.join(ROOT, ...legacy.split('/'));
        if (!fs.existsSync(legacyPath)) continue;
        if (!exists(canonical) || !tracked(canonical)) {
            console.error(`REFUSE ${legacy}: canonical replacement is missing or not tracked (${canonical})`);
            process.exitCode = 2;
            continue;
        }
        fs.rmSync(legacyPath, { force: true });
        console.log(`PRUNED promoted legacy driver: ${legacy} -> ${canonical}`);
    }
    if (process.exitCode) process.exit(process.exitCode);
}

function walk(relative, output = []) {
    const full = path.join(ROOT, ...relative.split('/'));
    if (!fs.existsSync(full)) return output;
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
        const child = toPosix(path.posix.join(relative, entry.name));
        if (entry.isDirectory()) walk(child, output);
        else output.push(child);
    }
    return output;
}

const warnings = [];
const sourceExtensions = new Set(['.js', '.mjs', '.cjs', '.py', '.ps1', '.bat', '.cmd']);
for (const file of walk('data/runtime/smoke-results')) {
    if (!sourceExtensions.has(path.extname(file).toLowerCase())) continue;
    const canonical = promoted.get(file);
    warnings.push(canonical
        ? `${file} is a legacy reusable driver; canonical tracked copy is ${canonical}`
        : `${file} looks like reusable source inside ignored runtime evidence; review whether it belongs under tools/qualification, tools/smoke, or tests`);
}

for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.log')) {
        warnings.push(`${entry.name} is a root-level generated log; new producers should write under logs/`);
    }
}
if (exists('__pycache__')) warnings.push('__pycache__/ exists at repository root; it is disposable Python cache state');
if (exists('.pytest_cache')) warnings.push('.pytest_cache/ exists locally; it is disposable pytest cache state');

if (warnings.length) {
    console.warn(`EVEOS_LOCAL_HYGIENE_WARN count=${warnings.length}`);
    for (const warning of warnings) console.warn(`- ${warning}`);
    if ([...promoted.keys()].some(exists)) {
        console.warn('Known promoted Lane 3 copies can be pruned safely with: node tools/setup/eveos_local_hygiene.mjs --prune-promoted');
    }
    if (strict) process.exit(1);
} else {
    console.log('EVEOS_LOCAL_HYGIENE_OK');
}
