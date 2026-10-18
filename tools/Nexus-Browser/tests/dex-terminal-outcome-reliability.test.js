'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { stateFor } = require('../dex/terminal-turn-outcome');
const { runTui } = require('../scripts/dex-room-tui');
const member = 'tlo';
function room() { return { id: 'room-proof123456', members: [{ id: member }],
  relay: { active: true }, messages: [{ id: 'user-a', senderKind: 'user', clientRequestId: 'request-a' }],
  finalReceipts: [] }; }
test('correlates new final by exact source across later user messages', () => {
  const r = room();
  r.messages.push({ id:'user-b', senderKind:'user', clientRequestId:'request-b' },
    { id:'agent-a', senderKind:'agent', senderId:member, text:'A only' });
  r.finalReceipts.push({ sourceMessageId:'user-a', requestId:'turn-a', messageId:'agent-a' });
  assert.equal(stateFor(r,'request-a').response.text,'A only');
  assert.notEqual(stateFor(r,'request-b').status,'FINAL_RECEIPT_CONFIRMED');
});
test('does not misattribute old uncorrelated final after a missing earlier response', () => {
  const r=room();
  r.messages.push({ id:'user-b', senderKind:'user', clientRequestId:'request-b' },
    { id:'agent-a', senderKind:'agent', senderId:member, text:'Ambiguous old final' });
  r.finalReceipts.push({ requestId:'turn-a', messageId:'agent-a' });
  assert.notEqual(stateFor(r,'request-b').status,'FINAL_RECEIPT_CONFIRMED');
});
test('recognized Search Monitor failure has terminal status', () => {
  const r=room();r.relay.active=false;r.messages.push({id:'err',senderKind:'system',
    relayFailure:true,sourceMessageId:'user-a',turnRequestId:'turn-a',
    text:'TLO: SEARCH_MONITOR_WORKSPACE_DISCONNECTED: Search Monitor disconnected.'});
  const out=stateFor(r,'request-a');
  assert.equal(out.status,'TURN_FAILED');
  assert.equal(out.code,'SEARCH_MONITOR_WORKSPACE_DISCONNECTED');
});
test('legacy Dex error in unambiguous user segment is a terminal failure', () => {
  const r=room();r.relay.active=false;r.messages.push({senderKind:'system',senderName:'Dex',
    text:'TLO: SEARCH_MONITOR_WORKSPACE_DISCONNECTED: Offline.'});
  assert.equal(stateFor(r,'request-a').status,'TURN_FAILED');
});
test('unsettled inactive request is not misrepresented as pending', () => {
  const r=room();r.relay.active=false;
  r.relay.lastStopReason='TLO marked the room complete';
  assert.equal(stateFor(r,'request-a').status,'TURN_OUTCOME_UNKNOWN');
});

test('idle without authoritative stop evidence is still awaiting', () => {
  const r=room();r.relay.active=false;
  assert.equal(stateFor(r,'request-a').status,'AWAITING_REPLY_OR_RECOVERY');
});
test('visible reply before a final receipt retains non-final status', () => {
  const r=room();r.relay.active=false;
  r.messages.push({id:'reply-a',senderKind:'agent',senderId:member,text:'Hello but unconfirmed'});
  const pending=stateFor(r,'request-a');
  assert.equal(pending.status,'REPLY_OBSERVED_NOT_FINAL');
  assert.equal(pending.response.text,'Hello but unconfirmed');
  r.finalReceipts.push({requestId:'turn-a',messageId:'reply-a'});
  assert.equal(stateFor(r,'request-a').status,'FINAL_RECEIPT_CONFIRMED');
});
test('unauthorized or later reply cannot count as an unconfirmed exact answer', () => {
  const r=room();
  r.messages.push({id:'user-b',senderKind:'user',clientRequestId:'request-b'},
    {id:'wrong',senderKind:'agent',senderId:'not-a-member',text:'No'});
  assert.equal(stateFor(r,'request-a').status,'AWAITING_REPLY_OR_RECOVERY');
  assert.notEqual(stateFor(r,'request-b').status,'REPLY_OBSERVED_NOT_FINAL');
});
test('progress/preview only available for matching source turn', () => {
  const r=room();r.recovery={sourceMessageId:'user-a',requestId:'turn-a',dispatched:true};
  assert.equal(stateFor(r,'request-a',{roomId:r.id,sourceMessageId:'user-a',
    requestId:'turn-a',partialText:'Hi TLO'}).partialText,'Hi TLO');
  assert.equal(stateFor(r,'request-a',{roomId:r.id,sourceMessageId:'user-other',
    partialText:'Not this turn'}).partialText,'');
});
test('TUI terminates failed watcher without resending', async () => {
  const input=new PassThrough(), output=new PassThrough(); let log='',sendCount=0,n=0;
  output.on('data',c=>{log+=String(c)});
  const work=runTui({room:'room-proof123456'},{input,output,pollMs:2,timeoutMs:300,
    id:()=> 'request-000'+(++n),
    payload:p=>({type:p.command,requestId:p.requestId}),
    tx:async msg=>msg.type==='send'?(sendCount++,{ok:true,status:'MESSAGE_COMMITTED_RELAY_ACCEPTED'})
      :{ok:true,status:'TURN_FAILED',code:'SEARCH_MONITOR_WORKSPACE_DISCONNECTED',message:'Offline'}});
  input.write('test\n');
  const until=Date.now()+700;
  while(!log.includes('SEARCH_MONITOR_WORKSPACE_DISCONNECTED') && Date.now()<until)await new Promise(r=>setTimeout(r,5));
  input.write('/quit\n');await work;
  assert.match(log,/SEARCH_MONITOR_WORKSPACE_DISCONNECTED/);
  assert.equal(sendCount,1);
});
test('TUI can display bounded progress before authoritative final', async () => {
  const input=new PassThrough(),output=new PassThrough();let log='',checks=0,n=0;
  output.on('data',c=>{log+=String(c)});
  const work=runTui({room:'room-proof123456'},{input,output,pollMs:2,timeoutMs:500,
    id:()=> 'request-000'+(++n),payload:p=>({type:p.command}),
    tx:async msg=>msg.type==='send'?{ok:true,status:'MESSAGE_COMMITTED_RELAY_ACCEPTED'}
      :++checks===1?{ok:true,status:'AWAITING_REPLY_OR_RECOVERY',progress:'generating',partialText:'Hello'}
        :{ok:true,status:'FINAL_RECEIPT_CONFIRMED',response:{text:'Hello'}}});
  input.write('hello\n');
  const until=Date.now()+700;
  while(!log.includes('TLO/Dex> Hello') && Date.now()<until)await new Promise(r=>setTimeout(r,5));
  input.write('/quit\n');await work;
  assert.match(log,/live preview/);
  assert.match(log,/TLO\/Dex> Hello/);
});
