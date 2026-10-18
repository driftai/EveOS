const fs = require('fs');
const path = require('path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

function requireTrue(condition, message, diagnostics) {
    if (!condition) {
        const error = new Error(message);
        error.diagnostics = diagnostics;
        throw error;
    }
}

function runRecoveredStructuralRegressions() {
    const smokePath = path.join(__dirname, 'recovered_structural_regression_smoke.js');
    const result = spawnSync(process.execPath, [smokePath], {
        cwd: ROOT,
        encoding: 'utf8',
        windowsHide: true,
        stdio: 'pipe'
    });

    if (process.argv.includes('--verbose')) {
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
    }
    requireTrue(
        result.status === 0,
        `recovered structural regression smoke failed with exit code ${result.status}`,
        { status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message }
    );
}

function main() {
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
    'smoke:codex-exec-bootstrap-contract',
    'smoke:tlo-autorecovery-contract',
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
requireTrue(
    scripts['smoke:codex-exec-bootstrap-contract'] ===
        'python -B tools/qualification/codex_exec_bootstrap_test.py',
    'Codex exec bootstrap deterministic contract entrypoint drifted'
);
requireTrue(
    scripts['qualify:codex-exec-bootstrap-native'] ===
        'python -B tools/qualification/codex_exec_bootstrap_test.py --native',
    'Codex exec bootstrap native preflight entrypoint drifted'
);
requireTrue(
    scripts['smoke:tlo-autorecovery-contract'] ===
        'python -B tools/qualification/tlo_autorecover_policy_test.py',
    'TLO autorecovery deterministic contract entrypoint drifted'
);

const verify = String(scripts.verify || '');
requireTrue(
    verify.startsWith('npm run test:guardrails && '),
    'verify must run structural guardrails before build/write steps'
);
requireTrue(
    verify.indexOf('npm run test:guardrails') < verify.indexOf('npm run build:asset-versions'),
    'verify can mutate asset versions before proving they are already synchronized'
);

function readProfileScripts(profileName) {
    requireTrue(
        ['fast', 'deep', 'security', 'ai-control'].includes(profileName),
        `unexpected smoke profile name: ${profileName}`
    );
    const quoted = profileName === 'ai-control' ? "['\"]ai-control['\"]" : profileName;
    const match = profileSource.match(
        new RegExp(`(?:^|\\n)\\s*${quoted}\\s*:\\s*\\[([\\s\\S]*?)\\]`, 'm')
    );
    requireTrue(match, `smoke profile declaration missing: ${profileName}`);
    const plan = [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((item) => item[1]);
    requireTrue(
        plan[0] === 'test:guardrails',
        `smoke profile guardrail wiring missing at first position: ${profileName}`
    );
    return plan;
}

const profiles = {};
for (const profileName of ['fast', 'deep', 'security', 'ai-control']) {
    profiles[profileName] = readProfileScripts(profileName);
}

const reloadScripts = {
    'smoke:service-reload': 'python tools/smoke/eveos_service_reload_smoke.py',
    'smoke:selective-reload-browser': 'node tests/eveos_selective_reload_browser.test.mjs'
};
requireTrue(scripts['qualify:lane4:reload'] === 'node tools/qualification/eveos_lane4_reload_acceptance.mjs',
    'live selective reload qualifier lost its explicit opt-in npm entrypoint');
const policy = spawnSync(process.execPath, ['tools/qualification/eveos_lane4_reload_acceptance.mjs', '--check'], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 10000
});
requireTrue(policy.status === 0, 'live selective reload write-isolation contract failed', {
    status: policy.status, stdout: policy.stdout, stderr: policy.stderr, error: policy.error?.message
});
for (const [name, command] of Object.entries(reloadScripts)) {
    requireTrue(scripts[name] === command, `selective reload npm leaf drifted: ${name}`);
    requireTrue(profiles['ai-control'].includes(name), `ai-control lost required selective reload check: ${name}`);
}

function chainIncludes(chain, script) {
    return String(chain || '').split('&&').some((step) =>
        [`npm run ${script}`, `npm run --silent ${script}`].includes(step.trim()));
}

requireTrue(chainIncludes(scripts['smoke:control-plane'], 'smoke:service-reload'),
    'control-plane smoke lost its registered service reload leaf');
for (const name of ['smoke:control-plane', 'smoke:selective-reload-browser']) {
    requireTrue(profiles.deep.includes(name), `deep lost required selective reload check: ${name}`);
    requireTrue(chainIncludes(verify, name), `verify lost required selective reload check: ${name}`);
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
}

try {
    main();
} catch (error) {
    const directory = path.join(ROOT, 'data', 'runtime', 'smoke-results');
    fs.mkdirSync(directory, { recursive: true });
    const artifact = path.join(directory, 'qualification-guardrails-contract-failure.json');
    fs.writeFileSync(artifact, JSON.stringify({
        test: 'qualification-guardrails-contract', message: error.message,
        stack: error.stack, ...error.diagnostics
    }, null, 2) + '\n');
    const context = [error.diagnostics?.stdout, error.diagnostics?.stderr, error.message]
        .filter(Boolean).join('\n').split(/\r?\n/).filter(Boolean).slice(-38)
        .map((line) => line.slice(0, 700)).join('\n');
    console.error('QUALIFICATION_GUARDRAILS_CONTRACT_SMOKE_FAIL');
    console.error(context);
    console.error(`DIAGNOSTIC ${path.relative(ROOT, artifact).replace(/\\/g, '/')}`);
    process.exitCode = 1;
}
