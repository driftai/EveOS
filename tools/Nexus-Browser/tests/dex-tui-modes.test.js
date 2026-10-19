'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { runBase, TLO_ID, showTargets } = require('../scripts/dex-tui-base');
const { runSpaces, showRoom } = require('../scripts/dex-tui-spaces');
const wait = async check => {
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), 'no expected TUI output');
};
function fixture(options = {}) {
  const input = new PassThrough(), output = new PassThrough(), sent = [];
  let transcript = '', event;
  output.on('data', c => transcript += String(c));
  const connection = ({ onEvent } = {}) => {
    event = onEvent;
    return {
      start: Promise.resolve(), close() {},
      send(message) { sent.push(message); return true; },
      async request(message) {
        sent.push(message);
        if (message.type === 'request_local_targets') return { targets: options.targets || [
          {id:TLO_ID, providerName:'TLO', title:'TLO Chat',targetClassId:'local-origin'},
          {id:'local:another-test',providerName:'Other',title:'Other',targetClassId:'local-origin'}] };
        if (message.type === 'select_local_target') return { target:{id:message.targetId} };
        if (message.type === 'request_machine_targets') return { targets: [{id:'terminal-123456',label:'TLO Proof', type:'powershell'}] };
        if (message.type === 'machine_room_snapshot') return {roomId:message.roomId,roomName:'TLO Proof Room',spaces:[
          {id:'space-123456', name:'Proof', archived:false,grant:{enabled:false},
            resources:[{id:'terminal-123456',available:true}], requests:[]} ]};
        throw new Error('Unexpected request '+message.type);
      }
    };
  };
  return { input, output, sent, transcript: () => transcript,
    connection, event: m => event?.(m) };
}
test('Base displays TLO as existing Local-Origin target and sends once only after selection', async () => {
  const f = fixture(), t = runBase({ input:f.input, output:f.output,createConnection:f.connection,id:()=> 'base-request-1'});
  await wait(() => f.transcript().includes('base> '));
  f.input.write('1\n'); await wait(() => f.transcript().includes('User/Base> '));
  f.input.write('hello TLO\n'); await wait(() => f.sent.some(x=>x.type==='send_prompt'));
  f.input.write('not yet\n'); await wait(() => f.transcript().includes('no duplicate prompt sent'));
  assert.equal(f.sent.filter(x=>x.type==='send_prompt').length,1);
  assert.deepEqual(f.sent.find(x=>x.type==='send_prompt'), {
    type:'send_prompt',targetClassId:'local-origin',targetId:TLO_ID,
    requestId:'base-request-1',text:'hello TLO',clientSentAt:f.sent.find(x=>x.type==='send_prompt').clientSentAt
  });
  f.event({type:'response_final',requestId:'another',text:'not ours'});
  f.event({type:'response_final',requestId:'base-request-1',text:'Hi'});
  await wait(() => f.transcript().includes('TLO/Base> Hi'));
  f.input.write('/home\n'); assert.equal((await t).navigation,'home');
});
test('Base other local target can be selected but cannot send unqualified command',async()=>{
  const f=fixture(),t=runBase({input:f.input,output:f.output,createConnection:f.connection});
  await wait(()=>f.transcript().includes('base> '));
  f.input.write('2\n');await wait(()=>f.transcript().includes('User/Base> '));
  f.input.write('hello\n');await wait(()=>f.transcript().includes('inspect-only'));
  f.input.write('/home\n');await t;
  assert.equal(f.sent.filter(x=>x.type==='send_prompt').length,0);
});
test('Machine Spaces view only invokes read-only inventory and room snapshot',async()=>{
  const f=fixture(), r='room-proof000001';
  const t=runSpaces({input:f.input,output:f.output,createConnection:f.connection,
    id:()=> 'request-id',makePayload:p=>({type:p.command}),
    tx:async msg=> {f.sent.push(msg);return {ok:true,rooms:[{roomId:r,roomName:'Proof Room',machineSpaceId:'space-123456'}]};}});
  await wait(()=>f.transcript().includes('spaces> '));
  f.input.write('1\n');await wait(()=>f.transcript().includes('TLO Proof Room'));
  assert.match(f.transcript(),/grant: none\/disabled/);
  f.input.write('/home\n'); await t;
  assert.deepEqual(f.sent.map(x=>x.type),['request_machine_targets','rooms','machine_room_snapshot','request_machine_targets','rooms']);
});
test('Remote target labels and space resource labels cannot inject controls',()=>{
  assert.doesNotMatch(showTargets([{id:'target',providerName:'TLO\x1b[31m'}]),/\x1b/);
  assert.doesNotMatch(showRoom({roomName:'Proof\x1b[1J',spaces:[]}),/\x1b/);
});
test('Base disconnect after possible send records original unknown outcome without replay',async()=>{
  const f=fixture(),t=runBase({input:f.input,output:f.output,createConnection:f.connection,id:()=> 'base-request-unknown'});
  await wait(()=>f.transcript().includes('base> '));
  f.input.write('1\n');await wait(()=>f.transcript().includes('User/Base> '));
  f.input.write('hello\n');await wait(()=>f.sent.filter(x=>x.type==='send_prompt').length===1);
  f.event({type:'transport_closed'});await wait(()=>f.transcript().includes('outcome unknown for base-request-unknown'));
  f.input.write('hello\n');await wait(()=>f.transcript().includes('no duplicate prompt sent'));
  f.input.write('/home\n');await t;
  assert.equal(f.sent.filter(x=>x.type==='send_prompt').length,1);
});
test('Base uses named user as input and target as separate reply identity',async()=>{
  const f=fixture(), t=runBase({input:f.input,output:f.output,displayName:'Drift',
    createConnection:f.connection,id:()=> 'request-labelled-1'});
  await wait(()=>f.transcript().includes('base> '));
  f.input.write('1\n');await wait(()=>f.transcript().includes('Drift/Base> '));
  f.input.write('hello\n');await wait(()=>f.sent.some(x=>x.type==='send_prompt'));
  f.event({type:'response_final',requestId:'request-labelled-1',text:'Hello Drift'});
  await wait(()=>f.transcript().includes('TLO/Base> Hello Drift'));
  f.input.write('/home\n');await t;
  assert.equal(f.sent.filter(x=>x.type==='send_prompt').length,1);
});
