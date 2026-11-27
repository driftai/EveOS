'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const fail=(code)=>{throw Object.assign(new Error(code),{code});};
function evidence(d){
 const s=d?.extensionSessions;
 if(!d?.ok||typeof d.serverSessionId!=='string'||!s||!Number.isInteger(s.connected)||!Array.isArray(s.standby)||!Array.isArray(s.recentTransitions))fail('NEXUS_DIAGNOSTICS_INCOMPLETE');
 return {server:d.serverSessionId,connected:d.extensionConnected===true,ready:s.primaryReady===true,pendingEmpty:s.pendingEmpty===true,count:s.connected,primary:s.primarySessionId,epoch:s.primaryConnectionEpoch,tabs:s.primaryTabs,standby:s.standby.map(x=>({id:x.sessionId,epoch:x.connectionEpoch,tabs:x.tabs,ready:x.ready===true})),transitions:s.recentTransitions.map(x=>({type:x.type,sessionId:x.sessionId,connectionEpoch:x.connectionEpoch,reason:x.reason,at:x.at}))};
}
function idle(d){
 const o=d?.orchestration,c=d?.controlPlane,p=d?.postIdle;
 if(!o||!c||!p||!Array.isArray(o.pendingRooms)||!Array.isArray(o.recoveryRooms)||!Array.isArray(o.queuedIncoming))fail('IDLE_STATE_UNVERIFIED');
 if(o.current||o.pendingRooms.length||o.recoveryRooms.length||o.queuedIncoming.length||p.active||p.inFlight||c.providerControlPending||c.controlReceiptsPending||c.targetOperationsPending||c.agentExtensionReload?.active)fail('NEXUS_WORK_ACTIVE');
}
function eligible(d){
 idle(d);const e=evidence(d);
 if(!e.connected||!e.ready||e.pendingEmpty||!e.primary||!Number.isInteger(e.epoch)||e.count!==1+e.standby.length||e.count<1)fail('PRIMARY_NOT_READY');
 if(e.standby.some(x=>!x.ready||x.tabs!==0||!x.id||!Number.isInteger(x.epoch)))fail('AMBIGUOUS_STANDBY_AUTHORITY');
 if(e.count>1&&!(e.tabs>0))fail('NO_UNIQUE_POPULATED_PRIMARY');
 if(new Set([e.primary,...e.standby.map(x=>x.id)]).size!==e.count)fail('SESSION_IDENTITY_AMBIGUOUS');
 return e;
}
const standbyKey=e=>e.standby.map(x=>`${x.id}:${x.epoch}:${x.tabs}:${x.ready}`).sort().join('|');
function sameTarget(a,b){return a.server===b.server&&a.primary===b.primary&&a.epoch===b.epoch&&a.tabs===b.tabs&&a.count===b.count&&standbyKey(a)===standbyKey(b);}
function returned(before,after,acked,dispatchAt){
 if(before.server!==after.server)fail('NEXUS_SERVER_CHANGED');
 if(!acked||!after.connected||!after.ready||after.pendingEmpty||after.count!==before.count||standbyKey(after)!==standbyKey(before))return false;
 const ceiling=Math.max(before.epoch,...before.standby.map(x=>x.epoch));
 if(after.primary===before.primary||!Number.isInteger(after.epoch)||after.epoch<=ceiling||after.tabs!==before.tabs)return false;
 const dropped=after.transitions.some(x=>x.type==='disconnected'&&x.sessionId===before.primary&&x.connectionEpoch===before.epoch&&x.at>=dispatchAt);
 const fresh=after.transitions.some(x=>x.type==='connected'&&x.sessionId===after.primary&&x.connectionEpoch===after.epoch&&x.at>=dispatchAt);
 return dropped&&fresh;
}
async function requestReload({WebSocket,url,diagnostics,health,receipt,expectedBefore=null,timeoutMs=30000}){
 const first=eligible(await diagnostics());if(expectedBefore&&!sameTarget(expectedBefore,first))fail('PRIMARY_CHANGED_BEFORE_RELOAD');receipt.before=first;
 const requestId='activation-'+crypto.randomUUID();receipt.requestId=requestId;
 const ws=new WebSocket(url,{handshakeTimeout:5000});let ack=false, sent=false, refusal=null, error=null, hello=null, ready=false;
 const start=Date.now();let dispatchAt=0;
 ws.on('error',()=>{error='CONTROL_SOCKET_ERROR';});
 ws.on('close',()=>{error=error||'CONTROL_SOCKET_CLOSED';});
 ws.on('open',()=>{ws.send(JSON.stringify({type:'hello',role:'ui',clientKind:'provider-control'}));});
 ws.on('message',raw=>{let m;try{m=JSON.parse(String(raw));}catch{return;}
  if(m.type==='server_session')hello=m.id;
  if(m.type==='bridge_status'&&m.connected===true&&m.authorityReady===true)ready=true;
  if(sent&&m.type==='reloading_extension'&&m.requestId===requestId){ack=true;receipt.ack=true;}
  if(sent&&m.type==='error'&&(m.requestId===requestId||(!m.requestId&&m.code==='POST_IDLE_LEASE_BUSY')))refusal=String(m.code||'RELOAD_REFUSED').replace(/[^A-Z0-9_-]/g,'').slice(0,100)||'RELOAD_REFUSED';
 });
 try{
  while(!(hello&&ready)){if(error)fail(error);if(Date.now()-start>6000)fail('CONTROL_HANDSHAKE_TIMEOUT');await sleep(100);}
  if(hello!==first.server)fail('NEXUS_SERVER_CHANGED');
  await health();const next=eligible(await diagnostics());if(!sameTarget(first,next))fail('PRIMARY_CHANGED_BEFORE_DISPATCH');
  dispatchAt=Date.now();sent=true;receipt.dispatched=true;receipt.dispatchedAt=new Date(dispatchAt).toISOString();
  ws.send(JSON.stringify({type:'reload_extension',requestId}));
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
   if(refusal)fail(refusal);
   let d;try{d=await diagnostics();}catch(e){if(e.code)throw e;await sleep(300);continue;}
   const after=evidence(d);receipt.after=after;
   if(returned(first,after,ack,dispatchAt)){await health();return;}
   if(error&&!ack)fail(error);await sleep(300);
  }
  fail(ack?'RECONNECT_UNVERIFIED':'RELOAD_ACK_UNVERIFIED');
 }finally{try{ws.close();}catch{}receipt.ack=ack;}
}
// Reuse the official local primary route. The fresh witness is read-only and carries
// no media URLs, browser tabs, credentials, or authorization grants.
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function expectedWitness(root,plan){
 const manifest=plan.manifest;if(manifest.name!=='EveOS Bridge'||!manifest.key)fail('OFFICIAL_MANIFEST_UNVERIFIED');
 const id=crypto.createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
 const prefix='modules/watchfusion/';
 const files=[...plan.files].filter(([name])=>name.startsWith(prefix)).map(([name,b])=>[name,sha(b)]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
 if(!files.length)fail('WATCHFUSION_ASSEMBLY_MISSING');
 const hashes={};for(const file of ['worker.js','source-probe.js','live-peer.js']){const b=plan.files.get(prefix+file);if(!b)fail('WATCHFUSION_ASSET_MISSING');hashes[file]=sha(b);}
 const build=sha(JSON.stringify(files));
 return {extensionId:id,version:manifest.version,build,hashes};
}
function verifyWitness(value,expected,nonce){
 if(!value||value.schema!==1||value.nonce!==nonce||value.loaded!==true||typeof value.linked!=='boolean'||!/^[-a-f0-9]{36}$/.test(value.instance||''))fail('MODULE_WITNESS_INVALID');
 if(value.extensionId!==expected.extensionId||value.version!==expected.version)fail('OFFICIAL_BRIDGE_IDENTITY_MISMATCH');
 if(value.build!==expected.build)fail('WATCHFUSION_RUNTIME_BUILD_MISMATCH');
 for(const file of Object.keys(expected.hashes))if(value.hashes?.[file]!==expected.hashes[file])fail('WATCHFUSION_RUNTIME_ASSET_MISMATCH:'+file);
 return {schema:1,extensionId:value.extensionId,version:value.version,build:value.build,instance:value.instance,hashes:{...expected.hashes},linked:value.linked,nonce};
}
async function attest({WebSocket,url,diagnostics,expected,expectedBefore=null,timeoutMs=12000}){
 const first=eligible(await diagnostics());if(expectedBefore&&!sameTarget(expectedBefore,first))fail('WITNESS_PRIMARY_CHANGED');
 const nonce=crypto.randomBytes(16).toString('hex'),requestId='activation-witness-'+nonce;
 let hello=null,ready=false,sent=false,received=false,response=null,error=null;
 const ws=new WebSocket(url,{handshakeTimeout:5000});
 ws.on('open',()=>ws.send(JSON.stringify({type:'hello',role:'ui',clientKind:'provider-control'})));
 ws.on('error',()=>{error='WITNESS_SOCKET_ERROR';});ws.on('close',()=>{error=error||'WITNESS_SOCKET_CLOSED';});
 ws.on('message',raw=>{let m;try{m=JSON.parse(String(raw));}catch{return;}
   if(m.type==='server_session')hello=m.id;
   if(m.type==='bridge_status'&&m.connected===true&&m.authorityReady===true)ready=true;
   if(sent&&m.requestId===requestId&&m.type==='bridge_activation_witness'){received=true;response=m.witness;}
   if(sent&&m.requestId===requestId&&m.type==='error')error='WITNESS_REQUEST_REFUSED';
 });
 try{
   const deadline=Date.now()+timeoutMs;
   while(!(hello&&ready)){if(error)fail(error);if(Date.now()>=deadline)fail('WITNESS_CONTROL_TIMEOUT');await sleep(50);}
   if(hello!==first.server||!sameTarget(first,eligible(await diagnostics())))fail('WITNESS_PRIMARY_CHANGED');
   sent=true;ws.send(JSON.stringify({type:'request_tabs',requestId,activationNonce:nonce}));
   while(!received){if(error)fail(error);if(Date.now()>=deadline)fail('MODULE_WITNESS_TIMEOUT');await sleep(50);}
   if(!sameTarget(first,eligible(await diagnostics())))fail('WITNESS_PRIMARY_CHANGED');
   return verifyWitness(response,expected,nonce);
 }finally{try{ws.close();}catch{}}
}
async function verifyInstalled(root){
 const ports=JSON.parse(fs.readFileSync(path.join(root,'config/eveos-ports.json'),'utf8')).ports;
 const port=ports.NEXUS_BROWSER_PORT.port;if(!Number.isInteger(port)||port<1||port>65535)fail('INVALID_PORT_REGISTRY');
 const nx=`http://127.0.0.1:${port}`,url=`ws://127.0.0.1:${port}/ws`;
 const diagnostics=async()=>{const r=await fetch(nx+'/diagnostics',{redirect:'error',signal:AbortSignal.timeout(5000)});if(!r.ok)fail('NEXUS_DIAGNOSTICS_UNAVAILABLE');return r.json();};
 const assembly=require(path.join(root,'tools/extensions/assemble.cjs'));
 const plan=assembly.audit({assets:true});
 return attest({WebSocket:createRequire(path.join(root,'tools/Nexus-Browser/package.json'))('ws').WebSocket,url,diagnostics,expected:expectedWitness(root,plan)});
}
module.exports={evidence,idle,eligible,sameTarget,returned,requestReload,expectedWitness,verifyWitness,attest,verifyInstalled};
if(require.main===module){verifyInstalled(path.resolve(process.argv[2]||path.join(__dirname,'../..'))).then(result=>{console.log(JSON.stringify({ok:true,result:'OFFICIAL_BRIDGE_MODULE_VERIFIED',witness:result},null,2));},error=>{console.error(JSON.stringify({ok:false,code:error.code||error.message}));process.exitCode=2;});}
