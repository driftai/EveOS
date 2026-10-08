'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { enhanceMachineSpacesHumanGateController } = require('../machine-spaces/server-controller-human-gate');

function fixture() {
  const gateWs = new EventEmitter();
  const mutationWs = new EventEmitter();
  const outsider = new EventEmitter();
  const uiSockets = new Set([gateWs, mutationWs]);
  const sent = new Map([[gateWs, []], [mutationWs, []], [outsider, []]]);
  const handled = [];
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
    safeSend(ws, payload) { sent.get(ws)?.push(payload); return true; }
  });
  return { controller, gateWs, mutationWs, outsider, sent, handled };
}

function last(events) { return events.at(-1); }

test('Dex Machine Spaces mutations are locked server-side until Human Input is enabled', async () => {
  const f = fixture();
  await f.controller.handle(f.mutationWs, { type: 'machine_create_space', requestId: 'locked' });
  assert.equal(f.handled.length, 0);
  assert.equal(last(f.sent.get(f.mutationWs)).code, 'MACHINE_HUMAN_INPUT_LOCKED');

  await f.controller.handle(f.gateWs, { type: 'machine_set_human_input', enabled: true });
  assert.equal(last(f.sent.get(f.gateWs)).type, 'machine_human_input_state');
  assert.equal(last(f.sent.get(f.gateWs)).enabled, true);

  await f.controller.handle(f.mutationWs, { type: 'machine_create_space', requestId: 'allowed' });
  assert.deepEqual(f.handled, ['machine_create_space']);

  f.gateWs.emit('close');
  await f.controller.handle(f.mutationWs, { type: 'machine_archive_space', requestId: 'relocked' });
  assert.equal(last(f.sent.get(f.mutationWs)).code, 'MACHINE_HUMAN_INPUT_LOCKED');
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
  await f.controller.handle(f.outsider, { type: 'machine_set_human_input', enabled: true });
  assert.equal(last(f.sent.get(f.outsider)).code, 'MACHINE_LOCAL_OWNER_REQUIRED');
  assert.equal(f.controller.humanInputGate.enabled(), false);
});
