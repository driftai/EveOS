'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { evidenceProjection, inspectGovernorRuns } = require('../machine-spaces/governor-run-inspect');

const SHA = 'a'.repeat(40);
function receipt(state = 'QUALIFIED') {
  return { schema: 'eveos.agent-governor.v1', state, updatedAt: '2026-10-18T05:00:00Z',
    branch: 'eve/nexus-machine-spaces', expectedHead: SHA,
    plan: { model: 'gpt-5.6-terra', effort: 'medium' },
    missionText: 'PRIVATE_MISSION_CANARY', allowedFiles: ['private.ts'],
    dispatchDecision: { permitted: true }, published: SHA,
    credentials: 'PRIVATE_TOKEN_CANARY' };
}
test('projection is a strict allowlist, never a disclosure of mission, paths or secrets', () => {
  const value = evidenceProjection(receipt('PUBLISHED'), 'run-1');
  assert.equal(value.model, 'gpt-5.6-terra');
  assert.equal(value.published, SHA);
  assert.equal(value.quotaPermitted, true);
  const text = JSON.stringify(value);
  assert.doesNotMatch(text, /PRIVATE_MISSION_CANARY|PRIVATE_TOKEN_CANARY|private\.ts/);
});
test('only a valid published state exposes the published SHA', () => {
  assert.equal(evidenceProjection(receipt('QUALIFIED'), 'run-1').published, null);
  assert.equal(evidenceProjection({ ...receipt(), schema: 'other' }, 'run-1'), null);
});
test('reads bounded receipts, ignores invalid/corrupt and symlink escapes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-governor-evidence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'run-1'));
  fs.writeFileSync(path.join(dir, 'run-1', 'receipt.json'), JSON.stringify(receipt('PUBLISHED')));
  fs.mkdirSync(path.join(dir, 'run-2'));
  fs.writeFileSync(path.join(dir, 'run-2', 'receipt.json'), '{corrupt');
  fs.mkdirSync(path.join(dir, 'run-3'));
  fs.writeFileSync(path.join(dir, 'run-3', 'receipt.json'), 'x'.repeat(65 * 1024));
  assert.equal(inspectGovernorRuns({ evidenceRoot: dir }).runs.length, 1);
  assert.equal(inspectGovernorRuns({ evidenceRoot: dir, maxRuns: 1 }).runs[0].runId, 'run-1');
  try {
    fs.symlinkSync(path.join(dir, 'run-1'), path.join(dir, 'run-escape'), 'dir');
    assert.equal(inspectGovernorRuns({ evidenceRoot: dir }).runs.length, 1);
  } catch (err) { if (err.code !== 'EPERM') throw err; }
});
test('missing evidence is not fabricated and path input is not accepted as a run id', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-governor-empty-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(inspectGovernorRuns({ evidenceRoot: dir }).state, 'EMPTY');
  assert.equal(inspectGovernorRuns({ evidenceRoot: dir + '-missing' }).state, 'EMPTY');
  assert.equal(evidenceProjection(receipt(), '../../escape'), null);
  // The scanner sources run IDs ONLY from bounded directory entry names, never a caller string.
});
