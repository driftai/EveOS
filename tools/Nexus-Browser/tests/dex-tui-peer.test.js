'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createPeer}=require('../scripts/dex-tui-peer');
class FakeSocket extends EventEmitter {
  static OPEN=1;
  constructor() {super();this.readyState=0;this.sent=[];queueMicrotask(()=>{this.readyState=1;this.emit('open');});}
  send(data) { this.sent.push(JSON.parse(data)); }
  emitMessage(msg) { this.emit('message',Buffer.from(JSON.stringify(msg))); }
  close() {this.readyState=3;this.emit('close');}
}
test('Base UI peer announces an ordinary browser UI role and preserves read-only query matching',async()=>{
  const events=[],peer=createPeer({WebSocketImpl:FakeSocket,onEvent:e=>events.push(e),timeoutMs:500});
  await peer.start;
  assert.equal(peer.isOpen(),true);
  const req=peer.request({type:'request_local_targets'}, e=>e.type==='local_targets_update');
  peer.close();
  await assert.rejects(req,/closed/);
  assert.equal(peer.isOpen(),false);
});
test('peer accepts only a matching reply, and never repeats a command',async()=>{
  let sock;
  class Capture extends FakeSocket {constructor(...a){super(...a);sock=this;}}
  const peer=createPeer({WebSocketImpl:Capture,timeoutMs:600});
  await peer.start;
  assert.deepEqual(sock.sent[0],{type:'hello',role:'ui',clientKind:'browser'});
  const pending=peer.request({type:'request_machine_targets'},e=>e.type==='machine_targets_update');
  sock.emitMessage({type:'local_targets_update',targets:[]});
  sock.emitMessage({type:'machine_targets_update',targets:[{id:'a'}]});
  const result=await pending;
  assert.equal(result.targets[0].id,'a');
  assert.equal(sock.sent.filter(e=>e.type==='request_machine_targets').length,1);
  peer.close();
});
