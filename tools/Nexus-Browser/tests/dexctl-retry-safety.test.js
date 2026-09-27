'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const safety = require('../scripts/dexctl-retry-safety');
test('mutating SEND never retries offline or timeout responses', async () => {
  for (const code of ['DEX_UI_OFFLINE', 'DEX_CONTROL_TIMEOUT', 'DEX_CONTROL_BAD_ACTION']) {
    let calls = 0;
    const result = await safety.runWithRetry({ command: { action: 'send', text: 'Do once.' },
      requestId: 'control-exact-one', delayMs: 0,
      runImpl: async () => { calls++; return { ok: false, code }; } });
    assert.equal(calls, 1);
    assert.equal(result.dexRequestId, 'control-exact-one');
    assert.equal(result.code, code);
  }
});
test('read-only retries preserve one immutable control ID', async () => {
  const ids = [], codes = ['DEX_UI_OFFLINE', 'DEX_CONTROL_BAD_ACTION', null];
  const result = await safety.runWithRetry({ command: { action: 'targets' },
    delayMs: 0, requestId: 'control-exact-two', runImpl: async ({ requestId }) => {
      ids.push(requestId); const code = codes.shift();
      return code ? { ok: false, code } : { ok: true, action: 'targets' };
    } });
  assert.equal(result.ok, true);
  assert.deepEqual(ids, Array(3).fill('control-exact-two'));
});
test('disconnect produces an UNKNOWN one-shot report with original request ID', async () => {
  let attempts = 0;
  const result = await safety.runWithRetry({ command: { action: 'send' },
    requestId: 'control-exact-three', runImpl: async () => {
      attempts++; throw new Error('ECONNRESET');
    } });
  assert.equal(attempts, 1);
  assert.equal(result.code, 'DEX_CONTROL_OUTCOME_UNKNOWN');
  assert.equal(result.dexRequestId, 'control-exact-three');
  assert.equal(result.data.deliveryState, 'unknown');
  assert.match(result.message, /Do not replay/);
});
test('invalid manually supplied ID fails before attempting a command', async () => {
  assert.throws(() => safety.newRequestId('../bad'), /bounded/);
  assert.throws(() => safety.newRequestId('x'.repeat(200)), /bounded/);
  let calls = 0;
  await assert.rejects(safety.runWithRetry({ command: { action: 'status' },
    requestId: 'bad value', runImpl: async () => { calls++; return { ok: true }; } }), /bounded/);
  assert.equal(calls, 0);
});
