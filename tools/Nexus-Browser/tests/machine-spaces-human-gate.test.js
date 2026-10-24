'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { enhanceMachineSpacesHumanGateController } = require('../machine-spaces/server-controller-human-gate');
const { createHumanInputLeaseAuthority } = require('../dex/human-input-leases');

function fixture() {
  const gateWs = new EventEmitter();
  const mutationWs = new EventEmitter();
  const otherMutationWs = new EventEmitter();
  const outsider = new EventEmitter();
  gateWs.clientKind = 'dex';
  gateWs.uiHolderId = mutationWs.uiHolderId = 'nexus-viewer-authorized-1234';
  otherMutationWs.uiHolderId = 'nexus-viewer-other-5678';
  const uiSockets = new Set([gateWs, mutationWs, otherMutationWs]);
  const sent = new Map([[gateWs, []], [mutationWs, []], [otherMutationWs, []], [outsider, []]]);
  const handled = [];
  let stamp = Date.parse('2026-10-23T12:00:00.000Z'), token = 0;
  const humanInputAuthority = createHumanInputLeaseAuthority({
    serverEpoch: 'test-epoch', now: () => stamp,
    tokenFactory: () => `human-token-${++token}`,
    actorFactory: () => 'dex-controller-test', defaultTtlMs: 1000
  });
  const authorization = humanInputAuthority.issueHuman(gateWs, {
    scope: { type: 'room', roomId: 'room-one' }, operations: ['machine:control'], ttlMs: 1000
  });
  const approvals = {
    peek(id) {
      if (id === 'dex-approval') return { context: { kind: 'dex' } };
      if (id === 'base-approval') return { context: { kind: 'base' } };
      return null;
    }
  };
  const controller = enhanceMachineSpacesHumanGateController(() => ({
    approvals,
    providerControl: { owns: () => false, route: () => null },
    async handle(_ws, msg) { handled.push(msg.type); return true; },
    stop() {}
  }), {
    uiSockets,
    safeSend(ws, payload) { sent.get(ws)?.push(payload); return true; },
    humanInputAuthority,
    isPrimaryDex: (ws) => ws === gateWs,
    now: () => stamp,
    machineHumanTokenFactory: () => `machine-token-${++token}`
  });
  return { controller, gateWs, mutationWs, otherMutationWs, outsider, sent, handled,
    authorization, humanInputAuthority, advance(ms) { stamp += ms; } };
}

function last(events) { return events.at(-1); }

test('Dex Machine Spaces mutations are locked server-side until Human Input is enabled', async () => {
  const f = fixture();
  await f.controller.handle(f.mutationWs, { type: 'machine_create_space', requestId: 'locked' });
  assert.equal(f.handled.length, 0);
  assert.equal(last(f.sent.get(f.mutationWs)).code, 'MACHINE_HUMAN_INPUT_LOCKED');

  await f.controller.handle(f.gateWs, { type: 'machine_set_human_input', enabled: true,
    roomId: 'room-one', authorization: f.authorization });
  assert.equal(last(f.sent.get(f.gateWs)).type, 'machine_human_input_state');
  assert.equal(last(f.sent.get(f.gateWs)).enabled, true);
  const machineAuthorization = last(f.sent.get(f.gateWs)).authorization;

  await f.controller.handle(f.mutationWs, { type: 'machine_create_space', requestId: 'allowed',
    roomId: 'room-one', machineAuthorization });
  assert.deepEqual(f.handled, ['machine_create_space']);

  f.gateWs.emit('close');
  await f.controller.handle(f.mutationWs, { type: 'machine_archive_space', requestId: 'relocked',
    roomId: 'room-one', machineAuthorization });
  assert.equal(last(f.sent.get(f.mutationWs)).code, 'MACHINE_HUMAN_INPUT_LOCKED');
});

test('one viewer cannot borrow another viewer Machine Spaces authority', async () => {
  const f = fixture();
  await f.controller.handle(f.gateWs, { type: 'machine_set_human_input', enabled: true,
    roomId: 'room-one', authorization: f.authorization });
  await f.controller.handle(f.otherMutationWs, { type: 'machine_create_space', requestId: 'borrowed',
    roomId: 'room-one' });
  assert.equal(f.handled.length, 0);
  assert.equal(last(f.sent.get(f.otherMutationWs)).code, 'MACHINE_HUMAN_INPUT_LOCKED');
  const copied = last(f.sent.get(f.gateWs)).authorization;
  await f.controller.handle(f.otherMutationWs, { type: 'machine_create_space', requestId: 'copied-token',
    roomId: 'room-one', machineAuthorization: copied });
  assert.equal(f.handled.length, 0);
  assert.equal(last(f.sent.get(f.otherMutationWs)).code, 'MACHINE_HUMAN_INPUT_HOLDER_MISMATCH');
});

test('Machine Spaces authority follows room scope, lease revocation, and expiry', async () => {
  const f = fixture();
  await f.controller.handle(f.gateWs, { type: 'machine_set_human_input', enabled: true,
    roomId: 'room-one', authorization: f.authorization });
  const machineAuthorization = last(f.sent.get(f.gateWs)).authorization;
  await f.controller.handle(f.mutationWs, { type: 'machine_create_space', requestId: 'wrong-room',
    roomId: 'room-two', machineAuthorization });
  assert.equal(last(f.sent.get(f.mutationWs)).code, 'MACHINE_HUMAN_INPUT_SCOPE_MISMATCH');

  f.humanInputAuthority.revokeSocket(f.gateWs);
  await f.controller.handle(f.mutationWs, { type: 'machine_create_space', requestId: 'revoked',
    roomId: 'room-one', machineAuthorization });
  assert.equal(last(f.sent.get(f.mutationWs)).code, 'DEX_HUMAN_LEASE_REVOKED');

  const fresh = fixture();
  await fresh.controller.handle(fresh.gateWs, { type: 'machine_set_human_input', enabled: true,
    roomId: 'room-one', authorization: fresh.authorization });
  const expiring = last(fresh.sent.get(fresh.gateWs)).authorization;
  fresh.advance(1001);
  await fresh.controller.handle(fresh.mutationWs, { type: 'machine_create_space', requestId: 'expired',
    roomId: 'room-one', machineAuthorization: expiring });
  assert.equal(last(fresh.sent.get(fresh.mutationWs)).code, 'DEX_HUMAN_LEASE_EXPIRED');
});

test('Base Mode terminal creation stays independent while Dex-scoped target mutations are gated', async () => {
  const f = fixture();
  await f.controller.handle(f.mutationWs, { type: 'machine_create_target', targetType: 'pwsh' });
  assert.deepEqual(f.handled, ['machine_create_target']);

  await f.controller.handle(f.mutationWs, { type: 'machine_create_target', roomId: 'room-one', targetType: 'pwsh' });
  assert.equal(last(f.sent.get(f.mutationWs)).code, 'MACHINE_HUMAN_INPUT_LOCKED');
});

test('Dex command approval is gated from approval provenance while Base Mode approval is not', async () => {
  const f = fixture();
  await f.controller.handle(f.mutationWs, { type: 'machine_approve_command', approvalId: 'dex-approval' });
  assert.equal(last(f.sent.get(f.mutationWs)).code, 'MACHINE_HUMAN_INPUT_LOCKED');
  assert.equal(f.handled.length, 0);

  await f.controller.handle(f.mutationWs, { type: 'machine_approve_command', approvalId: 'base-approval' });
  assert.deepEqual(f.handled, ['machine_approve_command']);
});

test('non-UI sockets cannot unlock the Human Input interlock', async () => {
  const f = fixture();
  await f.controller.handle(f.outsider, { type: 'machine_set_human_input', enabled: true,
    roomId: 'room-one', authorization: f.authorization });
  assert.equal(last(f.sent.get(f.outsider)).code, 'MACHINE_LOCAL_OWNER_REQUIRED');
  assert.equal(f.controller.humanInputGate.enabled(), false);
});
