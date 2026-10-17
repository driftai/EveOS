'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createFinalDelivery
} = require(
  '../extension/dex-final-delivery-wiring'
);

const {
  KEY
} = require(
  '../extension/dex-final-receipt'
);

function storage() {
  let data = {};

  return {
    async get() {
      return structuredClone(data);
    },

    async set(next) {
      data = structuredClone({
        ...data,
        ...next
      });
    },

    dump() {
      return structuredClone(data);
    }
  };
}

async function settleAsync() {
  await new Promise(
    (resolve) => setImmediate(resolve)
  );

  await new Promise(
    (resolve) => setImmediate(resolve)
  );
}

const provider = {
  id: 'chatgpt',
  name: 'ChatGPT',
  capabilities: {}
};

test(
  'captured Dex final becomes durable before polling stops and completes only after ACK',
  async () => {
    const disk = storage();

    const sent = [];
    const stopped = [];
    const completed = [];
    const delivered = [];

    let durableWhenStopped = false;

    const requestId =
      'dex-captured-ack-12345678';

    const delivery = createFinalDelivery({
      storage: disk,

      send(message) {
        sent.push(message);
        return true;
      },

      stopPolling(id) {
        const pending =
          disk.dump()[KEY] || [];

        durableWhenStopped =
          pending.some(
            (entry) =>
              entry.requestId === id
          );

        stopped.push(id);
      },

      rememberCompleted(id) {
        completed.push(id);
      },

      afterDelivered(id) {
        delivered.push(id);
      }
    });

    const captured =
      await delivery.onCaptured(
        {
          type: 'response_final',
          requestId,
          text:
            'Recovered durable Dex reply.'
        },
        42,
        provider
      );

    assert.equal(
      captured,
      true
    );

    assert.equal(
      durableWhenStopped,
      true,
      'capture must become durable before provider polling is released'
    );

    assert.deepEqual(
      stopped,
      [requestId]
    );

    assert.deepEqual(
      delivered,
      [requestId]
    );

    assert.deepEqual(
      completed,
      [],
      'durable capture is not authoritative completion'
    );

    assert.equal(
      delivery.diagnostics().pending,
      1
    );

    assert.deepEqual(
      (disk.dump()[KEY] || [])
        .map((entry) => entry.requestId),
      [requestId]
    );

    assert.ok(
      sent.some(
        (message) =>
          message.requestId === requestId
      )
    );

    assert.equal(
      delivery.onReceipt({
        type: 'dex_turn_receipt',
        requestId,
        state: 'committed'
      }),
      true
    );

    await settleAsync();

    assert.deepEqual(
      completed,
      [requestId],
      'committed Dex receipt owns global completion'
    );

    assert.equal(
      delivery.diagnostics().pending,
      0
    );

    assert.deepEqual(
      disk.dump()[KEY] || [],
      []
    );
  }
);

test(
  'captured Dex final remains incomplete without a terminal receipt',
  async () => {
    const disk = storage();
    const completed = [];

    const requestId =
      'dex-captured-unconfirmed-12345678';

    const delivery = createFinalDelivery({
      storage: disk,

      send: () => false,

      stopPolling: () => {},

      rememberCompleted(id) {
        completed.push(id);
      }
    });

    assert.equal(
      await delivery.onCaptured(
        {
          type: 'response_final',
          requestId,
          text:
            'Persist even while transport is unavailable.'
        },
        42,
        provider
      ),
      true
    );

    assert.equal(
      delivery.diagnostics().pending,
      1
    );

    assert.deepEqual(
      completed,
      []
    );

    await settleAsync();

    assert.deepEqual(
      completed,
      [],
      'absence of ACK must never become completion'
    );

    assert.equal(
      delivery.diagnostics().pending,
      1
    );
  }
);

test(
  'service worker preserves captured-final and receipt ownership wiring',
  () => {
    const worker = fs.readFileSync(
      path.join(
        __dirname,
        '../extension/service-worker.js'
      ),
      'utf8'
    );

    assert.match(
      worker,
      /createForServiceWorker\([\s\S]{0,500}rememberCompletedRequest[\s\S]{0,200}emitError\)/
    );

    assert.match(
      worker,
      /finalDelivery\.onCaptured\s*\(/
    );

    assert.match(
      worker,
      /finalDelivery\.onReceipt\s*\(/
    );

    const creation =
      worker.indexOf(
        'finalWiringApi.createForServiceWorker'
      );

    const completionOwner =
      worker.indexOf(
        'rememberCompletedRequest',
        creation
      );

    assert.ok(
      creation >= 0 &&
      completionOwner > creation,
      'service worker must bind global completion through final delivery'
    );
  }
);
