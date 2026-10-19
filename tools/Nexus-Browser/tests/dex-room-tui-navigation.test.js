'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { runTui } = require('../scripts/dex-room-tui');
async function visit(command) {
  const input = new PassThrough(), output = new PassThrough();
  let result = '', n = 0;
  output.on('data', b => result += String(b));
  const task = runTui({ room:'room-test000001' }, {
    input, output, id:()=>`request-${++n}`,
    payload:p=>({type:p.command}), tx:async()=>{throw Error('No transport expected for navigation.');}
  });
  input.write(`${command}\n`);
  return { result: await task, text: result };
}
test('room /back returns to the picker with no transport call',async()=>{
  assert.equal((await visit('/back')).result.navigation,'rooms');
  assert.equal((await visit('/rooms')).result.navigation,'rooms');
});
test('room /home returns to Nexus home; /quit exits all',async()=>{
  assert.equal((await visit('/home')).result.navigation,'home');
  assert.equal((await visit('/quit')).result.navigation,'quit');
});
test('quiet commands only alter local presentation',async()=>{
  const input=new PassThrough(),output=new PassThrough();let log='';
  output.on('data',b=>log+=String(b));
  const task=runTui({room:'room-test000001'},{input,output,id:()=> 'request-test',payload:p=>({type:p.command}),tx:async()=>{throw Error('No transport expected');}});
  input.write('/quiet on\n');
  const deadline=Date.now()+1500;
  while(!log.includes('Quiet mode ON')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
  input.write('/home\n');await task;
  assert.match(log,/Quiet mode ON/);
});
