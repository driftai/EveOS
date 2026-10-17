'use strict';

// Read-only correlation between two independent owners:
//
//   Machine Spaces   -> execution truth
//   Task Completion  -> completion / notification / delivery truth
//
// Matching metadata NEVER grants authority and NEVER causes replay.

const machineLedger = require('../machine-spaces/operation-ledger');
const taskCompletion = require('./task-completion-journal');
const {
  assessExecutionDeliveryWatchdog
} = require('./execution-delivery-watchdog');

const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

function boundedId(value, label) {
  const text = String(value || '');

  if (!ID.test(text)) {
    const error = new Error(
      `${label} must be one bounded opaque identifier.`
    );

    error.code = 'CORRELATION_BAD_ID';

    throw error;
  }

  return text;
}

function event(owner, stage, at, refId) {
  if (!at) return null;

  return {
    owner,
    stage,
    at: String(at),
    refId: String(refId || '')
  };
}

function machineProjection(entry, now) {
  const lifecycle = machineLedger.lifecycleProjection(
    entry,
    now instanceof Date ? now : new Date(now)
  );

  const events = [
    event(
      'machine-spaces',
      'accepted',
      lifecycle.acceptedAt,
      entry.requestId
    ),
    event(
      'machine-spaces',
      'dispatched',
      lifecycle.dispatchedAt,
      entry.requestId
    ),
    event(
      'machine-spaces',
      'execution-started',
      lifecycle.executionStartedAt,
      entry.requestId
    ),
    event(
      'machine-spaces',
      'execution-completed',
      lifecycle.executionCompletedAt,
      entry.requestId
    ),
    event(
      'machine-spaces',
      'result-persisted',
      lifecycle.resultPersistedAt,
      entry.requestId
    )
  ].filter(Boolean);

  if (
    lifecycle.currentStage === 'failed' ||
    lifecycle.currentStage === 'uncertain'
  ) {
    events.push(
      event(
        'machine-spaces',
        lifecycle.currentStage,
        lifecycle.stageSince,
        entry.requestId
      )
    );
  }

  return {
    owner: 'machine-spaces',
    requestId: entry.requestId,
    spaceId: entry.spaceId,
    lifecycle,
    events
  };
}

function projectedStageAgeMs(stageSince, now) {
  if (!stageSince) return null;

  const since = Date.parse(String(stageSince));

  const current = now instanceof Date
    ? now.getTime()
    : typeof now === 'number'
      ? now
      : Date.parse(String(now));

  if (!Number.isFinite(since) || !Number.isFinite(current)) {
    return null;
  }

  return Math.max(0, current - since);
}

function deliveryProjection(job, now) {
  const lifecycle = job?.lifecycle
    ? {
        ...job.lifecycle,
        stageAgeMs: projectedStageAgeMs(
          job.lifecycle.stageSince,
          now
        )
      }
    : taskCompletion.lifecycleProjection(
        job,
        now
      );

  const events = [
    event(
      'task-completion',
      'accepted',
      lifecycle.acceptedAt,
      job.id
    ),
    event(
      'task-completion',
      'result-persisted',
      lifecycle.resultPersistedAt,
      job.id
    ),
    event(
      'task-completion',
      'notification-attempted',
      lifecycle.notificationAttemptedAt,
      job.id
    )
  ].filter(Boolean);

  if (lifecycle.deliveryOutcome) {
    events.push(
      event(
        'task-completion',
        lifecycle.deliveryOutcome,
        job.deliveredAt || lifecycle.stageSince,
        job.id
      )
    );
  }

  return {
    owner: 'task-completion',
    id: job.id,
    taskId: job.taskId,
    lifecycle,
    events
  };
}

function timestamp(value) {
  const parsed = Date.parse(String(value || ''));

  return Number.isFinite(parsed)
    ? parsed
    : Number.MAX_SAFE_INTEGER;
}

function correlateExecutionDelivery({
  roomId,
  sourceMessageId,
  machineEntries = [],
  completionJobs = [],
  now = Date.now()
} = {}) {
  const room = boundedId(roomId, 'roomId');

  const source = boundedId(
    sourceMessageId,
    'sourceMessageId'
  );

  const machine = machineEntries
    .filter(
      (entry) =>
        entry?.roomId === room &&
        entry?.sourceMessageId === source
    )
    .map(
      (entry) =>
        machineProjection(entry, now)
    );

  const delivery = completionJobs
    .filter(
      (job) =>
        job?.roomId === room &&
        job?.sourceMessageId === source
    )
    .map(
      (job) =>
        deliveryProjection(job, now)
    );

  const timeline = [
    ...machine.flatMap((item) => item.events),
    ...delivery.flatMap((item) => item.events)
  ].sort((a, b) => {
    const delta = timestamp(a.at) - timestamp(b.at);

    if (delta) return delta;

    return (
      `${a.owner}:${a.stage}:${a.refId}`
        .localeCompare(
          `${b.owner}:${b.stage}:${b.refId}`
        )
    );
  });

  const result = {
    version: 1,

    correlation: {
      roomId: room,
      sourceMessageId: source
    },

    ownership: {
      execution: 'machine-spaces',
      delivery: 'task-completion',
      semantics:
        'read-only correlation; each owner remains authoritative'
    },

    machineSpaces: machine,
    taskCompletion: delivery,
    timeline
  };

  return {
    ...result,
    watchdog:
      assessExecutionDeliveryWatchdog(result)
  };
}

module.exports = {
  correlateExecutionDelivery
};
