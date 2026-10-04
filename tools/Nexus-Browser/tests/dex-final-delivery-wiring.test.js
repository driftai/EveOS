'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFinalDelivery } = require('../extension/dex-final-delivery-wiring');

function storage() {
  let data = {};
  return {
    async get() { return structuredClone(data); },
    async set(next) { data = structuredClone({ ...data, ...next }); },
    dump: () => structuredClone(data)
  };
}

function submitFinal(delivery, message, tabId, provider) {
  return new Promise((resolve) => {
    const keepChannel = delivery.onFinal(message, { tab: { id: tabId } }, resolve, provider);
    assert.equal(keepChannel, true);
  });
}

const provider = { id: 'chatgpt', name: 'ChatGPT', capabilities: {} };

test('more than sixteen Base finals deliver directly without occupying the Dex outbox', async () => {
  const sent = [], completed = [], stopped = [];
  const disk = storage();
  const delivery = createFinalDelivery({
    storage: disk,
    send: (message) => { sent.push(message); return true; },
    stopPolling: (id) => stopped.push(id),
    rememberCompleted: (id) => completed.push(id)
  });
  for (let index = 0; index < 24; index += 1) {
    const requestId = `base-turn-${index}`;
    const receipt = await submitFinal(delivery,
      { type: 'response_final', requestId, text: `reply ${index}` }, 42, provider);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.durable, false);
  }
  assert.equal(sent.length, 24);
  assert.equal(completed.length, 24);
  assert.equal(stopped.length, 24);
  assert.equal(delivery.diagnostics().pending, 0);
  assert.equal(delivery.diagnostics().queued, 0);
});

test('Dex finals still use durable delivery and do not complete until the committed receipt', async () => {
  const sent = [], completed = [];
  const delivery = createFinalDelivery({
    storage: storage(),
    send: (message) => { sent.push(message); return true; },
    stopPolling: () => {},
    rememberCompleted: (id) => completed.push(id)
  });
  const requestId = 'dex-turn-12345678';
  const receipt = await submitFinal(delivery,
    { type: 'response_final', requestId, text: 'durable reply' }, 42, provider);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.queued, true);
  assert.equal(delivery.diagnostics().pending, 1);
  assert.deepEqual(completed, []);
  assert.equal(delivery.onReceipt({ type: 'dex_turn_receipt', requestId, state: 'committed' }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(completed, [requestId]);
  assert.equal(delivery.diagnostics().pending, 0);
});

test('an offline Base final stays outside durable storage so the content watcher can retry it', async () => {
  const completed = [];
  const delivery = createFinalDelivery({
    storage: storage(),
    send: () => false,
    stopPolling: () => {},
    rememberCompleted: (id) => completed.push(id)
  });
  const receipt = await submitFinal(delivery,
    { type: 'response_final', requestId: 'base-offline', text: 'retry me' }, 42, provider);
  assert.equal(receipt.ok, false);
  assert.match(receipt.error, /websocket/i);
  assert.equal(delivery.diagnostics().pending, 0);
  assert.deepEqual(completed, []);
});
