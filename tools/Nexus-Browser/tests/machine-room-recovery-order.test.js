'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
const ui=fs.readFileSync(path.join(__dirname,'../public/machine-supervised-jobs-ui.js'),'utf8');
function unit({approved=true,connected=true}={}) {
  const begin=ui.indexOf('  let lastRoomIntent = null;');
  const end=ui.indexOf('  const short = (value, length = 12)',begin);
  assert.ok(begin>0&&end>begin,'expected production shortcut segment');
  const calls=[], events={}, prompt={
    value:'/recover tools/fixture.js',
    addEventListener:(type,cb,cap)=>{
      assert.equal(cap,true);
      events[type]=cb;
    }
  };
  const ctx={
    roomList:{querySelector:()=>({dataset:{roomId:'room-123456'}})},
    spaceSelect:{value:'space-test'},dexPanel:{dataset:{humanInput:'enabled'}},
    dexPrompt:prompt,
    dexSend:{addEventListener:(type,cb,cap)=>{assert.equal(cap,true);events[type]=cb;}},
    socket:{readyState:connected?1:0,send:(s)=>calls.push(JSON.parse(s))},
    phase:connected?'connected':'reconnecting',WebSocket:{OPEN:1},
    recoveryStatus:{textContent:''},confirmAction:async()=>approved,
    globalThis:{crypto:{randomUUID:()=> 'a'.repeat(36)},BrowserAiBridgeRoomRecoveryIntent:require('../public/room-recovery-intent')},
    Date,JSON
  };
  vm.runInNewContext(ui.slice(begin,end),ctx);
  const event=(type,key='')=>({type,key,shiftKey:false,isComposing:false,
    prevented:false,stopped:false,preventDefault(){this.prevented=true;},
    stopImmediatePropagation(){this.stopped=true;}});
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  return {ctx,prompt,calls,events,event,flush};
}
test('click intercepts /recover synchronously and only prepares a job, never Dex relay',async()=>{
  const u=unit(), e=u.event('click');u.events.click(e);
  assert.equal(e.prevented,true);assert.equal(e.stopped,true);
  await u.flush();assert.equal(u.calls.length,1);
  assert.equal(u.calls[0].type,'machine_prepare_room_recovery');
  assert.equal(u.calls[0].scriptPath,'tools/fixture.js');
  assert.equal(u.calls.some(x=>x.type==='dex_relay_start'),false);
  // Pending receipt forbids another preparation even after the old 1.5s duplicate window.
  u.events.click(u.event('click'));await u.flush();assert.equal(u.calls.length,1);
});
test('Enter intercepts shortcut but non-shortcut and Shift+Enter continue normally',async()=>{
  const u=unit(),enter=u.event('keydown','Enter');u.events.keydown(enter);
  assert.equal(enter.prevented,true);assert.equal(enter.stopped,true);
  await u.flush();assert.equal(u.calls.length,1);
  const other=unit();other.prompt.value='ordinary room conversation';
  const normal=other.event('click');other.events.click(normal);
  assert.equal(normal.prevented,false);assert.equal(normal.stopped,false);
  assert.equal(other.calls.length,0);
  const multiline=unit(),shift=multiline.event('keydown','Enter');shift.shiftKey=true;
  multiline.events.keydown(shift);assert.equal(shift.prevented,false);
  assert.equal(multiline.calls.length,0);
});
test('cancel or disconnection never leaks /recover into a normal room relay',async()=>{
  for(const options of [{approved:false},{connected:false}]){
    const u=unit(options),e=u.event('click');u.events.click(e);
    assert.equal(e.stopped,true);await u.flush();assert.equal(u.calls.length,0);
    assert.equal(u.prompt.value,'/recover tools/fixture.js');
  }
});
test('production receipt/error handlers correlate preparation request IDs before unlocking',()=>{
  assert.match(ui,/lastRoomIntent\?\.requestId === payload\.requestId/);
  assert.match(ui,/if \(payload\.type === 'machine_recovery_job_prepared'\)/);
  assert.match(ui,/if \(payload\.type === 'error'/);
  assert.match(ui,/lastRoomIntent = ok \?/);
});
