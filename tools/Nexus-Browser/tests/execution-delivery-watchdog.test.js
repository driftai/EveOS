'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_POLICY,
  assessExecutionDeliveryWatchdog
} = require(
  '../dex/execution-delivery-watchdog'
);

function trace({
  machine = null,
  delivery = null
} = {}) {
  return {
    correlation: {
      roomId: 'room-watchdog',
      sourceMessageId: 'message-watchdog'
    },

    ownership: {
      execution: 'machine-spaces',
      delivery: 'task-completion'
    },

    machineSpaces: machine
      ? [{
          requestId: 'machine-request-one',
          lifecycle: machine
        }]
      : [],

    taskCompletion: delivery
      ? [{
          id: 'task-completion-one',
          lifecycle: delivery
        }]
      : []
  };
}

function lifecycle(
  currentStage,
  stageAgeMs
) {
  return {
    currentStage,
    stageSince:
      '2026-10-17T20:00:00.000Z',
    stageAgeMs
  };
}

test(
  'stale is observation-only and never grants replay or owner mutation',
  () => {
    const input = trace({
      machine: lifecycle(
        'execution-started',
        DEFAULT_POLICY[
          'machine-spaces'
        ]['execution-started'].staleMs
      ),

      delivery: lifecycle(
        'notification-attempted',
        DEFAULT_POLICY[
          'task-completion'
        ]['notification-attempted'].staleMs
      )
    });

    const before =
      JSON.stringify(input);

    const result =
      assessExecutionDeliveryWatchdog(
        input
      );

    assert.equal(
      result.counts.stale,
      2
    );

    assert.equal(
      result.attentionRequired,
      true
    );

    for (const item of result.items) {
      assert.equal(
        item.status,
        'stale'
      );

      assert.equal(
        item.attention,
        'inspect'
      );

      assert.equal(
        item.authority,
        'observe-only'
      );

      assert.equal(
        item.replayAllowed,
        false
      );

      assert.equal(
        item.mutationAllowed,
        false
      );
    }

    assert.equal(
      JSON.stringify(input),
      before,
      'watchdog must not mutate owner projections'
    );
  }
);

test(
  'fresh aging and stale boundaries are deterministic',
  () => {
    const policy = {
      'machine-spaces': {
        dispatched: {
          agingMs: 100,
          staleMs: 200
        }
      }
    };

    const status = (age) =>
      assessExecutionDeliveryWatchdog(
        trace({
          machine: lifecycle(
            'dispatched',
            age
          )
        }),
        { policy }
      ).items[0].status;

    assert.equal(
      status(99),
      'fresh'
    );

    assert.equal(
      status(100),
      'aging'
    );

    assert.equal(
      status(199),
      'aging'
    );

    assert.equal(
      status(200),
      'stale'
    );
  }
);

test(
  'terminal owner truth is immune to watchdog age',
  () => {
    const result =
      assessExecutionDeliveryWatchdog(
        trace({
          machine: lifecycle(
            'result-persisted',
            Number.MAX_SAFE_INTEGER
          ),

          delivery: lifecycle(
            'delivered',
            Number.MAX_SAFE_INTEGER
          )
        })
      );

    assert.equal(
      result.counts.terminal,
      2
    );

    assert.equal(
      result.counts.stale,
      0
    );

    assert.equal(
      result.attentionRequired,
      false
    );

    assert.deepEqual(
      result.items.map(
        (item) => item.status
      ),
      [
        'terminal',
        'terminal'
      ]
    );
  }
);

test(
  'missing age or unknown future stage fails safe to inspection',
  () => {
    const result =
      assessExecutionDeliveryWatchdog(
        trace({
          machine: lifecycle(
            'execution-started',
            null
          ),

          delivery: lifecycle(
            'future-owner-stage',
            1
          )
        })
      );

    assert.equal(
      result.counts.unknown,
      2
    );

    assert.equal(
      result.attentionRequired,
      true
    );

    for (const item of result.items) {
      assert.equal(
        item.attention,
        'inspect'
      );

      assert.equal(
        item.replayAllowed,
        false
      );
    }
  }
);

test(
  'invalid thresholds fail closed rather than inventing watchdog semantics',
  () => {
    assert.throws(
      () =>
        assessExecutionDeliveryWatchdog(
          trace({
            machine: lifecycle(
              'accepted',
              50
            )
          }),

          {
            policy: {
              'machine-spaces': {
                accepted: {
                  agingMs: 100,
                  staleMs: 100
                }
              }
            }
          }
        ),

      (error) =>
        error?.code ===
        'WATCHDOG_BAD_POLICY'
    );
  }
);

test(
  'wrong or unlabeled ownership cannot enter the cross-owner watchdog',
  () => {
    assert.throws(
      () =>
        assessExecutionDeliveryWatchdog({
          ownership: {
            execution: 'task-completion',
            delivery: 'machine-spaces'
          },

          machineSpaces: [],
          taskCompletion: []
        }),

      (error) =>
        error?.code ===
        'WATCHDOG_BAD_TRACE'
    );
  }
);
