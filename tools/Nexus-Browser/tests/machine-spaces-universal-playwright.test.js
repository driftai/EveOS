'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SCENARIOS, publicScenarios, registeredPlan, verifyPrepared } = require('../machine-spaces/playwright-job-plan');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eveos-universal-playwright-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const scenario of Object.values(SCENARIOS)) {
    for (const source of [scenario.runner, ...scenario.dependencies]) {
      const full = path.join(root, ...source.split('/'));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, `module.exports = ${JSON.stringify(source)};\n`);
    }
  }
  return { root, target: { type: 'powershell', cwd: root } };
}
function plan(name, f) { return registeredPlan({ command: { action: 'playwright_prepare', scenario: name }, target: f.target, repoRoot: f.root }); }
function verify(stored, f) { return verifyPrepared({ stored, target: f.target, repoRoot: f.root }); }

test('registry exposes four cross-system qualification-only scenarios', () => {
  const scenarios = publicScenarios();
  assert.deepEqual(scenarios.map((s) => s.id).sort(), ['agent-nexus-browser', 'audioflix-queue-ui', 'bookmark-intel-ui', 'notes-worldbook-ui']);
  assert.ok(scenarios.every((s) => s.mode === 'qualification' && s.surface));
  assert.ok(scenarios.every((s) => !Object.hasOwn(s, 'command') && !Object.hasOwn(s, 'runner')));
});

test('all registered scenarios prepare fixed no-side-effect jobs and pin critical sources', (t) => {
  const f = fixture(t);
  for (const id of Object.keys(SCENARIOS)) {
    const built = plan(id, f);
    assert.equal(built.kind, 'playwright-acceptance');
    assert.equal(built.mode, 'qualification');
    assert.equal(built.command, `node ${SCENARIOS[id].runner}`);
    assert.match(built.runnerSha256, /^[a-f0-9]{64}$/);
    assert.match(built.evidenceSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(verify(built, f), built);
  }
});

test('critical dependency change invalidates already-approved job', (t) => {
  const f = fixture(t);
  for (const id of Object.keys(SCENARIOS)) {
    if (!SCENARIOS[id].dependencies.length) continue;
    const built = plan(id, f);
    const file = path.join(f.root, ...SCENARIOS[id].dependencies[0].split('/'));
    const original = fs.readFileSync(file);
    fs.appendFileSync(file, '\n// changed\n');
    assert.throws(() => verify(built, f), { code: 'MACHINE_PLAYWRIGHT_PLAN_CHANGED' });
    fs.writeFileSync(file, original);
  }
});

test('runner mutation invalidates the plan across all surfaces', (t) => {
  const f = fixture(t);
  for (const id of Object.keys(SCENARIOS)) {
    const built = plan(id, f);
    const runner = path.join(f.root, ...SCENARIOS[id].runner.split('/'));
    fs.appendFileSync(runner, '// invalidation\n');
    assert.throws(() => verify(built, f), { code: 'MACHINE_PLAYWRIGHT_PLAN_CHANGED' });
  }
});

test('provider cannot request raw browser actions or forge its own mode', (t) => {
  const f = fixture(t), command = { action: 'playwright_prepare', scenario: 'notes-worldbook-ui' };
  for (const extra of [{ script: 'evil.js' }, { url: 'https://example.com' }, { selector: 'body' },
    { javascript: '1+1' }, { mode: 'operational' }, { args: [] }, { approval: true }]) {
    assert.throws(() => registeredPlan({ command: { ...command, ...extra }, target: f.target, repoRoot: f.root }), { code: 'MACHINE_PLAYWRIGHT_BAD_FIELD' });
  }
  assert.throws(() => plan('__proto__', f), { code: 'MACHINE_PLAYWRIGHT_UNKNOWN_SCENARIO' });
  assert.throws(() => registeredPlan({ command, target: { ...f.target, type: 'wsl' }, repoRoot: f.root }), { code: 'MACHINE_PLAYWRIGHT_BAD_TARGET' });
  const built = plan(command.scenario, f);
  assert.throws(() => verify({ ...built, mode: 'operational' }, f), { code: 'MACHINE_PLAYWRIGHT_PLAN_CHANGED' });
  assert.throws(() => verify({ ...built, evidenceSha256: 'bad' }, f), { code: 'MACHINE_PLAYWRIGHT_PLAN_CHANGED' });
});

test('runner or dependency symlinks cannot escape authorized root', (t) => {
  const f = fixture(t), id = 'agent-nexus-browser';
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'eveos-browser-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const file = path.join(f.root, ...SCENARIOS[id].dependencies[0].split('/'));
  fs.unlinkSync(file);
  const destination = path.join(outside, 'other.js');
  fs.writeFileSync(destination, 'unsafe');
  try { fs.symlinkSync(destination, file); }
  catch (error) { t.skip(`Symlink unavailable: ${error.code}`); return; }
  assert.throws(() => plan(id, f), { code: 'MACHINE_PLAYWRIGHT_SOURCE_ESCAPE' });
});

test('already-queued legacy runner-only jobs retain v0 compatibility', (t) => {
  const f = fixture(t), built = plan('agent-nexus-browser', f);
  const { evidenceSha256, mode, surface, ...legacy } = built;
  const old = verify(legacy, f);
  assert.equal(old.runnerSha256, built.runnerSha256);
  assert.equal(old.command, built.command);
  assert.match(evidenceSha256, /^[a-f0-9]{64}$/);
});

test('scenario preparation refuses foreign terminal root', (t) => {
  const f = fixture(t);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'eveos-playwright-other-'));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  assert.throws(() => registeredPlan({ command: { action: 'playwright_prepare', scenario: 'agent-nexus-browser' },
    target: { type: 'cmd', cwd: other }, repoRoot: f.root }), { code: 'MACHINE_PLAYWRIGHT_ROOT_MISMATCH' });
});
