#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const checks = [
    ['Repository privacy/runtime hygiene', process.execPath, ['tools/audit/eveos_repo_hygiene_guard.mjs']],
    ['GitHub Actions security policy', process.execPath, ['tools/audit/github_actions_security_guard.mjs']],
    ['Queue View pointer stability', process.execPath, ['tests/audioflix_queue_view_stability.test.cjs']],
    ['Recovered structural regression contracts', process.execPath, ['tools/smoke/recovered_structural_regression_smoke.js']],
    ['Deterministic repository guardrails', process.execPath, ['tools/setup/eveos_npm.mjs', 'run', '--silent', 'test:guardrails']]
];

for (const [label, command, args] of checks) {
    console.log(`\n==> ${label}`);
    const result = spawnSync(command, args, {
        cwd: ROOT,
        stdio: 'inherit',
        windowsHide: true
    });
    if (result.error) {
        console.error(`EVEOS_VERIFY_FAILED — ${label}: ${result.error.message}`);
        process.exit(1);
    }
    if (result.status !== 0) {
        console.error(`EVEOS_VERIFY_FAILED — ${label} exited with ${result.status}`);
        process.exit(result.status || 1);
    }
}

console.log('\nEVEOS_VERIFY_OK');
