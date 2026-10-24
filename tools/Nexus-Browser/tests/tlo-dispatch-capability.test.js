'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTloDispatchCapabilityBroker } = require('../dex/tlo-dispatch-capability');

const BASE = { scopeId: 'default', owner: { kind: 'backend', id: 'backend-capability-test', generation: 2 },
  requestId: 'dex-turn-capability-0001', roomId: 'room-capability-0001',
  sourceMessageId: 'msg-source-capability-0001', targetId: 'local:tlo-chat:default',
  transport: 'tlo-backend-owner' };

test('dispatch capability is exact, one-use, non-reconstructable and generation-bound', () => {
  const broker = createTloDispatchCapabilityBroker({ uid: () => 'capability-test-0001' });
  const capability = broker.issue(BASE);
  assert.equal(JSON.parse(JSON.stringify(capability)).dispatchId, capability.dispatchId);
  assert.throws(() => broker.consume({ ...capability }, BASE), { code: 'TLO_DISPATCH_CAPABILITY_REQUIRED' });
  const proof = broker.consume(capability, BASE);
  assert.equal(proof.owner.generation, 2);
  assert.throws(() => broker.consume(capability, BASE), { code: 'TLO_DISPATCH_CAPABILITY_REQUIRED' });
});

test('first mismatched presentation burns the capability', () => {
  const broker = createTloDispatchCapabilityBroker({ uid: () => 'capability-test-0002' });
  const capability = broker.issue(BASE);
  assert.throws(() => broker.consume(capability, { ...BASE, roomId: 'room-capability-wrong' }),
    { code: 'TLO_DISPATCH_CAPABILITY_MISMATCH' });
  assert.throws(() => broker.consume(capability, BASE), { code: 'TLO_DISPATCH_CAPABILITY_REQUIRED' });
});

test('expired capability fails closed and cannot be replayed', () => {
  let clock = 1_000;
  const broker = createTloDispatchCapabilityBroker({ now: () => clock,
    uid: () => 'capability-test-0003', ttlMs: 1_000 });
  const capability = broker.issue(BASE);
  clock = 2_001;
  assert.throws(() => broker.consume(capability, BASE), { code: 'TLO_DISPATCH_CAPABILITY_EXPIRED' });
  assert.throws(() => broker.consume(capability, BASE), { code: 'TLO_DISPATCH_CAPABILITY_REQUIRED' });
});
