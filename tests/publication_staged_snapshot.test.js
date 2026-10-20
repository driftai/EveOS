'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
function run(root, executable, args, options = {}) {
    const { env: extraEnv = {}, ...spawnOptions } = options;
    const env = { ...process.env, ...extraEnv };
    // Git exports repository-scoped variables while hooks run. Those variables
    // must not leak into this deliberately independent fixture repository.
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
    return spawnSync(executable, args, {
        cwd: root, encoding: 'utf8', windowsHide: true,
        maxBuffer: 8 * 1024 * 1024, env, ...spawnOptions
    });
}
function git(root, ...args) {
    const result = run(root, 'git', args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}
function writeLines(file, count) {
    fs.writeFileSync(file, `${'const n = 1;\n'.repeat(count)}`, 'utf8');
}
function makeFixture(t, baseline) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eveos-staged-guard-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const smoke = path.join(root, 'tools', 'smoke');
    fs.mkdirSync(smoke, { recursive: true });
    for (const file of [
        'first_party_staged_snapshot.js',
        'first_party_file_size_smoke.js',
        'first_party_file_growth_guard.js'
    ]) {
        fs.copyFileSync(path.join(repo, 'tools', 'smoke', file), path.join(smoke, file));
    }
    git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'EveOS Test');
    git(root, 'config', 'user.email', 'eveos-test@example.invalid');
    const target = path.join(root, 'example.js');
    writeLines(target, baseline);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'fixture baseline');
    return { root, target };
}
function scan(root, file, env = {}) {
    return run(root, process.execPath, [
        path.join(root, 'tools', 'smoke', file), '--staged'
    ], { env: { ...process.env, ...env } });
}

test('oversized staged blob is rejected even when the worktree is tiny', (t) => {
    const { root, target } = makeFixture(t, 1);
    writeLines(target, 1113);
    git(root, 'add', 'example.js');
    writeLines(target, 1); // partially-staged attack: worktree no longer oversized
    const outcome = scan(root, 'first_party_file_size_smoke.js');
    assert.notEqual(outcome.status, 0);
    assert.match(outcome.stderr, /1113.*example\.js/);
});

test('440-to-441-line staged growth is rejected despite a smaller worktree', (t) => {
    const { root, target } = makeFixture(t, 440);
    writeLines(target, 441);
    git(root, 'add', 'example.js');
    writeLines(target, 1);
    const outcome = scan(root, 'first_party_file_growth_guard.js', {
        EVEOS_GUARDRAIL_BASE: 'HEAD'
    });
    assert.notEqual(outcome.status, 0);
    assert.match(outcome.stderr, /440 -> 441 lines/);
});

test('compliant staged file passes both snapshot gates', (t) => {
    const { root, target } = makeFixture(t, 439);
    writeLines(target, 440);
    git(root, 'add', 'example.js');
    for (const file of ['first_party_file_size_smoke.js', 'first_party_file_growth_guard.js']) {
        const outcome = scan(root, file, { EVEOS_GUARDRAIL_BASE: 'HEAD' });
        assert.equal(outcome.status, 0, outcome.stderr);
    }
});

test('pre-commit wires both staged snapshot gates', () => {
    const hook = fs.readFileSync(path.join(repo, 'tools', 'hooks', 'pre-commit'), 'utf8');
    assert.match(hook, /first_party_file_size_smoke\.js --staged/);
    assert.match(hook, /first_party_file_growth_guard\.js --staged/);
});
