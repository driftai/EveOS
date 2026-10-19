'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { displayName, promptFor } = require('../scripts/dex-tui-identity');
const { PassThrough } = require('node:stream');
const { runTui } = require('../scripts/dex-room-tui');
const { summary, projection } = require('../dex/terminal-operator');
async function wait(fn) { const deadline=Date.now()+1500;
  while(!fn()&&Date.now()<deadline) await new Promise(r=>setTimeout(r,5));
  assert.ok(fn(),'expected prompt did not appear'); }
test('identity is safe display text, never interpreted as control sequence',()=>{
  assert.equal(promptFor('Drift','Dex'),'Drift/Dex> ');
  assert.equal(promptFor('Drift','Base'),'Drift/Base> ');
  assert.equal(promptFor('', 'Base'),'User/Base> ');
  assert.equal(displayName('\x1b[31m\r\nBad/Name'), '31m BadName');
  assert.doesNotMatch(promptFor('\x1b[31m', 'Dex'), /\x1b|\n|\r/);
});
test('room summary and inspect expose the authoritative configured userName read-only',()=>{
  const room={id:'room-proof000001',name:'Proof',userName:'Drift',relay:{active:false},
    members:[],messages:[{id:'user-1',senderKind:'user',senderName:'Old username',text:'hi'}]};
  assert.equal(summary(room).userName,'Drift');
  assert.equal(projection(room,{limit:10}).userName,'Drift');
  assert.equal(room.messages[0].senderName,'Old username');
});
test('Dex prompt names the user without sending anything on navigation',async()=>{
  const input=new PassThrough(),output=new PassThrough();let log='',calls=0;
  output.on('data',c=>log+=String(c));
  const work=runTui({room:'room-proof000001'},{input,output,displayName:'Drift',
    id:()=> 'request-0001',payload:p=>({type:p.command}),
    tx:async()=>{calls++;throw new Error('navigation must not call transport')}});
  await wait(()=>log.includes('Drift/Dex> '));
  input.write('/home\n');
  assert.equal((await work).navigation,'home');
  assert.equal(calls,0);
});
test('direct room launch resolves userName by read-only inspect, not a send',async()=>{
  const input=new PassThrough(),output=new PassThrough();let log='',calls=[];
  output.on('data',c=>log+=String(c));
  const work=runTui({room:'room-proof000001'},{input,output,resolveIdentity:true,
    id:()=> 'request-0001',payload:p=>({type:p.command}),tx:async m=>{
      calls.push(m.type);return {ok:true,userName:'Drift',messages:[]};}});
  await wait(()=>log.includes('Drift/Dex> '));
  input.write('/home\n');await work;
  assert.deepEqual(calls,['inspect']);
});
