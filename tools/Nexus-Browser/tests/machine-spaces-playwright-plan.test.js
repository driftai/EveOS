'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registeredPlan, verifyPrepared } = require('../machine-spaces/playwright-job-plan');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-playwright-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'tools', 'smoke'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools', 'smoke', 'agent_nexus_browser_smoke.js'), 'console.log("TEST")\n');
  return { root, target: { type: 'cmd', cwd: root } };
}

test('registered browser proof builds one fixed command and SHA-256 pin', (t) => {
  const { root, target } = fixture(t);
  const plan = registeredPlan({ command: { action: 'playwright_prepare', scenario: 'agent-nexus-browser' }, target, repoRoot: root });
  assert.equal(plan.command, 'node tools/smoke/agent_nexus_browser_smoke.js');
  assert.match(plan.runnerSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(verifyPrepared({ stored: plan, target, repoRoot: root }), plan);
});

test('browser plan refuses arbitrary commands, URLs, JS and unknown scenarios', (t) => {
  const { root, target } = fixture(t);
  const fixed = { action: 'playwright_prepare', scenario: 'agent-nexus-browser' };
  for (const extra of [{ command: 'whoami' }, { url: 'https://example.com' }, { selector: 'body' },
      { args: ['--eval'] }, { javascript: '1+1' }, { requestId: 'injected' }]) {
    assert.throws(() => registeredPlan({ command: { ...fixed, ...extra }, target, repoRoot: root }), { code: 'MACHINE_PLAYWRIGHT_BAD_FIELD' });
  }
  assert.throws(() => registeredPlan({ command: { ...fixed, scenario: 'arbitrary' }, target, repoRoot: root }), { code: 'MACHINE_PLAYWRIGHT_UNKNOWN_SCENARIO' });
  assert.throws(() => registeredPlan({ command: fixed, target: { ...target, type: 'wsl' }, repoRoot: root }), { code: 'MACHINE_PLAYWRIGHT_BAD_TARGET' });
});

test('prepared browser proof cannot run after its registered runner changes', (t) => {
  const { root, target } = fixture(t);
  const plan = registeredPlan({ command: { action: 'playwright_prepare', scenario: 'agent-nexus-browser' }, target, repoRoot: root });
  fs.appendFileSync(path.join(root, 'tools', 'smoke', 'agent_nexus_browser_smoke.js'), '// drift');
  assert.throws(() => verifyPrepared({ stored: plan, target, repoRoot: root }), { code: 'MACHINE_PLAYWRIGHT_PLAN_CHANGED' });
});

test('managed target cannot point outside exact repository root', (t) => {
  const { root, target } = fixture(t);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-other-'));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  assert.throws(() => registeredPlan({ command: { action: 'playwright_prepare', scenario: 'agent-nexus-browser' },
    target: { ...target, cwd: other }, repoRoot: root }), { code: 'MACHINE_PLAYWRIGHT_ROOT_MISMATCH' });
});
