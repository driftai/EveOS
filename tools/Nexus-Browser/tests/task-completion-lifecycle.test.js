'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  lifecycleProjection
} = require('../dex/task-completion-journal');

const registeredAt = '2026-10-17T16:00:00.000Z';
const readyAt = '2026-10-17T16:01:00.000Z';
const claimedAt = '2026-10-17T16:02:00.000Z';
const settledAt = '2026-10-17T16:03:00.000Z';

function job(state, extra = {}) {
  return {
    state,
    registeredAt,
    readyAt,
    claimedAt,
    deliveredAt: settledAt,
    ...extra
  };
}

test('delivery ownership never masquerades as authoritative completion', () => {
  const originalNow = Date.now;
  Date.now = () => 0;
  try {
    assert.deepEqual(
      lifecycleProjection(job('armed', {
        readyAt: undefined,
        claimedAt: undefined,
        deliveredAt: undefined
      })),
      {
        currentStage: 'accepted',
        stageSince: registeredAt,
        acceptedAt: registeredAt,
        resultPersistedAt: null,
        notificationAttemptedAt: null,
        deliveryOutcome: null,
        stageAgeMs: 0
      }
    );

  assert.deepEqual(
    lifecycleProjection(job('ready', {
      claimedAt: undefined,
      deliveredAt: undefined
    })),
    {
      currentStage: 'result-persisted',
      stageSince: readyAt,
      acceptedAt: registeredAt,
      resultPersistedAt: readyAt,
      notificationAttemptedAt: null,
      deliveryOutcome: null,
      stageAgeMs: 0
    }
  );

  assert.deepEqual(
    lifecycleProjection(job('sent-unconfirmed', {
      deliveredAt: undefined
    })),
    {
      currentStage: 'notification-attempted',
      stageSince: claimedAt,
      acceptedAt: registeredAt,
      resultPersistedAt: readyAt,
      notificationAttemptedAt: claimedAt,
      deliveryOutcome: null,
      stageAgeMs: 0
    }
  );

  assert.equal(
    lifecycleProjection(job('confirmed')).deliveryOutcome,
    'delivered'
  );

  assert.equal(
    lifecycleProjection(job('submission-failed')).deliveryOutcome,
    'failed'
  );

  assert.equal(
    lifecycleProjection(job('outcome-unknown', {
      deliveredAt: undefined
    })).deliveryOutcome,
    'uncertain'
  );
  } finally {
    Date.now = originalNow;
  }
});
