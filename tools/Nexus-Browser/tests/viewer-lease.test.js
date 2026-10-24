'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDexViewerLease } = require('../dex/viewer-lease');

function harness({ idle = { ok: true } } = {}) {
  const sent = [];
  const timers = [];
  let clock = 1000;
  const uiSockets = new Set([
    { id: 'dex-one', clientKind: 'dex' },
    { id: 'terminal', clientKind: 'terminal-operator' }
  ]);
  const lease = createDexViewerLease({
    uiSockets,
    safeSend(peer, payload) { sent.push({ peer: peer.id, payload }); return true; },
    isIdle: () => idle,
    now: () => clock,
    uid: () => 'lease-0001',
    setTimer(fn, delay) { const entry = { fn, delay, cleared: false }; timers.push(entry); return entry; },
    clearTimer(entry) { entry.cleared = true; }
  });
  return { lease, sent, timers, tick(value) { clock = value; } };
}

test('viewer standby lease targets only Dex viewers and expires deterministically', () => {
  const h = harness();
  const result = h.lease.begin({ requestId: 'terminal-lease-001', durationSeconds: 30 });
  assert.equal(result.ok, true);
  assert.equal(result.viewersNotified, 1);
  assert.deepEqual(h.sent.map((entry) => entry.peer), ['dex-one']);
  assert.equal(h.sent[0].payload.type, 'dex_viewer_lease');
  assert.equal(h.sent[0].payload.expiresAt, 31000);
  assert.equal(h.lease.diagnostics().active, true);
  h.tick(31001);
  assert.equal(h.lease.diagnostics().active, false);
});

test('viewer standby lease refuses active work, bad duration, and overlap', () => {
  assert.equal(harness({ idle: { ok: false, code: 'BUSY', message: 'busy' } }).lease
    .begin({ requestId: 'terminal-lease-002', durationSeconds: 30 }).code, 'BUSY');
  const h = harness();
  assert.equal(h.lease.begin({ requestId: 'terminal-lease-003', durationSeconds: 3 }).code, 'DEX_VIEWER_LEASE_BAD_DURATION');
  assert.equal(h.lease.begin({ requestId: 'terminal-lease-004', durationSeconds: 30 }).ok, true);
  assert.equal(h.lease.begin({ requestId: 'terminal-lease-005', durationSeconds: 30 }).code, 'DEX_VIEWER_LEASE_BUSY');
});
