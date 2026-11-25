// v13.10.7 falsifiers, driven through the real modules with a virtual clock and a fake YouTube player:
// zero convergence inside Locked, solo linked-tab sync, embedded solo controls, TV terminal recovery,
// room audio on join, and verified source-tab mute. Red on v13.10.5 (the modules or routes do not exist).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { runSourceWorkerChecks } from './v13107-falsifiers-source-worker.js';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

export function world(extra = {}) {
  let now = 0, seq = 0; const timers = new Map();
  const ctx = {Math, JSON, Number, String, Array, Object, Error, console, Promise, Set, Map, ...extra};
  ctx.Date = class extends Date { static now() { return 1.7e12 + now; } };
  ctx.performance = {now: () => now};
  ctx.setTimeout = (fn, ms = 0) => { const id = ++seq; timers.set(id, {fn, at: now + ms}); return id; };
  ctx.setInterval = (fn, ms) => { const id = ++seq; timers.set(id, {fn, at: now + ms, every: ms}); return id; };
  ctx.clearTimeout = ctx.clearInterval = id => timers.delete(id);
  const nodes = new Map();
  ctx.document = {hidden: false, addEventListener() {},
    getElementById: id => nodes.get(id) || (id === 'syncStatus' ? {parentNode: {insertBefore: n => nodes.set(n.id, n)}} : null),
    createElement: () => ({style: {}, setAttribute() {}, addEventListener(type, fn) { this.click = fn; }})};
  // Browser window events exist in production. Mirror them in the Node VM
  // without dispatching synthetic gestures to force success.
  const windowListeners = new Map();
  ctx.addEventListener = (type, fn) => {
    if (!windowListeners.has(type)) windowListeners.set(type, []);
    windowListeners.get(type).push(fn);
  };
  ctx.removeEventListener = (type, fn) => {
    windowListeners.set(type, (windowListeners.get(type) || []).filter(item => item !== fn));
  };
  ctx.windowListeners = windowListeners;
  ctx.window = ctx.globalThis = ctx;
  vm.createContext(ctx);
  ctx.nodes = nodes;
  ctx.advance = ms => { const end = now + ms;
    for (;;) { let next = null; for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
      if (!next) break; const [id, t] = next; now = t.at; ctx.tick?.(now); if (t.every) t.at += t.every; else timers.delete(id); t.fn(); }
    now = end; ctx.tick?.(now); };
  ctx.clock = () => now;
  return ctx;
}
export function fakePlayer(ctx, {rates = [.75, 1, 1.25], position = 30, state = 1, muted = false} = {}) {
  const p = {position, rate: 1, state, muted, volume: 100, calls: [], last: 0, videoId: 'AAAAAAAAAAA', rates};
  ctx.tick = now => { const dt = (now - p.last) / 1000; p.last = now; if (p.state === 1) p.position += dt * p.rate; };
  Object.assign(p, {getCurrentTime: () => p.position, getPlaybackRate: () => p.rate, getAvailablePlaybackRates: () => p.rates,
    setPlaybackRate: r => { p.calls.push(['rate', r]); if (p.rates.includes(r)) p.rate = r; }, getPlayerState: () => p.state,
    getVideoData: () => ({video_id: p.videoId}), getDuration: () => 600, seekTo: v => { p.calls.push(['seek', v]); p.position = v; },
    pauseVideo: () => { p.calls.push(['pause']); p.state = 2; }, playVideo: () => { p.calls.push(['play']); p.state = 1; },
    isMuted: () => p.muted, mute: () => { p.muted = true; }, unMute: () => { p.calls.push(['unmute']); p.muted = false; },
    setVolume: v => { p.volume = v; }, getVolume: () => p.volume});
  return p;
}
export function roomGlobals(ctx, player, {targetOffsetSec, uncertaintyMs = 110, host = false, owns = () => false} = {}) {
  Object.assign(ctx, {roomId: 'ROOM', ytPlayer: player, ytPlayerReady: true, playerInitializing: false, primingPlayer: false, applyingRemote: false,
    state: {source: {videoId: 'AAAAAAAAAAA'}, playback: {paused: false, ended: false, rate: 1}, presentationEpoch: 1, playoutSegment: 1, linkedSourceActive: true},
    estimatedServerNow: () => ctx.Date.now(), isHost: () => host,
    watchFusionViewerArbiter: {owns}, watchFusionPlayout: {status: () => ({source: 'live', uncertaintyMs, reference: 'peer-cohort'}), sourceBuffering: () => false},
    watchFusionYouTubeTarget: () => 30 + ctx.clock() / 1000 + targetOffsetSec});
}

export async function runV13107Checks(check) {
  await check('WF06G-01:same-player clock veto during measured verification earns one clean rearm',()=>{
    const ctx=world(),p=fakePlayer(ctx,{position:29.62});
    roomGlobals(ctx,p,{targetOffsetSec:0,host:true,uncertaintyMs:12});
    ctx.watchFusionPlayout.status=()=>({source:'live',reference:'linked-tab',uncertaintyMs:12});
    let starts=0,vetoUntil=-1;const events=[];
    ctx.WatchFusionHostSeekPolicy={sourceBlocker:()=>ctx.clock()<vetoUntil?'host-source-disagrees':null};
    ctx.watchFusionViewerArbiter.snapshot=()=>({timelineErrorMs:(30+ctx.clock()/1000-p.position)*1000,timelineObservedAtMs:ctx.clock()});
    ctx.watchFusionRoomSyncLog={note:(kind,detail)=>events.push({kind,...detail})};
    p.setPlaybackRate=r=>{p.calls.push(['rate',r]);if(r!==1)starts++;
      else if(starts===4 && p.rate!==1){vetoUntil=ctx.clock()+9000;}p.rate=r;};
    p.getCurrentTime=()=>p.position+(p.rate!==1&&(starts===2||starts===3)?.055:0);
    vm.runInContext(read('public/client/zero-converge.js'),ctx);ctx.advance(8000);
    assert.equal(ctx.WatchFusionZeroConverge.diagnostics().hostRateRecheck.measuredImprovement,true);
    p.position=30+ctx.clock()/1000-.075;ctx.advance(25000);
    assert.equal(starts,4);assert.ok(events.some(e=>e.kind==='zero-actuator-verification-lost'&&e.reason==='verification-context-changed'));
    p.position=30+ctx.clock()/1000-.214;ctx.advance(90000);
    assert.equal(events.filter(e=>e.kind==='zero-actuator-measurement-rearmed').length,1);
    assert.ok(Math.abs(30+ctx.clock()/1000-p.position)*1000<=25);assert.equal(p.rate,1);
    assert.ok(p.calls.every(([kind])=>kind==='rate'));
  });
  await check('WF06F-01:533ms host resume lag converges without a seek or hold',()=>{
    const ctx=world(),p=fakePlayer(ctx,{position:29.467});
    roomGlobals(ctx,p,{targetOffsetSec:0,host:true,uncertaintyMs:12});
    ctx.watchFusionPlayout.status=()=>({source:'live',reference:'linked-tab',uncertaintyMs:12});
    ctx.WatchFusionHostSeekPolicy={sourceBlocker:()=>null};
    ctx.watchFusionViewerArbiter.snapshot=()=>({timelineErrorMs:(30+ctx.clock()/1000-p.position)*1000,timelineObservedAtMs:ctx.clock()});
    vm.runInContext(read('public/client/zero-converge.js'),ctx);ctx.advance(30000);
    assert.ok(Math.abs(60-p.position)*1000<=25);assert.equal(p.rate,1);
    assert.ok(p.calls.some(([kind,r])=>kind==='rate'&&r>1));
    assert.ok(p.calls.every(([kind])=>kind==='rate'));
  });
  await check('WF06F-02:extended host catchup still requires same-source dual-clock evidence',()=>{
    for(const mode of ['contradicted','uncertain','stale','disagree','too-large','ahead']){
      const offset=mode==='too-large'?.751:mode==='ahead'?-.533:.533;
      const ctx=world(),p=fakePlayer(ctx,{position:30-offset});
      roomGlobals(ctx,p,{targetOffsetSec:0,host:true,uncertaintyMs:12});
      ctx.watchFusionPlayout.status=()=>({source:'live',reference:'linked-tab',uncertaintyMs:mode==='uncertain'?36:12,mirrorContradicted:mode==='contradicted'});
      ctx.WatchFusionHostSeekPolicy={sourceBlocker:()=>mode==='disagree'?'host-source-disagrees':null};
      ctx.watchFusionViewerArbiter.snapshot=()=>({timelineErrorMs:offset*1000,timelineObservedAtMs:ctx.clock()-(mode==='stale'?601:0)});
      vm.runInContext(read('public/client/zero-converge.js'),ctx);ctx.advance(30000);
      assert.equal(p.calls.length,0,mode);assert.equal(p.rate,1,mode);
    }
  });
  await check('WF06F-03:ordinary TV audio gestures cannot restart a paused or buffering decoder',()=>{
    for(const state of [2,3]){
      const ctx=world(),p=fakePlayer(ctx,{muted:true,state});roomGlobals(ctx,p,{targetOffsetSec:0});
      let applications=0;
      Object.assign(ctx,{autoplayWasBlocked:true,userGesturePrimeUsed:false,authoritativeRoomAudio:()=>({volume:57,muted:false}),
        applyRoomAudioState:()=>{applications++;p.unMute();return true;}});
      vm.runInContext(read('public/client/room-audio-unlock.js'),ctx);ctx.advance(500);
      for(let i=0;i<4;i++){
        for(const kind of ['pointerdown','keydown','click'])for(const fn of ctx.windowListeners.get(kind)||[])fn({isTrusted:true,target:{closest:()=>null}});
        ctx.advance(1000);
      }
      assert.equal(applications,0);assert.equal(p.state,state);assert.equal(p.calls.length,0);
      p.state=1;ctx.advance(100);
      for(const fn of ctx.windowListeners.get('click')||[])fn({isTrusted:true,target:{closest:()=>null}});
      assert.equal(applications,1);assert.equal(p.muted,false);assert.ok(p.calls.every(([kind])=>kind==='unmute'));
    }
  });
  await check('WF06F-06:explicit room-audio button can recover blocked pause but not buffering or a paused room',()=>{
    const ctx=world(),p=fakePlayer(ctx,{muted:true,state:2});roomGlobals(ctx,p,{targetOffsetSec:0});
    Object.assign(ctx,{autoplayWasBlocked:true,userGesturePrimeUsed:false,authoritativeRoomAudio:()=>({volume:57,muted:false}),
      applyRoomAudioState:()=>{p.unMute();return true;}});
    vm.runInContext(read('public/client/room-audio-unlock.js'),ctx);ctx.advance(500);
    const button=ctx.nodes.get('watchfusionEnableRoomAudio');assert.equal(button.hidden,false);
    p.state=3;button.click();assert.equal(p.calls.length,0);
    p.state=2;ctx.state.playback.paused=true;button.click();assert.equal(p.calls.length,0);
    ctx.state.playback.paused=false;button.click();assert.deepEqual(p.calls,[['unmute'],['play']]);
  });
  await check('WF06F-07:repeated room audio toggles preserve player motion rate and transport segment',()=>{
    const ctx=world({location:{hostname:'localhost',search:''},URLSearchParams,URL}),p=fakePlayer(ctx);ctx.testPlayer=p;
    vm.runInContext(read('public/client/core.js'),ctx);
    vm.runInContext("roomId='ROOM';session={publicId:'TV'};ytPlayer=testPlayer;ytPlayerReady=true;state={hostId:'HOST',presentationEpoch:1,playoutSegment:5,linkedSourceActive:true,source:{videoId:'AAAAAAAAAAA'},playback:{paused:false,rate:1,volume:57,muted:false}};",ctx);
    vm.runInContext(read('public/client/room-audio-unlock.js'),ctx);
    p.rate=1.25;const start=p.position;
    for(let i=0;i<8;i++){
      vm.runInContext(`state.playback.muted=${i%2===0};applyRoomAudioState();`,ctx);
      ctx.advance(500);assert.equal(p.muted,i%2===0);assert.equal(p.rate,1.25);assert.equal(p.state,1);
      assert.equal(vm.runInContext('state.playoutSegment',ctx),5);
    }
    assert.equal(p.volume,57);assert.ok(Math.abs(p.position-start-5)<.001);
    assert.ok(p.calls.every(([kind])=>kind==='unmute'));
  });
  await check('WF06C-01:quiet precise host trims a stable 32ms offset without waiting for drift',()=>{
    const ctx=world(),p=fakePlayer(ctx,{position:29.968});
    roomGlobals(ctx,p,{targetOffsetSec:0,host:true,uncertaintyMs:10});
    ctx.watchFusionPlayout.status=()=>({source:'live',reference:'linked-tab',uncertaintyMs:10});
    ctx.WatchFusionHostSeekPolicy={sourceBlocker:()=>null};
    ctx.watchFusionViewerArbiter.snapshot=()=>({timelineErrorMs:(30+ctx.clock()/1000-p.position)*1000,timelineObservedAtMs:ctx.clock()});
    vm.runInContext(read('public/client/zero-converge.js'),ctx);ctx.advance(10000);
    assert.ok(Math.abs(40-p.position)*1000<=16);assert.equal(p.rate,1);
    assert.ok(p.calls.every(([kind])=>kind==='rate'));
  });
  await check('WF06C-02:neutral measured trials and timestamp contamination share one bounded rearm',()=>{
    const ctx=world(),p=fakePlayer(ctx,{position:29.948});
    roomGlobals(ctx,p,{targetOffsetSec:0,host:true,uncertaintyMs:10});
    ctx.watchFusionPlayout.status=()=>({source:'live',reference:'linked-tab',uncertaintyMs:10});
    ctx.WatchFusionHostSeekPolicy={sourceBlocker:()=>null};
    ctx.watchFusionViewerArbiter.snapshot=()=>({timelineErrorMs:(30+ctx.clock()/1000-p.position)*1000,timelineObservedAtMs:ctx.clock()});
    let starts=0;const events=[];ctx.watchFusionRoomSyncLog={note:(kind,detail)=>events.push({kind,...detail})};
    p.setPlaybackRate=r=>{p.calls.push(['rate',r]);if(r!==1)starts++;else p.position=29.948+ctx.clock()/1000;p.rate=r;};
    p.getCurrentTime=()=>p.position+(p.rate!==1&&starts===2?.055:0);
    vm.runInContext(read('public/client/zero-converge.js'),ctx);ctx.advance(200000);
    assert.equal(starts,6);assert.equal(p.rate,1);
    assert.equal(events.filter(e=>e.kind==='zero-actuator-measurement-rearmed').length,1);
    assert.equal(ctx.WatchFusionZeroConverge.diagnostics().hostRateRecheck.measuredImprovement,false);
  });
  await check('WF06C-03:visibility changes do not replenish exhausted same-segment no-effect budget',()=>{
    const ctx=world(),p=fakePlayer(ctx,{position:29.925});let visibility;
    ctx.document.addEventListener=(kind,fn)=>{if(kind==='visibilitychange')visibility=fn;};
    roomGlobals(ctx,p,{targetOffsetSec:0,host:true,uncertaintyMs:12});
    ctx.watchFusionPlayout.status=()=>({source:'live',reference:'linked-tab',uncertaintyMs:12});
    ctx.WatchFusionHostSeekPolicy={sourceBlocker:()=>null};
    ctx.watchFusionViewerArbiter.snapshot=()=>({timelineErrorMs:75,timelineObservedAtMs:ctx.clock()});
    ctx.tick=at=>{p.position=29.925+at/1000;};
    vm.runInContext(read('public/client/zero-converge.js'),ctx);ctx.advance(55000);
    ctx.document.hidden=true;visibility();ctx.advance(2000);ctx.document.hidden=false;visibility();ctx.advance(100000);
    assert.equal(p.calls.filter(([kind,r])=>kind==='rate'&&r!==1).length,3);assert.equal(p.rate,1);
  });
  await check('WF06C-04:small host trims still require low clock uncertainty and quiet measurements',()=>{
    for(const precision of [11,20]){
      const ctx=world(),p=fakePlayer(ctx,{position:29.968});
      roomGlobals(ctx,p,{targetOffsetSec:0,host:true,uncertaintyMs:precision});
      ctx.watchFusionPlayout.status=()=>({source:'live',reference:'linked-tab',uncertaintyMs:precision});
      ctx.WatchFusionHostSeekPolicy={sourceBlocker:()=>null};
      ctx.watchFusionViewerArbiter.snapshot=()=>({timelineErrorMs:32,timelineObservedAtMs:ctx.clock()});
      vm.runInContext(read('public/client/zero-converge.js'),ctx);ctx.advance(20000);
      assert.equal(p.calls.length,0);
    }
  });
  await check('WF06C-05:slow recurrent host drift is trimmed without transport jumps',()=>{
    const ctx=world(),p=fakePlayer(ctx,{position:29.968});
    roomGlobals(ctx,p,{targetOffsetSec:0,host:true,uncertaintyMs:10});
    ctx.watchFusionPlayout.status=()=>({source:'live',reference:'linked-tab',uncertaintyMs:10});
    ctx.WatchFusionHostSeekPolicy={sourceBlocker:()=>null};
    ctx.watchFusionViewerArbiter.snapshot=()=>({timelineErrorMs:(30+ctx.clock()/1000-p.position)*1000,timelineObservedAtMs:ctx.clock()});
    const tick=ctx.tick;let last=0;ctx.tick=at=>{tick(at);p.position-=(at-last)*.0000005;last=at;};
    vm.runInContext(read('public/client/zero-converge.js'),ctx);
    for(let i=0;i<18;i++){ctx.advance(10000);assert.ok(Math.abs(30+ctx.clock()/1000-p.position)*1000<35);}
    assert.ok(p.calls.filter(([kind,r])=>kind==='rate'&&r!==1).length>=2);
    assert.ok(p.calls.every(([kind])=>kind==='rate'));assert.equal(p.rate,1);
  });
  await check('WF06C-06:visibility interruption immediately restores an active rate',()=>{
    const ctx=world(),p=fakePlayer(ctx,{position:29.925});let visibility;
    ctx.document.addEventListener=(kind,fn)=>{if(kind==='visibilitychange')visibility=fn;};
    roomGlobals(ctx,p,{targetOffsetSec:0,host:true,uncertaintyMs:12});
    ctx.watchFusionPlayout.status=()=>({source:'live',reference:'linked-tab',uncertaintyMs:12});
    ctx.WatchFusionHostSeekPolicy={sourceBlocker:()=>null};
    ctx.watchFusionViewerArbiter.snapshot=()=>({timelineErrorMs:(30+ctx.clock()/1000-p.position)*1000,timelineObservedAtMs:ctx.clock()});
    vm.runInContext(read('public/client/zero-converge.js'),ctx);ctx.advance(2275);
    assert.equal(p.rate,1.25);ctx.document.hidden=true;visibility();assert.equal(p.rate,1);
    const count=p.calls.length;ctx.advance(60000);assert.equal(p.calls.length,count);
    assert.equal(ctx.WatchFusionZeroConverge.diagnostics().capabilities[0].attempts,1);
  });
  await check('WF06B-01:contaminated early media reads earn one bounded retry, not false rate proof',()=>{
    const ctx=world(), p=fakePlayer(ctx,{position:29.925});
    roomGlobals(ctx,p,{targetOffsetSec:0,host:true,uncertaintyMs:12});
    ctx.watchFusionPlayout.status=()=>({source:'live',reference:'linked-tab',uncertaintyMs:12});
    ctx.WatchFusionHostSeekPolicy={sourceBlocker:()=>null};
    ctx.watchFusionViewerArbiter.snapshot=()=>({timelineErrorMs:(30+ctx.clock()/1000-p.position)*1000,timelineObservedAtMs:ctx.clock()});
    const events=[];ctx.watchFusionRoomSyncLog={note:(kind,detail)=>events.push({kind,...detail})};
    // Getter acknowledges but actual media never accelerates. A temporary
    // 55ms read jump matches the 51-103ms contaminated samples in the trace.
    let commands=0; p.setPlaybackRate=r=>{p.calls.push(['rate',r]); if(r!==1)commands++;p.rate=r;};
    ctx.tick=at=>{p.position=29.925+at/1000;};
    p.getCurrentTime=()=>p.position+(p.rate!==1?.055:0);
    vm.runInContext(read('public/client/zero-converge.js'),ctx);
    ctx.advance(55000);assert.equal(commands,3);assert.equal(p.rate,1);
    assert.equal(ctx.WatchFusionZeroConverge.diagnostics().hostRateRecheck.measuredImprovement,false);
    ctx.advance(130000);assert.equal(commands,6);assert.equal(p.rate,1);
    assert.equal(events.filter(e=>e.kind==='zero-actuator-measurement-rearmed').length,1);
    assert.equal(ctx.WatchFusionZeroConverge.diagnostics().capabilities[0].rearms,1);
    assert.equal(ctx.WatchFusionZeroConverge.diagnostics().hostRateRecheck.measuredImprovement,false);
  });
  await check('WF06B-02:clean later evidence after one initial timestamp jump can qualify a real actuator',()=>{
    const ctx=world(),p=fakePlayer(ctx,{position:29.8});
    roomGlobals(ctx,p,{targetOffsetSec:0,host:true,uncertaintyMs:12});
    ctx.watchFusionPlayout.status=()=>({source:'live',reference:'linked-tab',uncertaintyMs:12});
    ctx.WatchFusionHostSeekPolicy={sourceBlocker:()=>null};
    ctx.watchFusionViewerArbiter.snapshot=()=>({timelineErrorMs:(30+ctx.clock()/1000-p.position)*1000,timelineObservedAtMs:ctx.clock()});
    // Report an initial cached-time refresh only while rate is applied.
    p.getCurrentTime=()=>p.position+(p.rate!==1?.055:0);
    vm.runInContext(read('public/client/zero-converge.js'),ctx);
    ctx.advance(2500);
    assert.equal(ctx.WatchFusionZeroConverge.diagnostics().active,true);
    ctx.advance(9000);
    assert.equal(ctx.WatchFusionZeroConverge.diagnostics().hostRateRecheck.measuredImprovement,true);
    assert.ok(Math.abs(30+ctx.clock()/1000-p.position)<.08);
    assert.equal(p.rate,1);
  });
  await check('WF06B-03:an acknowledged no-effect actuator never earns contamination rearm',()=>{
    const ctx=world(),p=fakePlayer(ctx,{position:29.925});
    roomGlobals(ctx,p,{targetOffsetSec:0,host:true,uncertaintyMs:12});
    ctx.watchFusionPlayout.status=()=>({source:'live',reference:'linked-tab',uncertaintyMs:12});
    ctx.WatchFusionHostSeekPolicy={sourceBlocker:()=>null};
    ctx.watchFusionViewerArbiter.snapshot=()=>({timelineErrorMs:75,timelineObservedAtMs:ctx.clock()});
    ctx.tick=at=>{p.position=29.925+at/1000;};
    vm.runInContext(read('public/client/zero-converge.js'),ctx);ctx.advance(200000);
    assert.equal(p.calls.filter(([kind,r])=>kind==='rate'&&r!==1).length,3);
    assert.equal(ctx.WatchFusionZeroConverge.diagnostics().hostRateRecheck.measuredImprovement,false);
    assert.equal(p.rate,1);
  });
  await check('V13107-00B:a-delayed-host-rate-response-qualifies-only-with-measured-progress',()=>{
    for(const delay of [100,1000]){
      const ctx=world(), p=fakePlayer(ctx,{position:29.941});
      roomGlobals(ctx,p,{targetOffsetSec:0,host:true,uncertaintyMs:12});
      ctx.watchFusionPlayout.status=()=>({source:'live',reference:'linked-tab',uncertaintyMs:12});
      ctx.WatchFusionHostSeekPolicy={sourceBlocker:()=>null};
      ctx.watchFusionViewerArbiter.snapshot=()=>({model:{rateHonored:false},locked:Math.abs(p.position-30-ctx.clock()/1000)<=.05,lockedForMs:2000,
        timelineErrorMs:Math.round((30+ctx.clock()/1000-p.position)*1000),timelineObservedAtMs:ctx.clock()});
      let timer;
      p.setPlaybackRate=rate=>{
        p.calls.push(['rate',rate]);
        ctx.clearTimeout(timer);
        if(rate===1)p.rate=1;
        else timer=ctx.setTimeout(()=>{p.rate=rate;},delay);
      };
      vm.runInContext(read('public/client/zero-converge.js'),ctx);
      ctx.advance(24000);
      const proven=ctx.WatchFusionZeroConverge.diagnostics().hostRateRecheck.measuredImprovement;
      const residual=Math.abs(54-p.position)*1000;
      assert.equal(proven,delay===100);
      assert.ok(delay===100?residual<=16:Math.abs(residual-59)<1,residual);
      assert.equal(p.rate,1);
      assert.ok(p.calls.every(([kind])=>kind==='rate'));
    }
  });
  await check('V13107-00:linked-host-rechecks-rejected-speed-to-close-a-steady-440ms-lag',()=>{
    for(const sourceTrusted of [true,false]){
      const ctx=world(), p=fakePlayer(ctx,{position:29.56});
      roomGlobals(ctx,p,{targetOffsetSec:0,host:true,uncertaintyMs:15});
      ctx.watchFusionPlayout.status=()=>({source:'live',reference:'linked-tab',uncertaintyMs:15});
      ctx.WatchFusionHostSeekPolicy={sourceBlocker:()=>sourceTrusted?null:'host-source-stale'};
      ctx.watchFusionViewerArbiter.snapshot=()=>({model:{rateHonored:false},locked:Math.abs(p.position-30-ctx.clock()/1000)<=.05,lockedForMs:2000,
        timelineErrorMs:Math.round((30+ctx.clock()/1000-p.position)*1000),timelineObservedAtMs:ctx.clock()});
      vm.runInContext(read('public/client/zero-converge.js'),ctx);
      ctx.advance(27000);
      const error=Math.abs(57-p.position)*1000;
      assert.ok(sourceTrusted?error<=20:error>=430,error);
      assert.ok(p.calls.every(([kind])=>kind==='rate'));
      if(sourceTrusted) assert.equal(ctx.WatchFusionZeroConverge.diagnostics().hostRateRecheck.measuredImprovement,true);
      else assert.equal(p.calls.length,0);
    }
  });
  await check('V13107-00C:a-new-track-releases-the-old-player-rate-and-earns-its-own-probe',()=>{
    const ctx=world();
    let player=fakePlayer(ctx,{position:29.941});
    roomGlobals(ctx,player,{targetOffsetSec:0,host:true,uncertaintyMs:12});
    ctx.watchFusionPlayout.status=()=>({source:'live',reference:'linked-tab',uncertaintyMs:12});
    ctx.WatchFusionHostSeekPolicy={sourceBlocker:()=>null};
    ctx.watchFusionViewerArbiter.snapshot=()=>({model:{rateHonored:false},
      locked:Math.abs(player.position-30-ctx.clock()/1000)<=.05,lockedForMs:2000,
      timelineErrorMs:Math.round((30+ctx.clock()/1000-player.position)*1000),timelineObservedAtMs:ctx.clock()});
    vm.runInContext(read('public/client/zero-converge.js'),ctx);
    ctx.advance(2275);
    const previous=player;
    assert.equal(previous.rate,1.25);
    player=fakePlayer(ctx,{position:30+ctx.clock()/1000-.059});
    player.videoId='BBBBBBBBBBB';
    player.last=ctx.clock();
    ctx.ytPlayer=player;
    ctx.state.source.videoId=player.videoId;
    ctx.state.presentationEpoch++;
    ctx.state.playoutSegment++;
    ctx.advance(25000);
    assert.deepEqual(previous.calls,[['rate',1.25],['rate',1]]);
    assert.equal(player.calls[0][1],1.25);
    assert.equal(player.rate,1);
    assert.ok(Math.abs(30+ctx.clock()/1000-player.position)<=.016);
    assert.equal(ctx.WatchFusionZeroConverge.diagnostics().hostRateRecheck.measuredImprovement,true);
  });

  await check('V13107-01:locked-50ms-walks-toward-zero-despite-a-100ms-shared-reference', () => {
    const ctx = world(); const p = fakePlayer(ctx, {position: 30.05}); // 50 ms ahead
    roomGlobals(ctx, p, {targetOffsetSec: 0, uncertaintyMs: 110});
    vm.runInContext(read('public/client/zero-converge.js'), ctx);
    ctx.advance(30000);
    const err = Math.abs((30 + 30 - p.position) * 1000);
    assert.ok(err <= 16, 'Locked edge must walk into the 0..16 ms band, residual ' + err.toFixed(1) + ' ms');
    assert.ok(!p.calls.some(([k]) => k === 'seek' || k === 'pause'), 'zero convergence never seeks or pauses');
    assert.equal(p.rate, 1, 'rate always returns to 1x');
  });
  await check('V13107-02:fixed-rate-tv-and-noisy-measurement-are-left-alone', () => {
    for (const variant of ['fixed', 'noisy']) {
      const ctx = world(); const p = fakePlayer(ctx, {position: 30.04, rates: variant === 'fixed' ? [1] : [.75, 1, 1.25]});
      roomGlobals(ctx, p, {targetOffsetSec: 0});
      if (variant === 'noisy') { let k = 0; ctx.watchFusionYouTubeTarget = () => 30 + ctx.clock() / 1000 + ((k++ % 2) ? .03 : -.03); }
      vm.runInContext(read('public/client/zero-converge.js'), ctx);
      ctx.advance(20000);
      assert.ok(!p.calls.some(([k, r]) => k === 'rate' && r !== 1), variant + ': no actuation');
    }
  });
  await check('V13107-03:zero-convergence-yields-to-the-arbiter', () => {
    const ctx = world(); const p = fakePlayer(ctx, {position: 30.04});
    roomGlobals(ctx, p, {targetOffsetSec: 0, owns: () => true});
    vm.runInContext(read('public/client/zero-converge.js'), ctx);
    ctx.advance(15000);
    assert.equal(p.calls.length, 0, 'never two rate owners at once');
  });
  await check('V13107-04:solo-linked-tab-converges-without-commanding-the-source', () => {
    const ctx = world(); const p = fakePlayer(ctx, {position: 29.7}); // 300 ms behind the linked tab
    const sent = []; let sampledAt = 0;
    ctx.state = {source: {videoId: 'AAAAAAAAAAA'}}; Object.assign(ctx, {roomId: null, ytPlayer: p, ytPlayerReady: true, playerInitializing: false, primingPlayer: false, pendingVideoId: 'AAAAAAAAAAA'});
    ctx.parseYoutubeInput = () => 'AAAAAAAAAAA';
    ctx.WatchFusionLinkedPlaybackSync = {projectedPosition: (m, at) => m.currentTime + (at - m.sampledAt) / 1000};
    ctx.watchFusionLinkedTab = {active: () => true, applying: () => false, pendingControl: () => false, suppressPlaybackEcho() {},
      control: (...a) => sent.push(a), metadata: () => { if (ctx.Date.now() - sampledAt > 250) sampledAt = ctx.Date.now();
        return {pageUrl: 'https://www.youtube.com/watch?v=AAAAAAAAAAA', paused: false, rate: 1, sampledAt, currentTime: 30 + (sampledAt - 1.7e12) / 1000}; }};
    vm.runInContext(read('public/client/solo-link-sync.js'), ctx);
    ctx.advance(30000);
    const err = Math.abs((30 + 30 - p.position) * 1000);
    assert.ok(err <= 20, 'solo preview must settle within 20 ms of the linked tab, got ' + err.toFixed(1));
    assert.equal(sent.length, 0, 'solo corrections never send transport to the source tab');
    assert.ok(!p.calls.some(([k]) => k === 'seek'), '300 ms is corrected by rate, not a seek');
    assert.match(ctx.nodes.get('watchfusionSoloLinkStatus')?.textContent || '', /Locked/);
  });
  await check('V13107-05:solo-embedded-pause-and-seek-reach-the-linked-tab', () => {
    const src = read('public/client/commands.js');
    assert.match(src, /linked\?\.active\?\.\(\) && \(!roomId \|\| isHost\(\)\)/, 'embedded Play/Pause routes to the source with no room');
    assert.match(src, /forwardSeek&&jumped&&\(!roomId\|\|isHost\(\)\)/, 'embedded seek routes to the source with no room');
    assert.match(src, /rateChanged=!window\.watchFusionHostZeroCenter\?\.isApplying\?\.\(\) && !window\.WatchFusionZeroConverge\?\.isApplying\?\.\(\) && !window\.WatchFusionSoloLinkSync/, 'source rate follow never stomps a correction pulse');
  });
  await check('V13107-06:wedged-tv-buffering-gets-one-reload-then-one-rebuild-and-ignores-a-frozen-blink', () => {
    const ctx = world(); const notes = [];
    ctx.watchFusionRoomSyncLog = {note: k => notes.push(k)}; ctx.ensurePlayer = () => notes.push('ensure');
    vm.runInContext(read('public/client/tv-decoder-rescue.js'), ctx);
    const R = ctx.WatchFusionDecoderRescue; let reloads = 0, rebuilds = 0;
    for (let t = 0; t <= 120000; t += 500) {
      const blink = t % 20000 === 10000; // the linked source reads "frozen" for one report every 20 s
      R.consider({scope: 's', nowMs: t, buffering: true, exhausted: false, playing: false, trusted: !blink, sourceBuffering: false,
        drift: -(5 + t / 1000), reload: () => reloads++, rebuild: () => rebuilds++});
    }
    assert.equal(reloads, 1, 'exactly one decoder reload'); assert.equal(rebuilds, 1, 'exactly one player rebuild');
    assert.equal(R.diagnostics().outcome, 'terminal-recovery-spent');
    let frozen = 0; R.consider({scope: 'x', nowMs: 0, buffering: true, trusted: false, drift: -9, reload: () => frozen++});
    for (let t = 0; t <= 60000; t += 500) R.consider({scope: 'x', nowMs: t, buffering: true, trusted: false, drift: -9, reload: () => frozen++});
    assert.equal(frozen, 0, 'never while the room reference itself is not live');
  });
  await check('V13107-07:joining-member-tries-host-room-volume-then-falls-back-to-a-tap-button', () => {
    for (const allowed of [true, false]) {
      const ctx = world(); const p = fakePlayer(ctx, {muted: true});
      if (!allowed) p.unMute = () => { p.muted = false; p.state = 2; }; // browser pauses unmuted media without a gesture
      roomGlobals(ctx, p, {targetOffsetSec: 0});
      Object.assign(ctx, {autoplayWasBlocked: true, userGesturePrimeUsed: false, authoritativeRoomAudio: () => ({volume: 72, muted: false}),
        applyRoomAudioState: () => true});
      vm.runInContext('var autoplayWasBlocked=true,userGesturePrimeUsed=false;', ctx);
      vm.runInContext(read('public/client/room-audio-unlock.js'), ctx);
      assert.ok(ctx.windowListeners.get('pointerdown')?.length && ctx.windowListeners.get('keydown')?.length,
        'audio fallback installs real gesture listeners instead of inventing success');
      ctx.advance(6000);
      if (allowed) { assert.equal(p.muted, false); assert.equal(p.volume, 72); assert.equal(ctx.autoplayWasBlocked, false); }
      else { assert.equal(p.muted, true, 'falls back to muted playback'); assert.equal(p.state, 1, 'keeps playing');
        assert.equal(ctx.nodes.get('watchfusionEnableRoomAudio')?.hidden, false, 'shows Enable room audio'); }
    }
  });
  await runSourceWorkerChecks(check, read);
  await check('V13107-09:new-modules-are-in-the-served-bundle-in-order', () => {
    const b = read('src/server/static-files.js');
    const order = ['client/linked-playback-sync.js', 'client/linked-tab.js', 'client/solo-link-sync.js', 'playback-sync.js', 'client/tv-decoder-rescue.js', 'client/zero-converge.js', 'client/room-audio-unlock.js']
      .map(n => b.indexOf("'" + n + "'"));
    assert.ok(order.every(i => i > 0) && order.every((v, i) => !i || v > order[i - 1]), 'bundle order ' + order.join(','));
  });
}
