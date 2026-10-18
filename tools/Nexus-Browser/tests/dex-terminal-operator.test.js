'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const operatorPath = path.resolve(__dirname, '../dex/terminal-operator.js');
function loadModule() {
  // Isolated test uses the same ownership contract as the real server:
  // durable state save and the existing scheduler.startRelay API.
  const original = Module._load;
  Module._load = function(request, parent, main) {
    if (parent?.filename === operatorPath && request === './server-scheduler-state') return {
      roomById: (state, id) => state.rooms.find(r => r.id === id),
      addMessage: (room, msg) => {const row={...msg,text:msg.text.trim()};room.messages.push(row);return row;}
    };
    if (parent?.filename === operatorPath && request === './server-state-merge') return {
      runtimeBusy: room => !!(room.recovery || room.pendingTurn || room.pendingProviderControlReceipt || room.relay?.active || room.relay?.waitingFor || room.deferredRelays?.length)
    };
    return original.apply(this, arguments);
  };
  try { delete require.cache[operatorPath]; return require(operatorPath); }
  finally { Module._load = original; }
}
const { createTerminalOperator } = loadModule();
const ROOM='room-test000001', ID='operator-test-0001';
function fixture({ tlo = true, space = true, busy = false } = {}) {
  let state={rooms:[{ id:ROOM,name:'Proof',userName:'Drift',messages:[],members:tlo?[{id:'member-tlo',name:'TLO',relayEnabled:true,binding:{targetClassId:'local-origin',targetId:'local:tlo-chat:default',providerId:'tlo-chat'}}]:[],
    machineSpaces:{spaces:space?[{id:'space-test',resourceIds:['terminal-test']}]:[]},relay:{active:busy,remaining:0},settings:{maxTurns:1}}]};
  let saves=0, starts=0, broadcasts=0;
  const coordinator=createTerminalOperator({load:()=>structuredClone(state),save:s=>{saves++;state=structuredClone(s);return structuredClone(state);},scheduler:{startRelay:arg=>{starts++;return {ok:true,...arg};}},broadcastState:()=>{broadcasts++;},uid:()=>`test-${saves}`});
  function run(type, extra={}) {return coordinator.handle({type,roomId:ROOM,requestId:ID,...extra});}
  return {run,state:()=>state,saves:()=>saves,starts:()=>starts,broadcasts:()=>broadcasts};
}
test('user-origin message is committed before exact one-turn Dex scheduler dispatch',()=>{
  const f=fixture();const r=f.run('dex_terminal_send',{text:'Read-only: explain your room role.'});
  assert.equal(r.ok,true);assert.equal(r.deliveryConfirmed,false);assert.equal(r.status,'MESSAGE_COMMITTED_RELAY_ACCEPTED');
  assert.equal(f.saves(),1);assert.equal(f.starts(),1);
  assert.equal(f.state().rooms[0].messages[0].senderKind,'user');
  assert.equal(f.state().rooms[0].messages[0].clientRequestId,ID);
});
test('repeat request is idempotent; conflicting content is never overwritten',()=>{
  const f=fixture();f.run('dex_terminal_send',{text:'Hello'});
  const d=f.run('dex_terminal_send',{text:'Hello'});
  assert.equal(d.ok,true);assert.equal(d.deduplicated,true);assert.equal(f.starts(),1);assert.equal(f.saves(),1);
  const conflict=f.run('dex_terminal_send',{text:'Different'});
  assert.equal(conflict.code,'DEX_TERMINAL_REQUEST_CONFLICT');assert.equal(f.starts(),1);
});
test('no TLO, no machine attachment, busy room and invalid room fail closed',()=>{
  assert.equal(fixture({tlo:false}).run('dex_terminal_send',{text:'hi'}).code,'DEX_TERMINAL_TLO_ONLY');
  assert.equal(fixture({space:false}).run('dex_terminal_send',{text:'hi'}).code,'DEX_TERMINAL_MACHINE_SPACE_REQUIRED');
  assert.equal(fixture({busy:true}).run('dex_terminal_send',{text:'hi'}).code,'DEX_TERMINAL_ROOM_BUSY');
  assert.equal(fixture().run('dex_terminal_send',{roomId:'other',text:'hi'}).code,'DEX_TERMINAL_ROOM_REQUIRED');
});
test('a visible reply is not final proof until an authoritative final receipt exists',()=>{
  const f=fixture();const sent=f.run('dex_terminal_send',{text:'ping'});
  f.state().rooms[0].messages.push({id:'msg-response',senderKind:'agent',senderId:'member-tlo',text:'pong'});
  assert.equal(f.run('dex_terminal_check',{lookupId:ID}).status,'REPLY_OBSERVED_NOT_FINAL');
  f.state().rooms[0].finalReceipts=[{messageId:'msg-response',requestId:'tlo-turn-001'}];
  const ready=f.run('dex_terminal_check',{lookupId:ID});
  assert.equal(ready.status,'FINAL_RECEIPT_CONFIRMED');assert.equal(ready.response.text,'pong');assert.ok(sent.messageId);
});
test('wrong-source agent response does not count as TLO proof',()=>{
  const f=fixture();f.run('dex_terminal_send',{text:'ping'});
  f.state().rooms[0].messages.push({id:'wrong',senderKind:'agent',senderId:'impostor',text:'pong'});
  f.state().rooms[0].finalReceipts=[{messageId:'wrong',requestId:'wrong'}];
  assert.equal(f.run('dex_terminal_check',{lookupId:ID}).status,'AWAITING_REPLY_OR_RECOVERY');
});
test('failed relay after durable message requires manual reconciliation, not resending',()=>{
  let state=fixture(); // separately prove policy with injected scheduler failing after save
  assert.ok(state);
  const core=createTerminalOperator({load:()=>({rooms:[{id:ROOM,members:[{id:'tlo',relayEnabled:true,binding:{targetClassId:'local-origin',targetId:'local:tlo-chat:default',providerId:'tlo-chat'}}],machineSpaces:{spaces:[{id:'s',resourceIds:['t']}]},messages:[],relay:{active:false}}]}),save:x=>x,scheduler:{startRelay:()=>({ok:false,message:'race'})}});
  const result=core.handle({type:'dex_terminal_send',roomId:ROOM,requestId:ID,text:'ping'});
  assert.equal(result.messageCommitted,true);assert.equal(result.retryForbidden,true);
});
test('bounded hostile text, duplicate enabled members and unresolved control are rejected',()=>{
  const f=fixture();assert.equal(f.run('dex_terminal_send',{text:'X'.repeat(1801)}).code,'DEX_TERMINAL_BAD_TEXT');
  const g=fixture();g.state().rooms[0].members.push({id:'other',relayEnabled:true,binding:{}});
  assert.equal(g.run('dex_terminal_send',{text:'Hi'}).code,'DEX_TERMINAL_TLO_ONLY');
  const h=fixture();h.state().rooms[0].pendingProviderControlReceipt={};
  assert.equal(h.run('dex_terminal_send',{text:'Hi'}).code,'DEX_TERMINAL_ROOM_BUSY');
});

test('a later TLO answer cannot masquerade as the earlier request reply',()=>{
  const f=fixture();f.run('dex_terminal_send',{text:'first'});
  f.state().rooms[0].messages.push({id:'msg-second',senderKind:'user',senderId:'user',clientRequestId:'other-request-001',text:'second'});
  f.state().rooms[0].messages.push({id:'msg-later-reply',senderKind:'agent',senderId:'member-tlo',text:'answer to second'});
  f.state().rooms[0].finalReceipts=[{messageId:'msg-later-reply',requestId:'turn-for-second'}];
  assert.equal(f.run('dex_terminal_check',{lookupId:ID}).status,'AWAITING_REPLY_OR_RECOVERY');
});
