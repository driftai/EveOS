'use strict';

// Cross-owner lifecycle watchdog.
//
// This module is observation-only.
// It never calls owner mutators, retries work, changes lifecycle state,
// or converts elapsed time into success/failure/uncertainty.

const DEFAULT_POLICY = Object.freeze({
  'machine-spaces': Object.freeze({
    accepted: Object.freeze({
      agingMs: 120000,
      staleMs: 600000
    }),
    dispatched: Object.freeze({
      agingMs: 30000,
      staleMs: 120000
    }),
    'execution-started': Object.freeze({
      agingMs: 900000,
      staleMs: 3600000
    }),
    'execution-completed': Object.freeze({
      agingMs: 30000,
      staleMs: 120000
    })
  }),

  'task-completion': Object.freeze({
    accepted: Object.freeze({
      agingMs: 1800000,
      staleMs: 7200000
    }),
    'result-persisted': Object.freeze({
      agingMs: 60000,
      staleMs: 300000
    }),
    'notification-attempted': Object.freeze({
      agingMs: 30000,
      staleMs: 120000
    })
  })
});

const TERMINAL = Object.freeze({
  'machine-spaces': new Set([
    'result-persisted',
    'failed',
    'uncertain'
  ]),

  'task-completion': new Set([
    'delivered',
    'failed',
    'uncertain'
  ])
});

function watchdogError(code, message) {
  return Object.assign(
    new Error(message),
    { code }
  );
}

function validThreshold(value) {
  return Number.isSafeInteger(value) &&
    value >= 0;
}

function limitsFor(owner, stage, policy) {
  const custom = policy?.[owner]?.[stage];

  const limits = custom == null
    ? DEFAULT_POLICY?.[owner]?.[stage]
    : custom;

  if (limits == null) {
    return null;
  }

  const agingMs = limits.agingMs;
  const staleMs = limits.staleMs;

  if (
    !validThreshold(agingMs) ||
    !validThreshold(staleMs) ||
    staleMs <= agingMs
  ) {
    throw watchdogError(
      'WATCHDOG_BAD_POLICY',
      'Watchdog thresholds require non-negative agingMs and a larger staleMs.'
    );
  }

  return {
    agingMs,
    staleMs
  };
}

function assessmentBase(
  owner,
  refId,
  lifecycle
) {
  const rawAge = lifecycle?.stageAgeMs;

  return {
    owner,
    refId: String(refId || ''),
    stage: String(
      lifecycle?.currentStage || ''
    ),
    stageSince:
      lifecycle?.stageSince || null,
    stageAgeMs:
      Number.isFinite(rawAge) &&
      rawAge >= 0
        ? rawAge
        : null,

    authority: 'observe-only',
    replayAllowed: false,
    mutationAllowed: false
  };
}

function assessOne(
  owner,
  refId,
  lifecycle,
  policy
) {
  const item = assessmentBase(
    owner,
    refId,
    lifecycle
  );

  if (TERMINAL[owner]?.has(item.stage)) {
    return {
      ...item,
      status: 'terminal',
      attention: 'none',
      reason:
        'Owner reports a terminal stage; elapsed time cannot reinterpret it.'
    };
  }

  const limits = limitsFor(
    owner,
    item.stage,
    policy
  );

  if (!limits) {
    return {
      ...item,
      status: 'unknown',
      attention: 'inspect',
      reason:
        'No watchdog policy exists for this owner stage; inspect without mutation.'
    };
  }

  if (item.stageAgeMs == null) {
    return {
      ...item,
      status: 'unknown',
      attention: 'inspect',
      reason:
        'Owner did not provide a valid stage age; inspect without mutation.'
    };
  }

  if (item.stageAgeMs >= limits.staleMs) {
    return {
      ...item,
      status: 'stale',
      attention: 'inspect',
      limits,
      reason:
        'Owner-projected stage age crossed the observational stale threshold.'
    };
  }

  if (item.stageAgeMs >= limits.agingMs) {
    return {
      ...item,
      status: 'aging',
      attention: 'observe',
      limits,
      reason:
        'Owner-projected stage age crossed the observational aging threshold.'
    };
  }

  return {
    ...item,
    status: 'fresh',
    attention: 'none',
    limits,
    reason:
      'Owner-projected stage age is within the observational fresh window.'
  };
}

function assessExecutionDeliveryWatchdog(
  trace,
  {
    policy = DEFAULT_POLICY
  } = {}
) {
  if (
    !trace ||
    trace.ownership?.execution !==
      'machine-spaces' ||
    trace.ownership?.delivery !==
      'task-completion'
  ) {
    throw watchdogError(
      'WATCHDOG_BAD_TRACE',
      'Require one owner-labelled execution/delivery correlation trace.'
    );
  }

  if (
    !policy ||
    typeof policy !== 'object'
  ) {
    throw watchdogError(
      'WATCHDOG_BAD_POLICY',
      'Watchdog policy must be an object.'
    );
  }

  const items = [
    ...(Array.isArray(trace.machineSpaces)
      ? trace.machineSpaces.map((item) =>
          assessOne(
            'machine-spaces',
            item.requestId,
            item.lifecycle,
            policy
          )
        )
      : []),

    ...(Array.isArray(trace.taskCompletion)
      ? trace.taskCompletion.map((item) =>
          assessOne(
            'task-completion',
            item.id,
            item.lifecycle,
            policy
          )
        )
      : [])
  ];

  const counts = {
    fresh: 0,
    aging: 0,
    stale: 0,
    terminal: 0,
    unknown: 0
  };

  for (const item of items) {
    counts[item.status] += 1;
  }

  return {
    version: 1,

    correlation: {
      roomId:
        trace.correlation?.roomId || null,
      sourceMessageId:
        trace.correlation
          ?.sourceMessageId || null
    },

    semantics:
      'observation-only; stale means inspect, never replay or mutate',

    counts,

    attentionRequired:
      counts.stale > 0 ||
      counts.unknown > 0,

    observationRecommended:
      counts.aging > 0,

    items
  };
}

module.exports = {
  DEFAULT_POLICY,
  assessExecutionDeliveryWatchdog
};
