'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTloDexStateAuthority } = require('../dex/tlo-dex-state-authority');

const ARGS = {
  scopeId: 'default',
  requestId: 'dex-turn-authority-0001',
  roomId: 'room-authority-0001',
  sourceMessageId: 'msg-source-authority-0001'
};

function snapshot() {
  return {
    version: 1,
    rooms: [{
      id: ARGS.roomId,
      members: [{ id: 'member-tlo-authority-0001', binding: {
        targetClassId: 'local-origin', targetId: 'local:tlo-chat:default', providerId: 'tlo-chat'
      } }],
      messages: [{ id: ARGS.sourceMessageId, senderKind: 'user', text: 'work' }],
      finalReceipts: [],
      recovery: {
        requestId: ARGS.requestId,
        sourceMessageId: ARGS.sourceMessageId,
        memberId: 'member-tlo-authority-0001',
        targetClassId: 'local-origin',
        providerId: 'tlo-chat'
      }
    }]
  };
}

function fixture(value = snapshot()) {
  let current = structuredClone(value);
  return {
    authority: createTloDexStateAuthority({ stateStore: { load: () => structuredClone(current) } }),
    read: () => structuredClone(current),
    write: (next) => { current = structuredClone(next); }
  };
}

test('active exact TLO recovery journal authenticates the Dex source', () => {
  const f = fixture();
  assert.equal(f.authority.validateDexSource(ARGS), true);
  assert.equal(f.authority.verifyDexFinalReceipt(ARGS), null);
});

test('room, source, request and identifier mismatches fail closed', () => {
  const f = fixture();
  assert.equal(f.authority.validateDexSource({ ...ARGS, roomId: 'room-wrong-authority-0001' }), false);
  assert.equal(f.authority.validateDexSource({ ...ARGS, sourceMessageId: 'msg-wrong-authority-0001' }), false);
  assert.equal(f.authority.validateDexSource({ ...ARGS, requestId: 'dex-turn-wrong-authority-0001' }), false);
  assert.equal(f.authority.validateDexSource({ ...ARGS, roomId: '../bad' }), false);
});

test('wrong member transport or provider cannot authenticate a TLO dispatch', () => {
  const value = snapshot();
  value.rooms[0].members[0].binding.providerId = 'other-provider';
  assert.equal(fixture(value).authority.validateDexSource(ARGS), false);
  value.rooms[0].members[0].binding.providerId = 'tlo-chat';
  value.rooms[0].members[0].binding.targetId = 'local:other:default';
  assert.equal(fixture(value).authority.validateDexSource(ARGS), false);
});

test('missing source message cannot authenticate a pending recovery journal', () => {
  const value = snapshot();
  value.rooms[0].messages = [];
  assert.equal(fixture(value).authority.validateDexSource(ARGS), false);
});

test('committed source-correlated final receipt remains authoritative after journal cleanup', () => {
  const value = snapshot();
  delete value.rooms[0].recovery;
  value.rooms[0].messages.push({ id: 'msg-response-authority-0001', senderKind: 'agent', text: 'done' });
  value.rooms[0].finalReceipts.push({ requestId: ARGS.requestId,
    sourceMessageId: ARGS.sourceMessageId, messageId: 'msg-response-authority-0001', committedAt: '2026-10-24T00:00:00Z' });
  const authority = fixture(value).authority;
  assert.equal(authority.validateDexSource(ARGS), true);
  assert.deepEqual(authority.verifyDexFinalReceipt(ARGS), {
    confirmed: true,
    requestId: ARGS.requestId,
    roomId: ARGS.roomId,
    sourceMessageId: ARGS.sourceMessageId,
    finalRequestId: ARGS.requestId,
    responseMessageId: 'msg-response-authority-0001'
  });
});

test('receipt in another room or for another source is never accepted', () => {
  const value = snapshot();
  delete value.rooms[0].recovery;
  value.rooms[0].finalReceipts.push({ requestId: ARGS.requestId,
    sourceMessageId: 'msg-other-authority-0001', messageId: 'msg-response-authority-0001' });
  const f = fixture(value);
  assert.equal(f.authority.validateDexSource(ARGS), false);
  assert.equal(f.authority.verifyDexFinalReceipt(ARGS), null);
});

test('authority performs readback only and never mutates the Dex snapshot', () => {
  const f = fixture();
  const before = f.read();
  f.authority.validateDexSource(ARGS);
  f.authority.verifyDexFinalReceipt(ARGS);
  assert.deepEqual(f.read(), before);
});
