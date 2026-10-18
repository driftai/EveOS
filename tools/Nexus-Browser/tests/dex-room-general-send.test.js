'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTerminalOperator } = require('../dex/terminal-operator');
const { routeTerminalOperator } = require('../dex/server-terminal-operator-route');
const ROOM = 'room-regular123456';
function fixture() {
  let snapshot = { rooms: [{ id: ROOM, name: 'Two-agent room', messages: [],
    members: [{ id: 'agent-one', name: 'Agent One', relayEnabled: true, binding: { targetClassId: 'local-origin', targetId: 'local:one', providerId: 'local-one' } }],
    relay: { active: false }, settings: { maxTurns: 8 } }] };
  let launches = 0;
  const operator = createTerminalOperator({ load: () => structuredClone(snapshot),
    save: v => { snapshot = structuredClone(v); return snapshot; },
    scheduler: { startRelay: () => { launches++; return { ok: true }; } }, uid: () => 'test',
    broadcastState: () => {} });
  return { operator, snapshot: () => snapshot, launches: () => launches };
}
test('normal Dex room permits one ordinary user message and one scheduled turn', () => {
  const f=fixture(); const requestId='terminal-general-0001';
  const out=f.operator.handle({ type:'dex_terminal_room_send',requestId,roomId:ROOM,text:'Hello, agent!' });
  assert.equal(out.ok,true);assert.equal(out.agent,'Dex room');assert.equal(out.machineSpaceId,null);assert.equal(f.launches(),1);
  assert.equal(f.snapshot().rooms[0].messages[0].senderKind,'user');
  f.snapshot().rooms[0].messages.push({id:'agent-reply',senderKind:'agent',senderId:'agent-one',text:'Hello back.'});
  f.snapshot().rooms[0].finalReceipts=[{messageId:'agent-reply',requestId:'dex-turn-test'}];
  const done=f.operator.handle({type:'dex_terminal_check',requestId:'check-general-001',lookupId:requestId,roomId:ROOM});
  assert.equal(done.status,'FINAL_RECEIPT_CONFIRMED');assert.equal(done.response.text,'Hello back.');
});
test('room with no relay-enabled agent cannot receive a terminal send', () => {
  const f=fixture();f.snapshot().rooms[0].members[0].relayEnabled=false;
  const out=f.operator.handle({type:'dex_terminal_room_send',requestId:'terminal-general-0001',roomId:ROOM,text:'Hi'});
  assert.equal(out.code,'DEX_TERMINAL_NO_AGENT');assert.equal(f.launches(),0);
});

test('general room send is localhost-only and provider-control remains forbidden', () => {
  const f=fixture(), socket={ remoteAddress:'127.0.0.1', terminalOperatorOrigin:null };
  const good=routeTerminalOperator(socket,{type:'dex_terminal_room_send',requestId:'terminal-general-0001',roomId:ROOM,text:'Hello'},f.operator);
  assert.equal(good.result.ok,true);
  assert.equal(routeTerminalOperator({...socket,terminalOperatorOrigin:'http://evil.example'},
    {type:'dex_terminal_room_send',requestId:'terminal-general-0002',roomId:ROOM,text:'Hello'},f.operator).code,'DEX_TERMINAL_LOCAL_ONLY');
  assert.equal(routeTerminalOperator(socket,{type:'provider_control_request',requestId:'terminal-general-0002'},f.operator).code,'DEX_TERMINAL_ACTION_DENIED');
});
