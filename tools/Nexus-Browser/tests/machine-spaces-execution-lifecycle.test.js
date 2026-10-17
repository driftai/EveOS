'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createLedger,
  recordRequest,
  markDispatched,
  markExecutionStarted,
  markExecutionCompleted,
  settle,
  lifecycleProjection,
  projection
} = require('../machine-spaces/operation-ledger');

function fixture() {
  const ledger = createLedger({ roomId: 'room1', spaceId: 'space1' });

  recordRequest(ledger, {
    roomId: 'room1',
    spaceId: 'space1',
    requestId: 'request1',
    actorMemberId: 'member1',
    sourceMessageId: 'message1',
    terminalId: 'terminal1',
    grantId: 'grant1',
    capability: 'terminal.exec',
    operationDigest: 'a'.repeat(64),
    commandSummary: 'echo lifecycle',
    createdAt: '2026-10-17T17:00:00.000Z'
  }, () => true);

  return ledger;
}

test('execution lifecycle exposes authoritative stage chronology and age', () => {
  const ledger = fixture();
  const entry = ledger.events[0];

  assert.deepEqual(
    lifecycleProjection(entry, '2026-10-17T17:00:05.000Z'),
    {
      currentStage: 'accepted',
      stageSince: '2026-10-17T17:00:00.000Z',
      stageAgeMs: 5000,
      acceptedAt: '2026-10-17T17:00:00.000Z',
      dispatchedAt: null,
      executionStartedAt: null,
      executionCompletedAt: null,
      resultPersistedAt: null
    }
  );

  markDispatched(ledger, 'request1', '2026-10-17T17:00:10.000Z');
  assert.equal(
    lifecycleProjection(entry, '2026-10-17T17:00:12.000Z').currentStage,
    'dispatched'
  );

  markExecutionStarted(
    ledger,
    'request1',
    '2026-10-17T17:00:20.000Z'
  );

  assert.equal(entry.state, 'running');
  assert.equal(
    lifecycleProjection(entry, '2026-10-17T17:00:23.000Z').currentStage,
    'execution-started'
  );

  markExecutionCompleted(
    ledger,
    'request1',
    '2026-10-17T17:00:30.000Z'
  );

  assert.deepEqual(
    lifecycleProjection(entry, '2026-10-17T17:00:34.000Z'),
    {
      currentStage: 'execution-completed',
      stageSince: '2026-10-17T17:00:30.000Z',
      stageAgeMs: 4000,
      acceptedAt: '2026-10-17T17:00:00.000Z',
      dispatchedAt: '2026-10-17T17:00:10.000Z',
      executionStartedAt: '2026-10-17T17:00:20.000Z',
      executionCompletedAt: '2026-10-17T17:00:30.000Z',
      resultPersistedAt: null
    }
  );

  settle(ledger, {
    requestId: 'request1',
    state: 'completed',
    outputId: 'output1',
    preview: 'ok',
    bytes: 2,
    exitCode: 0,
    finishedAt: '2026-10-17T17:00:40.000Z'
  });

  const final = lifecycleProjection(
    entry,
    '2026-10-17T17:00:45.000Z'
  );

  assert.equal(final.currentStage, 'result-persisted');
  assert.equal(final.resultPersistedAt, '2026-10-17T17:00:40.000Z');
  assert.equal(final.stageAgeMs, 5000);

  const publicEntry = projection(
    entry,
    '2026-10-17T17:00:45.000Z'
  );

  assert.equal(
    publicEntry.lifecycle.currentStage,
    'result-persisted'
  );
  assert.equal(
    publicEntry.lifecycle.stageAgeMs,
    5000
  );
});

test('unknown queued outcome remains uncertain and is never fabricated as execution', () => {
  const ledger = fixture();
  const entry = ledger.events[0];

  settle(ledger, {
    requestId: 'request1',
    state: 'outcome-unknown',
    finishedAt: '2026-10-17T17:01:00.000Z'
  });

  const view = lifecycleProjection(
    entry,
    '2026-10-17T17:01:03.000Z'
  );

  assert.equal(view.currentStage, 'uncertain');
  assert.equal(view.dispatchedAt, null);
  assert.equal(view.executionStartedAt, null);
  assert.equal(view.executionCompletedAt, null);
  assert.equal(view.resultPersistedAt, null);
  assert.equal(view.stageAgeMs, 3000);
});

test('spawn failure after dispatch settles without fabricating execution', () => {
  const ledger = fixture();
  const entry = ledger.events[0];

  markDispatched(
    ledger,
    'request1',
    '2026-10-17T17:02:00.000Z'
  );

  settle(ledger, {
    requestId: 'request1',
    state: 'failed',
    outputId: 'output-failed',
    preview: 'spawn failed',
    bytes: 12,
    exitCode: null,
    finishedAt: '2026-10-17T17:02:05.000Z'
  });

  const view = lifecycleProjection(
    entry,
    '2026-10-17T17:02:08.000Z'
  );

  assert.equal(entry.state, 'failed');
  assert.equal(
    view.dispatchedAt,
    '2026-10-17T17:02:00.000Z'
  );
  assert.equal(view.executionStartedAt, null);
  assert.equal(view.executionCompletedAt, null);
  assert.equal(
    view.resultPersistedAt,
    '2026-10-17T17:02:05.000Z'
  );
  assert.equal(view.currentStage, 'failed');
  assert.equal(view.stageAgeMs, 3000);
});

test('execution boundaries are monotonic and cannot be replayed', () => {
  const ledger = fixture();

  assert.throws(
    () => markExecutionStarted(
      ledger,
      'request1',
      '2026-10-17T17:00:01.000Z'
    ),
    /dispatch/i
  );

  markDispatched(
    ledger,
    'request1',
    '2026-10-17T17:00:02.000Z'
  );

  assert.throws(
    () => markDispatched(
      ledger,
      'request1',
      '2026-10-17T17:00:03.000Z'
    ),
    /dispatch/i
  );

  markExecutionStarted(
    ledger,
    'request1',
    '2026-10-17T17:00:04.000Z'
  );

  markExecutionCompleted(
    ledger,
    'request1',
    '2026-10-17T17:00:05.000Z'
  );

  assert.throws(
    () => markExecutionCompleted(
      ledger,
      'request1',
      '2026-10-17T17:00:06.000Z'
    ),
    /completion cannot be replayed/i
  );
});
