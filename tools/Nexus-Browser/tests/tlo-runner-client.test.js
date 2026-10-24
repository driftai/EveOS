'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const path = require('node:path');
const Module = require('node:module');
const CLIENT=path.resolve(__dirname,'../scripts/tlo-activation-runner.js');
const gate=path.resolve(__dirname,'../dex/tlo-activation-runner-gate.js');
class Socket extends EventEmitter{
  constructor() {super(); Socket.last=this; queueMicrotask(()=>this.emit('open'));}
  send(value){const data=JSON.parse(value);if(data.type==='hello') { queueMicrotask(()=>this.emit('message',JSON.stringify({type:'tlo_activation_hello',serverPid:10,serverSessionId:'session-1000',sourceFingerprint:'c'.repeat(64)})));return;}
    if(data.type==='tlo_activation_execute') {Socket.exec=data;Socket.onDispatch?.(this,data);}
  }
  close(){this.emit('close');}
}
const old=Module._load;
Module._load=function(request,parent,isMain){
 if(parent?.filename?.endsWith('tlo-activation-runner.js')){
 if(request==='ws')return {WebSocket:Socket};
 if(request==='../runtime-config')return {EVEOS_ROOT:'/tmp',urls:()=>({websocket:'ws://127.0.0.1:12'}),dataDir:()=>'/tmp'};
 if(request==='../dex/post-idle-maintenance')return {gitState:()=>({head:'0'.repeat(40)})};
 if(request==='../dex/task-completion-local-auth')return {readLocalAuth:()=> 'a'.repeat(64)};
 if(request==='../dex/tlo-production-activation')return {sourceIdentity:()=>({fingerprint:'c'.repeat(64)})};
 }
 if(parent?.filename?.endsWith('tlo-activation-runner-gate.js')){
 if(request==='../runtime-config')return {dataDir:()=>'/tmp'};
 if(request==='./post-idle-maintenance')return {writeJournal:()=>{}};
 }
 return old.call(this,request,parent,isMain);
};
const client=require(CLIENT);Module._load=old;
const command={requestId:'request-1000',serverSessionId:'session-1000',serverPid:10,sourceFingerprint:'c'.repeat(64)};
test('client handles signed-command server failure without throwing event handler',async()=>{
 Socket.onDispatch=(ws)=>queueMicrotask(()=>ws.emit('message',JSON.stringify({type:'tlo_activation_result',requestId:command.requestId,ok:false,code:'DENIED',message:'Nope'})));
 await assert.rejects(client.connectAndExecute(command,'ws://dummy',1000),{code:'DENIED'});
});
test('client treats close after dispatch as uncertain',async()=>{
 Socket.onDispatch=(ws)=>queueMicrotask(()=>ws.close());
 await assert.rejects(client.connectAndExecute(command,'ws://dummy',1000),{code:'TLO_ACTIVATION_OUTCOME_UNCERTAIN'});
});
test('client treats mismatched session as changed without crashing',async()=>{
 const c={...command,serverPid:11};
 await assert.rejects(client.connectAndExecute(c,'ws://dummy',1000),{code:'TLO_ACTIVATION_RUNTIME_CHANGED'});
});
test('client handles timeout with explicit error code',async()=>{
 Socket.onDispatch=()=>{};
 await assert.rejects(client.connectAndExecute(command,'ws://dummy',25),{code:'TLO_ACTIVATION_TIMEOUT'});
});
