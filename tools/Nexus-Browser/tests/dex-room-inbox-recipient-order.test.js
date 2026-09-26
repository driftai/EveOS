'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const inbox = require('../dex/recovery-mailbox');
const eve = {targetClassId:'online-origin',providerId:'chatgpt',targetId:42,url:'https://chatgpt.com/c/eve'};
const astro = {targetClassId:'local-origin',providerId:'local-antigravity-existing',targetId:'local:antigravity-existing:9'};
function room(id='room-1') {
 return {id,name:id,members:[{id:'eve',name:'Eve',relayEnabled:true,binding:eve},
 {id:'astro',name:'Astro',relayEnabled:true,binding:astro}],
 messages:[],settings:{maxTurns:8},relay:{active:false,remaining:0,waitingFor:null}};
}
function put(state,id,text,source=astro,roomId='room-1'){
 return inbox.queueRoomSend(state,{source,requestId:id,at:'2026-09-26T18:00:00Z',
 command:{action:'send',room:roomId,text,relay:true},makeId:()=>id});
}
test('interleaved sender requests retain FIFO and never enter the wrong agent prompt',()=>{
 const state={rooms:[room()]},r=state.rooms[0];
 put(state,'a1','Astro report for Eve');put(state,'e1','Eve request for Astro',eve);
 put(state,'a2','Another Astro report');
 for(const [wanted,receiver,remaining] of [['a1','eve',2],['e1','astro',1],['a2','eve',0]]){
  assert.equal(inbox.activateNext(state),true);
  assert.equal(r.pendingTurn.sourceMessageId,wanted);
  assert.equal(r.pendingTurn.memberId,receiver);
  assert.equal(r.deferredRelays.length,remaining);
  delete r.pendingTurn;r.relay.active=false;r.relay.waitingFor=null;
 }
});
test('pending recipient cannot steal an older queued report addressed to another member',()=>{
 const state={rooms:[room()]},r=state.rooms[0];
 put(state,'e1','To Astro',eve);put(state,'a1','To Eve');
 r.pendingTurn={memberId:'eve',sourceMessageId:'e1'};
 assert.equal(inbox.stageForPending(r),0);
 assert.equal(r.deferredRelays.length,2);
 r.pendingTurn.memberId='astro';
 assert.equal(inbox.stageForPending(r),1);
 assert.deepEqual(r.pendingTurn.inboxMessageIds,['e1']);
 assert.equal(r.deferredRelays[0].messageId,'a1');
});
test('disabled admission-time recipient holds exact message until available',()=>{
 const state={rooms:[room()]},r=state.rooms[0];
 put(state,'a1','For Eve');
 assert.equal(r.deferredRelays[0].targetMemberId,'eve');
 r.members[0].relayEnabled=false;
 assert.equal(inbox.activateNext(state),false);
 assert.equal(r.deferredRelays.length,1);
 r.members[0].relayEnabled=true;
 assert.equal(inbox.activateNext(state),true);
 assert.equal(r.pendingTurn.memberId,'eve');
});
test('one blocked room cannot starve an independent eligible room',()=>{
 const state={rooms:[room('room-1'),room('room-2')]};
 put(state,'blocked','For Eve',astro,'room-1');
 state.rooms[0].members[0].relayEnabled=false;
 put(state,'runnable','Independent work',astro,'room-2');
 assert.equal(inbox.activateNext(state),true);
 assert.equal(state.rooms[1].pendingTurn.sourceMessageId,'runnable');
 assert.equal(state.rooms[0].deferredRelays.length,1);
});
