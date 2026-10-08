'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FOCUSED_TESTS,
  parseArgs,
  liveSafety
} = require('../scripts/machine-spaces-terminal-qualify');

test('terminal qualification defaults to non-live safe mode', () => {
  const options = parseArgs([]);
  assert.equal(options.chatgptLive, false);
  assert.equal(options.skipFocused, false);
  assert.equal(options.skipWindowsLive, false);
  assert.equal(options.warmTabId, null);
  assert.ok(options.timeoutMs >= 30000);
  assert.ok(FOCUSED_TESTS.includes('tests/machine-spaces-security-matrix.test.js'));
});

test('terminal qualification accepts explicit ChatGPT warm tab pin', () => {
  const options = parseArgs(['--chatgpt-live', '--warm-tab-id', '123', '--timeout-ms', '90000']);
  assert.equal(options.chatgptLive, true);
  assert.equal(options.warmTabId, 123);
  assert.equal(options.timeoutMs, 90000);
});

test('terminal qualification rejects invalid warm tab pin', () => {
  assert.throws(() => parseArgs(['--warm-tab-id', 'nope']), { code: 'QUALIFY_BAD_WARM_TAB' });
});

test('live qualification permits an idle healthy control plane', () => {
  const result = liveSafety({
    ok: true,
    recoveryRooms: 0,
    orchestration: { recovery: { active: null } },
    controlPlane: {
      providerControlPending: 0,
      controlReceiptsPending: 0,
      targetOperationsPending: 0
    }
  });
  assert.deepEqual(result, { ok: true, reasons: [] });
});

test('live qualification refuses recovery or provider-control ambiguity', () => {
  const result = liveSafety({
    ok: true,
    recoveryRooms: 1,
    orchestration: { recovery: { active: { requestId: 'uncertain' } } },
    controlPlane: {
      providerControlPending: 1,
      controlReceiptsPending: 1,
      targetOperationsPending: 1
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reasons.length, 5);
});
