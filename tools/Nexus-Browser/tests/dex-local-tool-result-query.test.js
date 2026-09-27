'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const api = require('../dex/room-tools');
const astro = { targetClassId: 'local-origin', targetId: 'local:antigravity-existing:25032',
  providerId: 'local-antigravity-existing' };
const other = { ...astro, targetId: 'local:antigravity-existing:25033' };
const snapshot = () => ({ rooms: [{ id: 'room-one', name: 'Eve + Astro',
  relay: { active: false }, members: [
    { id: 'astro', binding: astro }, { id: 'other', binding: other }
  ], localToolResults: [
    { memberId: 'astro', providerId: astro.providerId, targetId: astro.targetId,
      requestId: 'control-one', state: 'queued', text: 'PRIVATE-CONTROL-RESULT' },
    { memberId: 'other', providerId: other.providerId, targetId: other.targetId,
      requestId: 'control-two', state: 'outcome-unknown', text: 'OTHER-PRIVATE' }
  ] }] });
test('exact read-only receipt lookup cannot leak another local member result', () => {
  const state = snapshot();
  const result = api.execute(state, { source: astro,
    command: { action: 'tool_result_status', room: 'room-one' } });
  assert.equal(result.changed, false);
  assert.deepEqual(result.result.data.receipts.map(e => [e.requestId, e.state]),
    [['control-one', 'queued']]);
  assert.doesNotMatch(JSON.stringify(result.result), /OTHER-PRIVATE|PRIVATE-CONTROL-RESULT|control-two/);
  assert.equal(api.execute(state, { source: other, command: {
    action: 'tool_result_status', room: 'room-one', requestId: 'control-one'
  } }).result.code, 'DEX_LOCAL_RESULT_NOT_FOUND');
});
test('unbound source and invalid exact IDs fail closed without replay', () => {
  const state = snapshot();
  assert.equal(api.execute(state, { source: astro, command: {
    action: 'tool_result_status', room: 'room-one', requestId: '../path'
  } }).result.code, 'DEX_LOCAL_RESULT_BAD_ID');
  assert.equal(api.execute(state, { source: { ...astro, targetId: 'local:antigravity-existing:999' },
    command: { action: 'tool_result_status', room: 'room-one' } }).result.code, 'DEX_ROOM_NOT_BOUND');
  assert.equal(api.execute(state, { source: astro, command: {
    action: 'tool_result_status', room: 'room-one', requestId: 'control-one'
  } }).result.data.receipts.length, 1);
});
test('protocol, headed provider and CLI all recognize the exact read-only action', () => {
  const protocol = require('../public/dex-protocol');
  const content = require('../extension/content/dex-provider-control');
  const cli = require('../scripts/dexctl');
  assert.equal(protocol.parseAgentReply('Complete.\n[[DEX:CMD {"action":"tool_result_status"}]]')
    .providerControlCommand.action, 'tool_result_status');
  assert.equal(content.parseTrailingCommand('[[DEX:CMD {"action":"tool_result_status"}]]')
    .command.action, 'tool_result_status');
  const command = cli.commandFrom(cli.parseArgs(['tool-result-status', '--agy-pid', '25032',
    '--room', 'room-one', '--request-id', 'control-one']));
  assert.deepEqual(command, { action: 'tool_result_status', room: 'room-one', requestId: 'control-one' });
});

test('direct CLI send can be inspected by original request ID without replaying it', () => {
  const state = snapshot(), room = state.rooms[0];
  room.messages = [{ id: 'msg-one', clientRequestId: 'cli-one', senderId: 'astro',
    senderKind: 'agent', text: 'private message' }];
  room.deferredSendReceipts = [{ requestId: 'cli-one', senderId: 'astro',
    messageId: 'msg-one', phase: 'queued', at: '2026-09-27T13:00:00Z' },
    { requestId: 'cli-other', senderId: 'other', messageId: 'msg-two',
      phase: 'batched' }];
  const result = api.execute(state, { source: astro,
    command: { action: 'tool_result_status', room: 'room-one', requestId: 'cli-one' } });
  assert.equal(result.changed, false);
  assert.equal(result.result.data.receipts[0].kind, 'direct-send');
  assert.equal(result.result.data.receipts[0].commitState, 'committed');
  assert.equal(result.result.data.receipts[0].state, 'queued');
  assert.doesNotMatch(JSON.stringify(result.result), /private message|cli-other/);
  assert.equal(api.execute(state, { source: other, command: {
    action: 'tool_result_status', room: 'room-one', requestId: 'cli-one'
  } }).result.code, 'DEX_LOCAL_RESULT_NOT_FOUND');
});
test('a captured send preserves both its tool result and direct FIFO receipt under one ID', () => {
  const state = snapshot(), room = state.rooms[0];
  room.localToolResults[0].requestId = 'cli-one';
  room.messages = [{ id: 'msg-one', clientRequestId: 'cli-one', senderId: 'astro',
    senderKind: 'agent' }];
  room.deferredSendReceipts = [{ requestId: 'cli-one', senderId: 'astro',
    messageId: 'msg-one', phase: 'queued', at: '2026-09-27T13:00:00Z' }];
  const reply = api.execute(state, { source: astro, command: {
    action: 'tool_result_status', room: 'room-one', requestId: 'cli-one'
  } }).result;
  assert.deepEqual(reply.data.receipts.map(x => x.kind), ['control-result', 'direct-send']);
});
