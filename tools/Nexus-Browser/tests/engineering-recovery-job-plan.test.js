'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEngineeringRecoveryJobPlan } = require('../machine-spaces/engineering-recovery-job-plan');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-recovery-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools', 'repair.js'), 'broken');
  const input = { runId: 'repair-001', expectedHead: 'a'.repeat(40), branch: 'eve/nexus-machine-spaces',
    retrySafety: 'idempotent', command: "node tools/repair.js --name 'quoted value'",
    repairFiles: ['tools/repair.js'], contextFiles: ['tools/repair.js'], invariants: ['preserve exact receipts'],
    maxAttempts: 1, target: { id: 'terminal-one', type: 'powershell', cwd: root, processEpoch: 'epoch-one' } };
  return { root, input };
}

test('recovery plan pins authority while encoding the original PowerShell command as inert data', t => {
  const f = fixture(t), plan = createEngineeringRecoveryJobPlan(f.input, { repoRoot: f.root });
  assert.match(plan.command, /eve_run\.py/);
  assert.doesNotMatch(plan.command, /quoted value/);
  assert.equal(plan.metadata.retrySafety, 'idempotent');
  assert.deepEqual(plan.metadata.repairFiles, ['tools/repair.js']);
  assert.equal(plan.commandDigest.length, 64);
});

test('recovery plan rejects replay-unsafe commands, branch drift, path traversal and target drift', t => {
  const f = fixture(t);
  for (const change of [
    { retrySafety: 'unknown' }, { branch: 'main' }, { repairFiles: ['../outside.js'] },
    { target: { ...f.input.target, cwd: path.dirname(f.root) } }
  ]) assert.throws(() => createEngineeringRecoveryJobPlan({ ...f.input, ...change }, { repoRoot: f.root }));
});
