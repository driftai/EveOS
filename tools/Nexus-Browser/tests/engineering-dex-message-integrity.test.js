'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeMessages } = require('../dex/server-state-merge');
const { createEngineeringCycle } = require('../dex/engineering-cycle');

const notice = (job = 'machine-job-a') => ({
  senderKind: 'system', senderName: 'Machine Spaces', senderId: null,
  text: '[ENGINEERING RECOVERY PREPARED]\nincident=' + job + '\nproposal=proposal-one\nrecoveryJob=machine-job-b\nThe exact repair remains inert until independent local-owner approval.',
  engineeringRecoveryPrepared: { incidentJobId: job, proposalMessageId:'proposal-one', recoveryJobId:'machine-job-b', state:'approval-pending', code:'ENGINEERING_RECOVERY_PREPARED' }
});

test('legacy idless prepared notices do not double through repeated browser/server merges', () => {
  let server=[{id:'legit-one',senderKind:'user',text:'preserve'} ,notice()];
  for(let i=0;i<18;i++) {
    server=mergeMessages(server,structuredClone(server));
    assert.equal(server.length,2);
  }
  assert.equal(server[0].id,'legit-one');
});

test('preexisting duplicate server records are preserved until separately authorized migration', () => {
  const broken=notice();
  const merged=mergeMessages([broken,broken,broken], [broken,broken,broken]);
  assert.equal(merged.length,3);
});

test('different legacy engineering notices and unrelated idless human messages remain distinct', () => {
  const first=notice(), second=notice('machine-job-another');
  const user={senderKind:'user',senderName:'Local operator',text:'same text'};
  const merged=mergeMessages([first,user], [first,second,user]);
  assert.equal(merged.length,4);
  assert.equal(merged.filter(m=>m.senderKind==='user').length,2);
});

test('fresh engineering-cycle prepared notifications have durable identity and timestamp', () => {
  let snapshot={rooms:[{id:'room-test', messages:[{id:'proposal-one',senderKind:'agent',engineeringProposal:{ok:true,incidentJobId:'machine-job-one',retryIntent:'after-verified-repair',repair:{kind:'source-patch',paths:['tools/test.js']}}}],engineeringCycleReceipts:[]}]};
  const load=()=>structuredClone(snapshot),save=s=>{snapshot=structuredClone(s);return load();};
  const cycle=createEngineeringCycle({load,save,broadcastState(){},now:()=> '2026-10-22T01:00:00.000Z',repoRoot:process.cwd(),resolveHead:()=> 'a'.repeat(40),
    incidentBridge:{handle(){return {ok:true}}},machineSpaces:{prepareEngineeringRecovery(){return {jobId:'machine-job-b'}}}});
  cycle.onJobSettled({jobId:'machine-job-one',roomId:'room-test',state:'failed'}, {retrySafety:'idempotent',repairFiles:['tools/test.js'],command:'node test.js'});
  assert.equal(cycle.reconcile().changed,true);
  const m=snapshot.rooms[0].messages.find(x=>x.engineeringRecoveryPrepared);
  assert.match(m.id,/^msg-engineering-recovery-[a-f0-9]{24}$/);
  assert.equal(m.at,'2026-10-22T01:00:00.000Z');
  assert.equal(cycle.reconcile().changed,false);
  assert.equal(snapshot.rooms[0].messages.length,2);
});

test('malformed ID-less engineering proposal is not used to prepare recovery', () => {
  let snapshot={rooms:[{id:'room-test', messages:[{senderKind:'agent',engineeringProposal:{ok:true,incidentJobId:'machine-job-one',retryIntent:'after-verified-repair',repair:{kind:'source-patch',paths:['tools/test.js']}}}],engineeringCycleReceipts:[]}]};
  const load=()=>structuredClone(snapshot),save=s=>{snapshot=structuredClone(s);return load();};
  let prepared=0;
  const cycle=createEngineeringCycle({load,save,repoRoot:process.cwd(),resolveHead:()=> 'a'.repeat(40),
    incidentBridge:{handle(){return {ok:true}}},machineSpaces:{prepareEngineeringRecovery(){prepared++;return {jobId:'machine-job-b'}}}});
  cycle.onJobSettled({jobId:'machine-job-one',roomId:'room-test',state:'failed'}, {retrySafety:'idempotent',repairFiles:['tools/test.js'],command:'node test.js'});
  assert.equal(cycle.reconcile().changed,false);
  assert.equal(prepared,0);
});
