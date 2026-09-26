'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../machine-spaces/operation-ledger');
const roomId = 'room-one', spaceId = 'machine-one';
const base = { roomId, spaceId, requestId: 'req-one', actorMemberId: 'eve',
  sourceMessageId: 'msg-one', terminalId: 'terminal-ps-one', grantId: 'grant-read-one',
  capability: 'files.list', commandSummary: 'List approved directory', createdAt: '2026-09-26T00:00:00Z' };
const allow = () => true;
const deny = () => false;
function assertCode(action, code) { assert.throws(action, (error) => error.code === code); }
test('origin-linked machine output remains outside ordinary room messages', () => {
  const ledger = m.createLedger({ roomId, spaceId });
  const result = m.recordRequest(ledger, base, allow);
  assert.equal(result.deduplicated, false);
  assert.equal(result.entry.sourceMessageId, base.sourceMessageId);
  assert.equal(result.entry.terminalId, base.terminalId);
  m.markRunning(ledger, base.requestId);
  const done = m.settle(ledger, { requestId: base.requestId, state: 'completed',
    outputId: 'output-one', preview: 'file.txt', bytes: 8, exitCode: 0 });
  assert.equal(done.entry.outputId, 'output-one');
  assert.equal(done.entry.preview, 'file.txt');
  assert.equal(done.entry.exitCode, 0);
  assert.equal(m.projection(done.entry).intentDigest, undefined);
  assert.equal(Object.hasOwn(done.entry, 'stdout'), false);
});
test('auth is mandatory, scoped to caller-supplied verified broker callback and rechecked on duplicate', () => {
  const ledger = m.createLedger({ roomId, spaceId });
  assertCode(() => m.recordRequest(ledger, base), 'MACHINE_AUTH_REQUIRED');
  assertCode(() => m.recordRequest(ledger, base, deny), 'MACHINE_ACCESS_DENIED');
  assert.equal(ledger.events.length, 0);
  m.recordRequest(ledger, base, allow);
  assertCode(() => m.recordRequest(ledger, base, deny), 'MACHINE_ACCESS_DENIED');
  assert.equal(m.recordRequest(ledger, base, allow).deduplicated, true);
  assertCode(() => m.recordRequest(ledger, { ...base, terminalId: 'terminal-other' }, allow),
    'MACHINE_REQUEST_ID_CONFLICT');
});
test('no cross-room request, unknown capability, malformed identifier or unreferenced completion', () => {
  const ledger = m.createLedger({ roomId, spaceId });
  assertCode(() => m.recordRequest(ledger, { ...base, roomId: 'other' }, allow), 'MACHINE_SCOPE_MISMATCH');
  assertCode(() => m.recordRequest(ledger, { ...base, capability: 'terminal.runAsAdmin' }, allow),
    'MACHINE_BAD_CAPABILITY');
  assertCode(() => m.recordRequest(ledger, { ...base, grantId: '../secret' }, allow), 'MACHINE_BAD_ID');
  assertCode(() => m.settle(ledger, { requestId: 'missing', state: 'completed', outputId: 'one' }),
    'MACHINE_NOT_FOUND');
});
test('dispatch is at most once and uncertain execution is terminal', () => {
  const ledger = m.createLedger({ roomId, spaceId });
  m.recordRequest(ledger, base, allow);
  m.markRunning(ledger, base.requestId);
  assertCode(() => m.markRunning(ledger, base.requestId), 'MACHINE_ALREADY_DISPATCHED');
  const unknown = m.settle(ledger, { requestId: base.requestId, state: 'outcome-unknown' });
  assert.equal(unknown.entry.outputId, null);
  assert.equal(m.settle(ledger, { requestId: base.requestId, state: 'outcome-unknown' }).deduplicated, true);
  assertCode(() => m.settle(ledger, { requestId: base.requestId, state: 'completed',
    outputId: 'late' }), 'MACHINE_ALREADY_SETTLED');
});
test('completed state cannot be changed and retained preview is bounded', () => {
  const ledger = m.createLedger({ roomId, spaceId });
  m.recordRequest(ledger, base, allow);
  m.markRunning(ledger, base.requestId);
  assertCode(() => m.settle(ledger, { requestId: base.requestId, state: 'completed' }),
    'MACHINE_OUTPUT_REQUIRED');
  const done = m.settle(ledger, { requestId: base.requestId, state: 'completed', outputId: 'out',
    preview: 'X'.repeat(100000), bytes: 100000 });
  assert.equal(done.entry.preview.length, m.MAX_PREVIEW);
  assertCode(() => m.settle(ledger, { requestId: base.requestId, state: 'failed',
    outputId: 'different' }), 'MACHINE_ALREADY_SETTLED');
});
