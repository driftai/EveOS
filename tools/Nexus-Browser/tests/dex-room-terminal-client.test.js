'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const cli=require('../scripts/dex-room-terminal');
const ROOM='room-test000001';
test('terminal client requires exact room IDs and a bounded local endpoint',()=>{
  assert.throws(()=>cli.argumentsFor(['send','--room','Room One','--text','hello']),/exact|room/i);
  assert.throws(()=>cli.argumentsFor(['send','--room',ROOM,'--text','hello','--file','other']),/either/);
  assert.throws(()=>cli.endpoint({NEXUS_BROWSER_WS:'wss://remote.example/ws'}),/local/);
  assert.throws(()=>cli.endpoint({NEXUS_BROWSER_WS:'ws://remote.example/ws'}),/local/);
  assert.equal(cli.endpoint({NEXUS_BROWSER_WS:'ws://127.0.0.1:1234/ws'}),'ws://127.0.0.1:1234/ws');
  assert.equal(cli.argumentsFor(['viewer-standby','--duration','30']).duration,'30');
  assert.throws(()=>cli.argumentsFor(['viewer-standby','--duration','3']),/15\.\.600/);
  assert.deepEqual(cli.payload({command:'viewer-standby',duration:'45',requestId:'terminal-lease-001'}),{
    requestId:'terminal-lease-001',roomId:undefined,type:'dex_terminal_viewer_standby',durationSeconds:45
  });
});
test('client hello uses terminal-operator rather than spoofing TLO provider-control',async()=>{
  let frames=[];
  class MockWebSocket extends EventEmitter {
    constructor(){super();this.readyState=1;queueMicrotask(()=>this.emit('open'));}
    send(raw){const x=JSON.parse(raw);frames.push(x);if(x.type==='dex_terminal_inspect') queueMicrotask(()=>this.emit('message',JSON.stringify({type:'dex_terminal_result',requestId:x.requestId,result:{ok:true,roomId:ROOM}})));}
    close(){this.emit('close');}
  }
  const r=await cli.transact({type:'dex_terminal_inspect',roomId:ROOM,requestId:'terminal-proof-01'}, {WebSocketImpl:MockWebSocket,url:'ws://127.0.0.1:1234/ws'});
  assert.equal(r.ok,true);assert.equal(frames[0].clientKind,'terminal-operator');
  assert.equal(frames[0].role,'ui');assert.equal(frames[1].type,'dex_terminal_inspect');
  assert.ok(frames.every(f=>f.type!=='provider_control_request'));
});
test('wait proof rejects missing receipt and never issues a second send',async()=>{
  let types=[];
  const r=await cli.waitFor({room:ROOM,lookupId:'terminal-proof-01',timeout:'2'}, async x=>{types.push(x.type);return {ok:true,status:'AWAITING_REPLY_OR_RECOVERY'};});
  assert.equal(r.code,'DEX_TERMINAL_NOT_PROVEN');assert.ok(types.every(x=>x==='dex_terminal_check'));
});
test('wait --request-id preserves the original send identity while polling with fresh request IDs',async()=>{
  const calls=[];
  const r=await cli.waitFor({room:ROOM,requestId:'terminal-proof-original',timeout:'2'},async x=>{
    calls.push(x);return {ok:true,status:'FINAL_RECEIPT_CONFIRMED'};
  });
  assert.equal(r.status,'FINAL_RECEIPT_CONFIRMED');assert.equal(calls.length,1);
  assert.equal(calls[0].lookupId,'terminal-proof-original');
  assert.notEqual(calls[0].requestId,'terminal-proof-original');
});
test('viewer standby returns only after diagnostics prove the exact lease is headless',async()=>{
  const result=await cli.confirmViewerStandby({ok:true,leaseId:'lease-one'},{
    fetchImpl:async()=>({ok:true,json:async()=>({dexUiConnected:false,viewerLease:{leaseId:'lease-one'},serverSessionId:'session-one'})}),
    pause:async()=>{}
  });
  assert.equal(result.headlessConfirmed,true);assert.equal(result.serverSessionId,'session-one');
  const blocked=await cli.confirmViewerStandby({ok:true,leaseId:'lease-two'},{
    timeoutMs:1,fetchImpl:async()=>({ok:true,json:async()=>({dexUiConnected:true,viewerLease:{leaseId:'lease-two'}})}),pause:async()=>{}
  });
  assert.equal(blocked.code,'DEX_VIEWER_LEASE_NOT_CONFIRMED');
});
