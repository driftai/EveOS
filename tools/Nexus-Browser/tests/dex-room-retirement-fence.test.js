'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mergeClientSnapshot } = require('../dex/server-state-merge');
const { deleteRoom } = require('../dex/server-room-lifecycle');
const { createDexStateStore } = require('../dex/state-store');
function r(id) { return { id, name:id, members:[], messages:[], relay:{active:false,waitingFor:null} }; }
const a='room-11111111-1111-1111-1111-111111111111';
const b='room-22222222-2222-2222-2222-222222222222';
const c='room-33333333-3333-3333-3333-333333333333';
test('deletion records server-owned tombstone and stale viewer cannot resurrect it', () => {
  const before={rooms:[r(a),r(b)],activeRoomId:a,retiredRoomIds:[]};
  const deleted=deleteRoom(before,{roomId:a,confirmName:a},{humanInputEnabled:true});
  assert.equal(deleted.ok,true);
  assert.deepEqual(deleted.snapshot.retiredRoomIds,[a]);
  const merged=mergeClientSnapshot(deleted.snapshot,{rooms:[r(a),r(b),r(c)],activeRoomId:a,retiredRoomIds:[]});
  assert.deepEqual(merged.rooms.map(r=>r.id),[b,c]);
  assert.deepEqual(merged.retiredRoomIds,[a]);
  const injection=mergeClientSnapshot(deleted.snapshot,{rooms:[r(b)],retiredRoomIds:[c]});
  assert.deepEqual(injection.retiredRoomIds,[a]);
});
test('retirement fence is durable across state-store recreation and never shrinks',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'eve-retired-'));
  try {
    const file=path.join(dir,'state.json');
    const store=createDexStateStore({filePath:file});
    const original={rooms:[r(a),r(b)],activeRoomId:a,retiredRoomIds:[]};
    store.save(original);
    const deleted=deleteRoom(store.load(),{roomId:a,confirmName:a},{humanInputEnabled:true});
    store.save(deleted.snapshot);
    assert.deepEqual(createDexStateStore({filePath:file}).load().retiredRoomIds,[a]);
    assert.throws(()=>store.save({...deleted.snapshot,retiredRoomIds:[]}),/REGRESSION/);
    assert.throws(()=>store.save({...deleted.snapshot,rooms:[r(a),r(b)]}),/RESURRECTION_DENIED/);
    assert.deepEqual(store.load().rooms.map(r=>r.id),[b]);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('retirement ledger cannot silently drop entries at capacity',()=>{
  const ids=Array.from({length:2048},(_,i)=>'room-'+String(i).padStart(36,'0'));
  const result=deleteRoom({rooms:[r(a),r(b)],retiredRoomIds:ids},{roomId:a,confirmName:a},{humanInputEnabled:true});
  assert.equal(result.code,'DEX_ROOM_RETIREMENT_LEDGER_FULL');
});
