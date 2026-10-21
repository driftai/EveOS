'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_PHASE3_FAILURE_MARKER, argumentsFor, waitForProposal } = require('../scripts/dex-phase3-engineering-playwright-qualify');

test('Phase 3 Playwright qualifier requires an exact room and bounded selection token', () => {
  assert.equal(DEFAULT_PHASE3_FAILURE_MARKER, 'PHASE3_CONTROLLED_FAILURE');
  assert.deepEqual(argumentsFor(['--room', 'room-phase3proof', '--timeout', '90']), {
    roomId: 'room-phase3proof', jobId: '', token: DEFAULT_PHASE3_FAILURE_MARKER, timeoutMs: 90000, headless: true
  });
  assert.equal(argumentsFor(['--room', 'room-phase3proof', '--job', 'machine-job-phase3proof']).jobId,
    'machine-job-phase3proof');
  assert.throws(() => argumentsFor(['--room', 'Phase Three']), /exact Dex room/);
  assert.throws(() => argumentsFor(['--room', 'room-phase3proof', '--job', 'unsafe']), /exact supervised job ID/);
  assert.throws(() => argumentsFor(['--room', 'room-phase3proof', '--token', 'x\nstart']), /plain text/);
});

test('Phase 3 proposal wait accepts only a scheduled exact-job proposal', async () => {
  const expected = {
    schema: 'eveos.machine-spaces.engineering-proposal.v1', incidentJobId: 'machine-job-phase3proof',
    classification: 'confirmed-command-or-test-failure', summary: 'Expected controlled failure.', confidence: 1,
    requestedEvidence: [], repair: { kind: 'none', paths: [], description: 'No repair required.' }, retryIntent: 'none'
  };
  const result = await waitForProposal('room-phase3proof', 'machine-job-phase3proof', 1000, async () => ({
      engineeringIncidentCount: 1,
      engineeringIncidents: [{ jobId: 'machine-job-phase3proof', dispatch: 'scheduled', classification: expected.classification }],
      messages: [
        { senderKind: 'system', senderName: 'Machine Spaces', text: 'job=machine-job-phase3proof' },
        { id: 'msg-proposal', senderKind: 'agent', senderName: 'TLO', text: JSON.stringify(expected) }
      ]
    }));
  assert.equal(result.proposal.ok, true);
  assert.equal(result.responseMessageId, 'msg-proposal');
});
