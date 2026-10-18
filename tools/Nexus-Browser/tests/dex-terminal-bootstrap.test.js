'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootstrap, PROOF_KIND } = require('../dex/terminal-provision');
function harness() {
  let snapshot = { version: 1, rooms: [{ id: 'room-existing', name: 'Unrelated', members: [], messages: [] }], activeRoomId: 'room-existing' };
  let spawned = 0, stopped = 0, failSave = false, targets = new Map();
  const broker = {
    createSession({type,cwd,label}) { assert.equal(type, 'powershell'); assert.equal(label, 'TLO Proof (no grants)');
      const target = { id: `terminal-powershell-${++spawned}`, processEpoch: `session-${spawned}`, type, cwd }; targets.set(target.id,target); return target; },
    target(id){return targets.get(id) || null;},
    stopSession(id){stopped++;return targets.delete(id);}
  };
  let n=0;const opts={requestId:'bootstrap-proof-0001',roomName:'TLO Proof',repoRoot:process.cwd(),broker,
    load:()=>structuredClone(snapshot),save:s=>{if(failSave)throw Error('disk failure');snapshot=structuredClone(s);return snapshot;},
    idFactory:()=>`fixed-${++n}`,now:()=> '2026-10-18T08:00:00.000Z'};
  return{opts,broker, state:()=>snapshot, spawned:()=>spawned, stopped:()=>stopped, failSave:()=>{failSave=true}, targets};
}
test('one script request provisions exactly one disabled-grant TLO room and attached shell target',()=>{
  const f=harness(), out=bootstrap(f.opts);
  assert.equal(out.ok,true);assert.equal(out.ready,true);assert.equal(out.modelInvocations,0);assert.equal(out.grantsEnabled,false);
  assert.equal(out.executionAuthority,'not-granted');assert.equal(f.state().rooms.length,2);
  const room=f.state().rooms[1];assert.equal(room.terminalBootstrap.schema,PROOF_KIND);
  assert.equal(room.members.length,1);assert.equal(room.members[0].binding.targetId,'local:tlo-chat:default');
  assert.equal(room.machineSpaces.spaces.length,1);assert.deepEqual(room.machineSpaces.spaces[0].resourceIds,[out.targetId]);
  assert.equal(room.machineSpaces.spaces[0].grant,null);assert.deepEqual(room.machineSpaces.spaces[0].fileGrants,[]);
  assert.equal(f.state().rooms[0].name,'Unrelated');
});
test('same immutable request deduplicates without spawning another target',()=>{
  const f=harness();const a=bootstrap(f.opts),b=bootstrap(f.opts);assert.equal(b.ok,true);
  assert.equal(b.idempotent,true);assert.equal(a.roomId,b.roomId);assert.equal(f.spawned(),1);
});
test('reusing a request ID with a different name is rejected',()=>{
  const f=harness();bootstrap(f.opts);const out=bootstrap({...f.opts,roomName:'Another Proof'});
  assert.equal(out.code,'DEX_BOOTSTRAP_REQUEST_CONFLICT');assert.equal(f.spawned(),1);
});
test('a lost terminal never triggers a replacement under the same request',()=>{
  const f=harness();const a=bootstrap(f.opts);f.broker.stopSession(a.targetId);const b=bootstrap(f.opts);
  assert.equal(b.ok,true);assert.equal(b.ready,false);assert.equal(f.spawned(),1);
});
test('invalid names and room limit fail closed without creating a target',()=>{
  const f=harness();for(const name of ['','../../../x','X; invoke','💣','N'.repeat(49)])
    assert.equal(bootstrap({...f.opts,roomName:name}).code,'DEX_BOOTSTRAP_BAD_NAME');
  assert.equal(f.spawned(),0);
});
test('save failure revokes newly created terminal and never returns success',()=>{
  const f=harness();f.failSave();const out=bootstrap(f.opts);
  assert.equal(out.code,'DEX_BOOTSTRAP_ABORTED');assert.equal(f.stopped(),1);assert.equal(f.state().rooms.length,1);
});
test('missing canonical repo or broker fails without spawning',()=>{
  const f=harness();assert.equal(bootstrap({...f.opts,repoRoot:null}).code,'DEX_BOOTSTRAP_REPO_REQUIRED');
  assert.equal(bootstrap({...f.opts,broker:null}).code,'DEX_BOOTSTRAP_UNAVAILABLE');
  assert.equal(bootstrap({...f.opts,repoRoot:'/missing/certainly/not/repo'}).code,'DEX_BOOTSTRAP_REPO_REQUIRED');
  assert.equal(f.spawned(),0);
});
test('room creation works before any Dex browser has initialized the store',()=>{
  const f=harness();f.opts.load=()=>null;
  const out=bootstrap(f.opts);assert.equal(out.ok,true);assert.equal(f.state().rooms.length,1);
});
