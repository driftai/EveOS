'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTerminalOperator } = require('../dex/terminal-operator');
const { routeTerminalOperator } = require('../dex/server-terminal-operator-route');
const { mergeClientSnapshot } = require('../dex/server-state-merge');
const { argumentsFor, payload } = require('../scripts/dex-room-terminal');
function make() {
  const initial={version:1,rooms:[],activeRoomId:null};
  let state=initial, started=0, spawned=0, epoch=0;
  const targets=new Map();
  const broker={
    createSession({type,cwd}) {const t={id:'terminal-powershell-'+(++spawned),processEpoch:'session-'+(++epoch),type,cwd};targets.set(t.id,t);return t;},
    target(id){return targets.get(id) || null;},stopSession(id){return targets.delete(id);}
  };
  const op=createTerminalOperator({load:()=>structuredClone(state),save:next=>(state=structuredClone(next)),
    scheduler:{startRelay(){started++;return {ok:true};}},machineBroker:broker,repoRoot:process.cwd(),
    targetAvailable:id=>targets.has(id)});
  return {op,broker,state:()=>state,started:()=>started,spawned:()=>spawned};
}
test('CLI exposes exact bootstrap request and bounded room name without requiring room ID',()=>{
  const p=argumentsFor(['bootstrap','--name','Auto TLO Proof','--request-id','bootstrap-integration-0001']);
  const wire=payload(p);
  assert.equal(wire.type,'dex_terminal_bootstrap');assert.equal(wire.roomName,'Auto TLO Proof');
  assert.equal(wire.requestId,'bootstrap-integration-0001');assert.equal(wire.roomId,undefined);
});
test('real terminal operator can provision and inspect; it never dispatches TLO',()=>{
  const f=make();const req={type:'dex_terminal_bootstrap',requestId:'bootstrap-integration-0001',roomName:'Auto Proof'};
  const p=f.op.handle(req),repeat=f.op.handle(req);
  assert.equal(p.ok,true);assert.equal(p.ready,true);assert.equal(repeat.idempotent,true);
  const inspect=f.op.handle({type:'dex_terminal_inspect',requestId:'bootstrap-integration-0002',roomId:p.roomId});
  assert.equal(inspect.tloMemberId,p.tloMemberId);assert.equal(inspect.machineSpaceId,p.machineSpaceId);
  assert.equal(f.started(),0);assert.equal(f.spawned(),1);
});
test('terminal-operator routing denies browser-origin and every machine mutation verb',()=>{
  const f=make(),ws={remoteAddress:'127.0.0.1',terminalOperatorOrigin:null};
  const p=routeTerminalOperator(ws,{type:'dex_terminal_bootstrap',requestId:'bootstrap-integration-0003'},f.op);
  assert.equal(p.type,'dex_terminal_result');assert.equal(p.result.ok,true);
  const bad=routeTerminalOperator(ws,{type:'machine_start_supervised_job',requestId:'bootstrap-integration-0004'},f.op);
  assert.equal(bad.code,'DEX_TERMINAL_ACTION_DENIED');
  const browser=routeTerminalOperator({...ws,terminalOperatorOrigin:'http://localhost:5000'},
    {type:'dex_terminal_bootstrap',requestId:'bootstrap-integration-0005'},f.op);
  assert.equal(browser.code,'DEX_TERMINAL_LOCAL_ONLY');
  assert.equal(f.spawned(),1);
});
test('server-authored proof room survives old Dex client snapshots without inventing active grants',()=>{
  const f=make(),p=f.op.handle({type:'dex_terminal_bootstrap',requestId:'bootstrap-integration-0006',roomName:'Proof Room'});
  const server=f.state();const oldClient={version:1,rooms:[],activeRoomId:null};
  const merged=mergeClientSnapshot(server,oldClient);
  const room=merged.rooms.find(x=>x.id===p.roomId);
  assert.ok(room,'stale Dex client must not erase an active machine proof room');
  assert.equal(room.terminalBootstrap.requestId,'bootstrap-integration-0006');
  assert.equal(room.machineSpaces.spaces[0].grant,null);
  const newer={version:1,rooms:[{...room,name:'Renamed by viewer'}],activeRoomId:room.id};
  const mergedAgain=mergeClientSnapshot(server,newer);
  assert.equal(mergedAgain.rooms[0].terminalBootstrap.schema,room.terminalBootstrap.schema);
});
