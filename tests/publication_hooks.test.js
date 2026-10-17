'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('hard and growth caps still reject the TLO 1113/669-line failures', () => {
    const hard = read('tools/smoke/first_party_file_size_smoke.js');
    const growth = read('tools/smoke/first_party_file_growth_guard.js');
    assert.match(hard, /const MAX_LINES = 450/);
    assert.match(hard, /measured\.filter\(\(entry\) => entry\.lines > MAX_LINES\)/);
    assert.match(growth, /const SOFT_MAX_LINES = 440/);
    assert.match(growth, /entry\.after > SOFT_MAX_LINES && entry\.after > entry\.before/);
    assert.ok(1113 > 450 && 669 > 450);
});
test('pre-commit executes size and growth checks before admitting commits', () => {
    const hook = read('tools/hooks/pre-commit');
    assert.match(hook, /node tools\/smoke\/first_party_file_size_smoke\.js/);
    assert.match(hook, /node tools\/smoke\/first_party_file_growth_guard\.js/);
    assert.match(hook, /exit 1/);
});
test('pre-push enforces exact lane, origin SHA, clean tree and all guardrails', () => {
    const hook = read('tools/hooks/pre-push');
    for (const marker of ['origin', 'refs/heads/eve/nexus-machine-spaces',
        'refs/remotes/origin/eve/nexus-machine-spaces', 'merge-base --is-ancestor',
        'status --porcelain=v1', 'test:guardrails', 'EVEOS_PUBLICATION_GUARD_OK']) {
        assert.ok(hook.includes(marker), 'Missing publication protection: ' + marker);
    }
    assert.match(hook, /\[ "\$seen" -ne 1 \]/);
    assert.match(hook, /exit 1/);
});
test('pre-push retains the candidate SHA after reading stdin to EOF', () => {
    const hook = read('tools/hooks/pre-push');
    assert.match(hook, /candidate_oid=\$\(git rev-parse HEAD\)/);
    assert.match(hook, /\[ "\$local_oid" != "\$candidate_oid" \]/);
    assert.match(hook, /\[ "\$\(git rev-parse HEAD\)" != "\$candidate_oid" \]/);
    assert.doesNotMatch(hook, /\[ "\$\(git rev-parse HEAD\)" != "\$local_oid" \]/);
});
test('structural suite always includes publication-contract regressions', () => {
    const scripts = JSON.parse(read('package.json')).scripts;
    assert.equal(scripts['test:publication-hooks'], 'node --test tests/publication_hooks.test.js');
    assert.ok(scripts['test:guardrails'].startsWith('npm run --silent test:publication-hooks && '));
    assert.equal(scripts['hooks:install'], 'git config --local core.hooksPath tools/hooks');
});
