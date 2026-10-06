const fs = require('fs');
const path = require('path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

function requireTrue(condition, message) {
    if (!condition) throw new Error(message);
}

function runRecoveredStructuralRegressions() {
    const smokePath = path.join(__dirname, 'recovered_structural_regression_smoke.js');
    const result = spawnSync(process.execPath, [smokePath], {
        cwd: ROOT,
        encoding: 'utf8',
        windowsHide: true,
        stdio: 'pipe'
    });

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    requireTrue(
        result.status === 0,
        `recovered structural regression smoke failed with exit code ${result.status}`
    );
}

const packageSource = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
const pkg = JSON.parse(packageSource);
const scripts = pkg.scripts || {};
const profileSource = fs.readFileSync(path.join(__dirname, 'eveos_profile_runner.mjs'), 'utf8');
const handoffSource = fs.readFileSync(path.join(__dirname, 'eveos_chat_handoff.mjs'), 'utf8');
const { zeroBacklogViolation } = require('../audit/smoke-registry-audit.js');
const baseline = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'tools', 'audit', 'smoke-registry-baseline.json'),
    'utf8'
));

const guardrailScript = String(scripts['test:guardrails'] || '');
for (const required of [
    'smoke:qualification-guardrails-contract',
    'audit:asset-versions',
    'audit:smoke-registry',
    'smoke:coverage-map',
    'smoke:file-growth',
    'smoke:file-size'
]) {
    requireTrue(
        guardrailScript.includes(required),
        `test:guardrails lost required structural check: ${required}`
    );
}

const verify = String(scripts.verify || '');
requireTrue(
    verify.startsWith('npm run test:guardrails && '),
    'verify must run structural guardrails before build/write steps'
);
requireTrue(
    verify.indexOf('npm run test:guardrails') < verify.indexOf('npm run build:asset-versions'),
    'verify can mutate asset versions before proving they are already synchronized'
);

function requireProfileStartsWithGuardrail(profileName) {
    requireTrue(
        ['fast', 'deep', 'security', 'ai-control'].includes(profileName),
        `unexpected smoke profile name: ${profileName}`
    );
    const quoted = profileName === 'ai-control' ? "['\"]ai-control['\"]" : profileName;
    const match = profileSource.match(
        new RegExp(`(?:^|\\n)\\s*${quoted}\\s*:\\s*\\[\\s*['\"]([^'\"]+)['\"]`, 'm')
    );
    requireTrue(match, `smoke profile declaration missing: ${profileName}`);
    requireTrue(
        match[1] === 'test:guardrails',
        `smoke profile guardrail wiring missing at first position: ${profileName}`
    );
}

for (const profileName of ['fast', 'deep', 'security', 'ai-control']) {
    requireProfileStartsWithGuardrail(profileName);
}
requireTrue(
    handoffSource.includes("if (profile === 'none' && explicit.length) plan.push('test:guardrails');"),
    'focused handoff runs no longer force structural guardrails'
);
requireTrue(
    Array.isArray(baseline.unregistered) && baseline.unregistered.length === 0,
    'smoke registry baseline must remain permanently empty'
);
requireTrue(
    zeroBacklogViolation([], []) === null,
    'zero-backlog registry rejected a fully registered smoke set'
);
const baselineViolation = zeroBacklogViolation(['dormant_smoke.js'], []);
requireTrue(
    baselineViolation?.kind === 'baseline' && baselineViolation.code === 3,
    'zero-backlog registry no longer rejects baseline exceptions'
);
const registryViolation = zeroBacklogViolation([], ['new_smoke.js']);
requireTrue(
    registryViolation?.kind === 'unregistered' && registryViolation.code === 1,
    'zero-backlog registry no longer rejects newly dormant smokes'
);

runRecoveredStructuralRegressions();

console.log('QUALIFICATION_GUARDRAILS_CONTRACT_SMOKE_OK');
