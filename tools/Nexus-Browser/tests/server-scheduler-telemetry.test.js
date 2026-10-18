'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const telemetry = require('../dex/server-scheduler-telemetry');

test('terminal live snapshot belongs only to the matching room', () => {
  const current = { roomId: 'room-one', sourceMessageId: 'msg-a',
    requestId: 'turn-a', partialText: 'streamed', phase: 'waiting' };
  assert.deepEqual(telemetry.terminalLiveState(current, 'room-one'), {
    roomId: 'room-one', sourceMessageId: 'msg-a',
    requestId: 'turn-a', partialText: 'streamed'
  });
  assert.equal(telemetry.terminalLiveState(current, 'room-two'), null);
  assert.equal(telemetry.terminalLiveState(null, 'room-one'), null);
});
test('scheduler diagnostics projection preserves recovery and queue status', () => {
  const room = { id:'room-one', recovery:{dispatched:true}, deferredRelays:[{},{}] };
  const snapshot = { rooms:[room, {id:'room-two', deferredRelays:[]}] };
  const current = {roomId:'room-one',memberId:'member-one',requestId:'turn-one',
    phase:'waiting',retryCount:2,targetId:'target-one'};
  const out = telemetry.diagnostics({
    current, load:()=>snapshot,
    stateApi:{roomById:(state,id)=>state.rooms.find(r=>r.id===id),
      pendingRooms:()=>[{id:'room-two'}]},
    lease:{diagnostics:()=>({generationState:'active'})},
    recovery:{diagnostics:()=>({state:'idle'})}
  });
  assert.deepEqual(out, {
    owner:'localhost',
    current:{roomId:'room-one',memberId:'member-one',requestId:'turn-one',
      phase:'waiting',retryCount:2,targetId:'target-one',
      generationState:'active',dispatched:true,recoveryPending:true},
    queuedIncoming:[{roomId:'room-one',queued:2}],
    pendingRooms:['room-two'],recoveryRooms:['room-one'],recovery:{state:'idle'}
  });
});
test('empty scheduler diagnostics preserve null current and zero lists', () => {
  const out=telemetry.diagnostics({
    current:null,load:()=>({rooms:[]}),
    stateApi:{pendingRooms:()=>[]},lease:{diagnostics:()=>null},
    recovery:{diagnostics:()=>({})}
  });
  assert.equal(out.current,null);
  assert.deepEqual(out.queuedIncoming,[]);
  assert.deepEqual(out.recoveryRooms,[]);
});
