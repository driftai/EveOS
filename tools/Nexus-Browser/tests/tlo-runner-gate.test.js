'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ROOT = path.resolve(__dirname,'..');
const oldLoad = Module._load;
// Isolate the actual proposed runner source from unrelated application startup.
Module._load = function (request, parent, isMain) {
  if (parent?.filename?.endsWith('tlo-activation-runner-gate.js')) {
    if (request === '../runtime-config') return {dataDir:()=> os.tmpdir()};
    if (request === './post-idle-maintenance') return {
      writeJournal(file,data) {
        fs.mkdirSync(path.dirname(file),{recursive:true});
        const tmp=file+'.new';fs.writeFileSync(tmp,JSON.stringify(data));fs.renameSync(tmp,file);
      }
    };
  }
  return oldLoad.call(this,request,parent,isMain);
};
const subject=require(path.join(ROOT,'dex/tlo-activation-runner-gate.js'));
Module._load=oldLoad;
const secret='a'.repeat(64), head='b'.repeat(40), fingerprint='c'.repeat(64);
const base={serverSessionId:'41312-abcdefghijkl',serverPid:41312,gitHead:head,gitClean:true,
 sourceFingerprint:fingerprint,dexRooms:14,pending:{providerControls:0,activeTurn:0},
 privateStorage:{secure:true},tlo:{deployment:{state:'disabled'},uncertain:false,handoff:null}};
function fixture(operation=()=>({done:true})){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'tlo-runner-'));
 const journalPath=path.join(temp,'journal.json');
 let now=100000;let inv=structuredClone(base),hits=0;
 const gate=subject.createTloActivationRunnerGate({journalPath,readSecret:()=>secret,readInventory:()=>inv,now:()=>now,
   operations:{deployment:async (...args)=>{hits++;return operation(...args);},
               'first-inference':async (...args)=>{hits++;return operation(...args);}}});
 function signed(stage,requestId='request-test-1000') {
   return subject.signCommand(secret,{stage,requestId,expectedHead:head,sourceFingerprint:fingerprint,
    serverSessionId:base.serverSessionId,serverPid:base.serverPid,expectedRooms:14},now);
 }
 return {temp,journalPath,gate,signed,setNow(x){now=x},inv,get hits(){return hits}};
}
test('read-only status creates no journal, no secret read',async()=>{
 const f=fixture();const r=await f.gate.handle({type:'tlo_activation_status'});
 assert.equal(r.ok,true);assert.equal(fs.existsSync(f.journalPath),false);
});
test('requires real auth secret even when signature computed from empty key',()=>{
 const f=fixture();const c=f.signed('deployment');
 assert.throws(()=>subject.verifyCommand('',c,100000), {code:'TLO_ACTIVATION_AUTH_UNAVAILABLE'});
});
test('successful stage persists one-shot durable record',async()=>{
 const f=fixture();const c=f.signed('deployment');
 const result=await f.gate.execute(c);assert.equal(result.ok,true);assert.equal(f.hits,1);
 const r=await f.gate.execute(c);assert.equal(r.deduplicated,true);assert.equal(f.hits,1);
 assert.equal(subject.readJournal(f.journalPath).records[0].state,'succeeded');
});
test('fails closed when head/source/pid/room/clean state changes',async()=>{
 for (const [key,value] of [['gitHead','z'.repeat(40)],['sourceFingerprint','e'.repeat(64)],
  ['serverPid',199],['dexRooms',13],['gitClean',false]]) {
   const f=fixture();f.inv[key]=value;
   await assert.rejects(f.gate.execute(f.signed('deployment')), {code:'TLO_ACTIVATION_PREFLIGHT_CHANGED'});
   assert.equal(f.hits,0);
 }
});
test('rejects changed pending counts and bad storage without creating journal',async()=>{
 for(const mutation of [f=>f.inv.pending.activeTurn=1,f=>f.inv.pending.activeTurn='nope',
   f=>f.inv.privateStorage.secure=false]) {
   const f=fixture();mutation(f);
   await assert.rejects(f.gate.execute(f.signed('deployment')), {code:'TLO_ACTIVATION_PREFLIGHT_CHANGED'});
   assert.equal(fs.existsSync(f.journalPath),false);
 }
});
test('rejects expired and altered signatures',async()=>{
 const f=fixture(); const c=f.signed('deployment');f.setNow(250001);
 await assert.rejects(f.gate.execute(c),{code:'TLO_ACTIVATION_AUTH_INVALID'});
 const h=fixture();await assert.rejects(h.gate.execute({...h.signed('deployment'),serverPid:9}),{code:'TLO_ACTIVATION_AUTH_INVALID'});
});
test('an uncertain stage remains unreplayable after reinitialization',async()=>{
 const f=fixture(()=>{throw Object.assign(new Error('error'),{code:'TEST_FAILED'});});const c=f.signed('deployment');
 await assert.rejects(f.gate.execute(c),{code:'TLO_ACTIVATION_OUTCOME_UNCERTAIN'});
 const again=subject.createTloActivationRunnerGate({journalPath:f.journalPath,readSecret:()=>secret,
 readInventory:()=>f.inv,now:()=>100000,operations:{deployment:()=>assert.fail('replay')}});
 await assert.rejects(again.execute(c),{code:'TLO_ACTIVATION_OUTCOME_UNCERTAIN'});
});
test('one authorized inference cannot be reauthorized across sessions',async()=>{
 const f=fixture();f.inv.tlo.deployment.state='active';
 await f.gate.execute(f.signed('first-inference','first-infer-10000'));
 await assert.rejects(f.gate.execute(f.signed('first-inference','second-infer-10000')),
 {code:'TLO_FIRST_INFERENCE_ALREADY_AUTHORIZED'});
});
test('invalid journal entries are rejected rather than forgotten',()=>{
 const f=fixture();fs.writeFileSync(f.journalPath,JSON.stringify({schema:subject.JOURNAL_SCHEMA,
 records:[{requestId:'request-1000',stage:'first-inference',state:'forged',payloadDigest:fingerprint}]}));
 assert.throws(()=>subject.createTloActivationRunnerGate({journalPath:f.journalPath,readSecret:()=>secret,
   readInventory:()=>f.inv}),{code:'TLO_ACTIVATION_JOURNAL_INVALID'});
});
test('corrupt runner journal disables activation without bringing down the server',async()=>{
 const f=fixture();fs.writeFileSync(f.journalPath, '{corrupt');
 const safe=subject.createSafeTloActivationRunnerGate({journalPath:f.journalPath,
   readSecret:()=>secret,readInventory:()=>f.inv});
 const r=await safe.handle({type:'tlo_activation_execute',requestId:'request-1000'});
 assert.equal(r.ok,false);assert.equal(r.code,'TLO_ACTIVATION_RUNNER_UNAVAILABLE');
});
