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
 if(request==='../runtime-config')return {EVEOS_ROOT:'/tmp',urls:()=>({websocket:'ws://127.0.0.1:12'}),
  dataDir:()=>'/tmp',portFor:(key)=>key==='GEMINI_CONTROL_PORT'?9082:8765};
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
function runtimePayloads(){return new Map([
 ['http://127.0.0.1:9082/api/control-plane/health',{ok:true,service:'eveos-control-plane',running:true,instanceId:'control-instance-1000',sourceFingerprint:'a'.repeat(64)}],
 ['http://127.0.0.1:9082/api/eveos-server/status?port=8765',{ok:true,running:true,instanceId:'web-instance-1000',sourceFingerprint:'b'.repeat(64),pids:[20]}],
 ['http://127.0.0.1:9082/api/nexus-browser/status',{ok:true,running:true,owned:true,supervisorPid:9}],
 ['http://127.0.0.1:8765/api/status',{ok:true,service:'eveos-local-server',instanceId:'web-instance-1000',sourceFingerprint:'b'.repeat(64)}],
 ['http://127.0.0.1:8765/api/eve-state/modular/path',{ok:true,rootPath:path.resolve('/tmp/modular-root')}]
]);}
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
test('deployment uses the qualified local coordinator without a WebSocket dispatch',async()=>{
 const modularRoot=path.resolve('/tmp/modular-root');
 const inventory={readyForDeployment:true,head:'b'.repeat(40),sourceFingerprint:'c'.repeat(64),
  serverSessionId:'session-1000',serverPid:10,supervisorPid:9,dexRooms:14,
  roomIdentityDigest:'d'.repeat(64),control:{instanceId:'control-instance-1000',
   sourceFingerprint:'f'.repeat(64),pid:8},
  web:{instanceId:'web-instance-1000',sourceFingerprint:'e'.repeat(64),pids:[20],port:8765,modularRoot},
  durableTloDormancy:{proven:true,state:'uninitialized',digest:'9'.repeat(64)}};
 let received=null;Socket.exec=null;
 const coordinator={execute:async(intent)=>{received=intent;return {ok:true,record:{requestId:intent.requestId}};}};
 const args={authorize:client.approvalText('deployment',inventory),'expected-head':inventory.head,
  'expected-fingerprint':inventory.sourceFingerprint,'expected-session':inventory.serverSessionId,
  'expected-pid':'10','expected-rooms':'14','request-id':'deployment-request-1000'};
 const result=await client.executeStage('deployment',args,inventory,{deploymentCoordinator:coordinator});
 assert.equal(result.result.ok,true);assert.equal(received.serverSessionId,'session-1000');
 assert.equal(Socket.exec,null);
});
test('runtime inventory correlates branded control, web, and listener identities',async()=>{
 const payloads=runtimePayloads();
 const fetchImpl=async(url)=>({ok:payloads.has(String(url)),status:payloads.has(String(url))?200:404,
  json:async()=>payloads.get(String(url))||{ok:false}});
 const value=await client.localRuntimeInventory({fetchImpl,listeners:()=>[8],
  inspectProcess:(pid,platform,kind)=>({present:true,commandMatches:(pid===8&&kind==='control')||(pid===20&&kind==='web')})});
 assert.equal(value.control.pid,8);assert.equal(value.control.identityVerified,true);
 assert.equal(value.web.identityVerified,true);assert.equal(value.web.modularRoot,path.resolve('/tmp/modular-root'));
});
test('delayed valid Nexus lifecycle status uses its independent bounded budget',async()=>{
 const payloads=runtimePayloads(),calls=[];
 const fetchImpl=(url,options={})=>{const key=String(url);calls.push({url:key,method:options.method});
  if(!key.endsWith('/api/nexus-browser/status'))return Promise.resolve({ok:payloads.has(key),status:200,json:async()=>payloads.get(key)});
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>resolve({ok:true,status:200,json:async()=>payloads.get(key)}),25);
   options.signal.addEventListener('abort',()=>{clearTimeout(timer);const error=new Error('aborted');error.name='AbortError';reject(error);},{once:true});});};
 const value=await client.localRuntimeInventory({fetchImpl,nexusStatusTimeoutMs:100,listeners:()=>[8],
  inspectProcess:(pid,platform,kind)=>({present:true,commandMatches:(pid===8&&kind==='control')||(pid===20&&kind==='web')})});
 assert.equal(value.nexus.owned,true);assert.equal(calls.find((item)=>item.url.endsWith('/api/nexus-browser/status')).method,'GET');
});
test('excessively slow Nexus lifecycle status times out without a mutation request',async()=>{
 const payloads=runtimePayloads(),methods=[];
 const fetchImpl=(url,options={})=>{const key=String(url);methods.push(options.method);
  if(!key.endsWith('/api/nexus-browser/status'))return Promise.resolve({ok:true,status:200,json:async()=>payloads.get(key)});
  return new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>{const error=new Error('aborted');error.name='AbortError';reject(error);},{once:true});});};
 await assert.rejects(client.localRuntimeInventory({fetchImpl,nexusStatusTimeoutMs:15,listeners:()=>[8],
  inspectProcess:()=>({present:true,commandMatches:true})}),{name:'AbortError'});
 assert.deepEqual([...new Set(methods)],['GET']);
});
test('runtime ownership and process identity mismatches remain fail closed',()=>{
 const valid={control:{verified:true,identityVerified:true},web:{identityVerified:true},nexus:{owned:true,supervisorPid:9}};
 assert.equal(client.runtimeOwnersValid(valid,{supervisorPid:9}),true);
 assert.equal(client.runtimeOwnersValid({...valid,nexus:{owned:false,supervisorPid:9}},{supervisorPid:9}),false);
 assert.equal(client.runtimeOwnersValid({...valid,nexus:{owned:true,supervisorPid:10}},{supervisorPid:9}),false);
 assert.equal(client.runtimeOwnersValid({...valid,control:{verified:true,identityVerified:false}},{supervisorPid:9}),false);
 assert.equal(client.runtimeOwnersValid({...valid,web:{identityVerified:false}},{supervisorPid:9}),false);
});
test('room snapshot digest rejects duplicate identities',()=>{
 const fs=require('node:fs'),os=require('node:os');const folder=fs.mkdtempSync(path.join(os.tmpdir(),'room-digest-'));
 const file=path.join(folder,'dex-state.json');fs.writeFileSync(file,JSON.stringify({rooms:[{id:'room-alpha-1000'},{id:'room-beta-1000'}]}));
 const first=client.readRoomSnapshot(file);assert.equal(first.count,2);assert.match(first.digest,/^[a-f0-9]{64}$/);
 fs.writeFileSync(file,JSON.stringify({rooms:[{id:'room-alpha-1000'},{id:'room-alpha-1000'}]}));
 assert.throws(()=>client.readRoomSnapshot(file),{code:'TLO_DEPLOYMENT_ROOM_IDENTITY_INVALID'});
});
test('durable dormancy proves only absent or internally consistent state',()=>{
 const fs=require('node:fs'),os=require('node:os');const root=fs.mkdtempSync(path.join(os.tmpdir(),'tlo-dormancy-'));
 const empty=client.inspectDurableTloDormancy(root);assert.equal(empty.proven,true);
 assert.equal(empty.state,'uninitialized');assert.match(empty.digest,/^[a-f0-9]{64}$/);
 fs.writeFileSync(path.join(root,'tlo-backend-activation.json'),'{}');
 assert.deepEqual(client.inspectDurableTloDormancy(root),{proven:false,state:'unsafe',code:'TLO_DEPLOYMENT_DURABLE_ACTIVATION_PRESENT'});
 fs.rmSync(path.join(root,'tlo-backend-activation.json'));fs.mkdirSync(path.join(root,'tlo-ownership'),{recursive:true});
 fs.mkdirSync(path.join(root,'tlo-ownership','default.lock'));
 assert.equal(client.inspectDurableTloDormancy(root).code,'TLO_DEPLOYMENT_DURABLE_STATE_LOCKED');
});
test('durable dormancy accepts only a matched idle browser conversation',()=>{
 const fs=require('node:fs'),os=require('node:os');const root=fs.mkdtempSync(path.join(os.tmpdir(),'tlo-browser-idle-'));
 const {createDurableTloOwnershipStore}=require('../dex/tlo-ownership-durable-store');
 const {createTloOwnershipFence}=require('../dex/tlo-ownership-fence');
 const {createTloConversationStore,historyDigest}=require('../dex/tlo-conversation-store');
 const owners=createDurableTloOwnershipStore({dirPath:path.join(root,'tlo-ownership')});
 createTloOwnershipFence(owners).claimInitialBrowser({workspaceId:'browser-workspace-1000'});
 const conversations=createTloConversationStore({dirPath:path.join(root,'tlo-conversations')});
 conversations.initialize({generation:1,history:[],expectedDigest:historyDigest({scopeId:'default',generation:1,history:[]})});
 const idle=client.inspectDurableTloDormancy(root);assert.equal(idle.proven,true);assert.equal(idle.state,'browser-idle');
 fs.rmSync(path.join(root,'tlo-conversations','default.json'));
 assert.equal(client.inspectDurableTloDormancy(root).code,'TLO_DEPLOYMENT_DURABLE_STATE_NOT_DORMANT');
});
test('legacy null runtime state is safe only with unloaded source and durable proof',()=>{
 const proof={proven:true,digest:'8'.repeat(64)};
 assert.equal(client.deploymentDormant({deployment:null,uncertain:false,handoff:null},false,proof),true);
 assert.equal(client.deploymentDormant({deployment:null,uncertain:false,handoff:null},true,proof),false);
 assert.equal(client.deploymentDormant({deployment:{state:'disabled'},uncertain:false,handoff:null},true,proof),true);
 assert.equal(client.deploymentDormant({deployment:null,uncertain:false,handoff:null},false,{proven:false}),false);
});
test('Local Control restart request is branded by exact origin and service',async()=>{
 let seen=null;const fetchImpl=async(url,options)=>{seen={url:String(url),options};return {ok:true,status:200,
  json:async()=>({ok:true,serviceRestarted:true})};};
 const result=await client.restartViaLocalControl('web',8765,fetchImpl);
 assert.equal(result.serviceRestarted,true);assert.match(seen.url,/api\/services\/restart\?port=8765$/);
 assert.equal(seen.options.headers.Origin,'http://127.0.0.1:8765');
 assert.deepEqual(JSON.parse(seen.options.body),{service:'web'});
});
