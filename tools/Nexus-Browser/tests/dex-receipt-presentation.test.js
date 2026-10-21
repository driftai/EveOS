'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { present } = require('../public/dex-receipt-presentation');

test('verified engineering completion is green and preserves canonical evidence IDs', () => {
  const value = present({ text: 'technical body', engineeringIncident: {
    jobId: 'machine-job-1', requestId: 'request-1', roomId: 'room-1', spaceId: 'space-1',
    targetId: 'terminal-1', outputId: 'output-1', state: 'completed', classification: 'completed', exitCode: 0
  }, engineeringVerification: { state: 'completed', exitCode: 0, outcome: 'GREEN', receipt: 'data/runtime/receipt.json' } });
  assert.equal(value.tone, 'success');
  assert.equal(value.label, 'Verified success');
  assert.deepEqual(value.technical.ids, { jobId: 'machine-job-1', requestId: 'request-1', roomId: 'room-1',
    spaceId: 'space-1', terminalId: 'terminal-1', outputId: 'output-1', receipt: 'data/runtime/receipt.json' });
  assert.match(value.rows.find(([name]) => name === 'Publication')[1], /Not reported/);
});

test('queued preparation, quota limit and failed delivery never render as success', () => {
  const queued = present({ text: 'queued', controlReceipt: { requestId: 'r1', action: 'governor_prepare', ok: true } });
  assert.equal(queued.tone, 'warning');
  assert.equal(queued.label, 'Prepared');
  assert.match(queued.title, /not completed/i);
  const quota = present({ text: 'quota', engineeringIncident: { state: 'failed', classification: 'resource-limited', errorCode: 'LOW_QUOTA_RESERVE' } });
  assert.equal(quota.tone, 'danger');
  const relay = present({ text: 'offline', relayFailure: true, turnRequestId: 'turn-1' });
  assert.equal(relay.tone, 'danger');
});

test('approval and recovery preparation remain neutral or amber until verified', () => {
  assert.equal(present({ supervisedApproval: { jobId: 'job-1' } }).tone, 'neutral');
  assert.equal(present({ engineeringRecoveryPrepared: { recoveryJobId: 'job-2', state: 'approval-pending' } }).tone, 'warning');
  assert.equal(present({ engineeringRecoveryPrepared: { recoveryJobId: 'job-2', state: 'running' } }).tone, 'neutral');
});
