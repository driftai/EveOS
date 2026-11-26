// v13.10.8g falsifiers: closed-loop host-source convergence. Fixture = Drift's 2026-11-17 07:20-07:23 UTC Trace v3
// (laptop only): attempt 1 triggered at 327 ms and resumed at ~407 ms; attempt 2 triggered at 434 ms, read 92 ms
// while the arbiter held a paused pre-seeked player, then resumed at 345 -> 463 -> 649 ms. Red on 9e19c199: the
// controller retried a move that made things worse, could count a held-player reading, ignored a mirror gate holding
// a ~1.3 s source disagreement, and nothing measured commanded vs landed vs released positions.
// Evidence type: Node VM with deterministic clocks only. Not Playwright, not Windows, not audible playback.
import assert from 'node:assert/strict';
import {world, fakePlayer, roomGlobals} from './v13107-falsifiers.js';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const ROOT = process.env.WF_FALSIFIER_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = rel => fs.existsSync(path.join(ROOT, rel));
function host() {
  let now = 0; const notes = [];
  const ctx = {window: {watchFusionRoomSyncLog: {note: (kind, detail) => notes.push({kind, ...detail})}}, performance: {now: () => now}, console, Math, Number};
  vm.runInNewContext(read('public/client/host-source-converge.js'), ctx);
  return {H: ctx.window.WatchFusionHostSourceConverge, notes, kinds: () => notes.map(n => n.kind)};
}
const make = (o = {}) => ({scope: 'room:video:epoch', segment: 4, nowMs: 0, errorMs: 340,
  coordination: {source: 'live', sourcePhaseMs: 19, reference: 'linked-tab', uncertaintyMs: 10}, sourceAgeMs: 300,
  publisher: true, sameVideo: true, peerPresent: false, active: true, ...o});
function drive(H, o, start, end, step = 250) {
  for (let t = start; t <= end; t += step) if (H.consider(make({...o, nowMs: t}))) return t;
  return null;
}
// After accept: the arbiter owns the player for `ownedMs` (inactive), then the resumed player reads `resumed(t)`.
function verify(H, at, ownedMs, resumed, endMs, heldReading = null) {
  for (let t = at + 250; t <= at + endMs; t += 250) {
    const owned = t - at < ownedMs;
    if (H.consider(make({nowMs: t, active: !owned, errorMs: owned ? (heldReading ?? 0) : resumed(t - at - ownedMs)}))) return t;
  }
  return null;
}
export async function runV13108gChecks(check) {
  const microEpisode=(mode='clean')=>{
    const ctx=world(),p=fakePlayer(ctx,{position:29.982});roomGlobals(ctx,p,{targetOffsetSec:0,host:true,uncertaintyMs:11});
    const events=[];let started=0, witness=null;
    ctx.watchFusionPlayout.status=()=>({source:'live',reference:'linked-tab',uncertaintyMs:mode==='uncertain'?20:11});
    ctx.watchPartyClock={precise:()=>mode!=='thin',rttMs:()=>mode==='thin'?58:5};
    ctx.WatchFusionHostSeekPolicy={sourceBlocker:()=>mode==='disagree'?'host-source-disagrees':null};
    ctx.watchFusionViewerArbiter.snapshot=()=>p.rate!==1&&witness?witness:({timelineErrorMs:(ctx.watchFusionYouTubeTarget()-p.position)*1000,timelineObservedAtMs:ctx.clock()-(mode==='stale'?500:0)});
    ctx.watchFusionRoomSyncLog={note:(kind,detail)=>events.push({kind,...detail})};
    p.setPlaybackRate=r=>{p.calls.push(['rate',r]);if(r!==1){started++;witness=ctx.watchFusionViewerArbiter.snapshot();}p.rate=r;};
    if(mode==='ignored'||mode==='jump')ctx.tick=at=>{p.position=29.982+at/1000;};
    if(mode==='jump')p.getCurrentTime=()=>p.position+(p.rate!==1?.034:0);
    if(mode==='already-close')p.position=29.993;
    vm.runInContext(read('public/client/zero-converge.js'),ctx);
    return {ctx,p,events,starts:()=>started,error:()=>Math.abs(ctx.watchFusionYouTubeTarget()-p.position)*1000};
  };
  await check('WF06JF-01:qualified 18ms host residual reaches 10ms without a seek and holds',()=>{
    const L=microEpisode();L.ctx.advance(8000);assert.ok(L.error()<=10,`residual ${L.error()}`);
    assert.equal(L.starts(),1);assert.equal(L.p.rate,1);
    assert.ok(L.events.some(e=>e.kind==='zero-actuator-verified'&&e.reason==='verified'));
    for(let i=0;i<20;i++){L.ctx.advance(1000);assert.ok(L.error()<=10);}
    assert.ok(L.p.calls.every(([k])=>k==='rate'));
  });
  await check('WF06JF-02:small trim excludes thin stale disputed uncertain and already close clocks',()=>{
    for(const mode of ['thin','stale','disagree','uncertain','already-close']){
      const L=microEpisode(mode);L.ctx.advance(30000);assert.equal(L.starts(),0,mode);assert.equal(L.p.rate,1);
    }
  });
  await check('WF06JF-03:short acknowledged ignored or jumped samples cannot certify motion or repeat',()=>{
    for(const mode of ['ignored','jump']){
      const L=microEpisode(mode);L.ctx.advance(100000);assert.equal(L.starts(),1,mode);assert.equal(L.p.rate,1);
      assert.ok(!L.events.some(e=>e.kind==='zero-actuator-verified'&&e.reason==='verified'),mode);
      assert.ok(L.error()>=17&&L.error()<=19,mode);
    }
  });
  await check('WF06JF-04:micro trim releases on reference loss and cannot certify a displaced settled target',()=>{
    for(const mode of ['veto','shift']){
      const L=microEpisode();L.ctx.advance(2250);assert.equal(L.p.rate,1.25);
      if(mode==='veto')L.ctx.WatchFusionHostSeekPolicy.sourceBlocker=()=> 'host-source-disagrees';
      else L.ctx.setTimeout(()=>{L.ctx.watchFusionYouTubeTarget=()=>30+L.ctx.clock()/1000+.008;},75);
      L.ctx.advance(10000);assert.equal(L.p.rate,1);assert.equal(L.starts(),1);
      assert.ok(!L.events.some(e=>e.kind==='zero-actuator-verified'&&e.reason==='verified'),mode);
    }
  });
  await check('WF06JG-01:verified micro trim rearms only after quiet fine lock and corrects a new same-direction drift',()=>{
    const L=microEpisode();L.ctx.advance(24000);assert.equal(L.starts(),1);assert.ok(L.error()<=10);
    L.p.position=L.ctx.watchFusionYouTubeTarget()-.018;L.ctx.advance(8000);
    assert.ok(L.error()<=10,`retained residual ${L.error()}`);assert.equal(L.starts(),2);assert.equal(L.p.rate,1);
    assert.equal(L.events.filter(e=>e.reason==='qualified-fine-lock-retention').length,1);
    assert.ok(L.p.calls.every(([k])=>k==='rate'));
  });
  await check('WF06JG-02:no micro rearm on hidden interval or unverified fine lock',()=>{
    for(const mode of ['hidden','untrusted']){
      const L=microEpisode();L.ctx.advance(8000);assert.equal(L.starts(),1);assert.ok(L.error()<=10);
      if(mode==='hidden')L.ctx.document.hidden=true;
      else L.ctx.watchFusionViewerArbiter.snapshot=()=>({timelineErrorMs:100,timelineObservedAtMs:L.ctx.clock()});
      L.ctx.advance(25000);L.ctx.document.hidden=false;
      L.ctx.watchFusionViewerArbiter.snapshot=()=>({timelineErrorMs:(L.ctx.watchFusionYouTubeTarget()-L.p.position)*1000,timelineObservedAtMs:L.ctx.clock()});
      L.p.position=L.ctx.watchFusionYouTubeTarget()-.018;L.ctx.advance(8000);assert.equal(L.starts(),1,mode);
      assert.equal(L.p.rate,1);assert.ok(!L.events.some(e=>e.reason==='qualified-fine-lock-retention'));
    }
  });
  const retentionEpisode=(mode='clean')=>{
    const ctx=world(),p=fakePlayer(ctx,{position:29.921});roomGlobals(ctx,p,{targetOffsetSec:0,uncertaintyMs:30});
    const events=[];let starts=0;
    ctx.watchFusionPlayout.status=()=>({source:'live',reference:'linked-tab',sourcePhaseMs:0,uncertaintyMs:30,anchorPositionMs:30000,anchorAt:1.7e12,rate:1,phaseMs:0});
    ctx.watchFusionPlayout.hasSourceReference=()=>mode!=='unqualified';
    ctx.watchFusionViewerArbiter.snapshot=()=>({timelineErrorMs:(ctx.watchFusionYouTubeTarget()-p.position)*1000,timelineObservedAtMs:ctx.clock()});
    ctx.watchFusionRoomSyncLog={note:(kind,detail)=>events.push({kind,...detail})};
    p.setPlaybackRate=r=>{p.calls.push(['rate',r]);if(r!==1)starts++;else if(p.rate!==1&&starts<=3){p.position=ctx.watchFusionYouTubeTarget()-.079;}p.rate=r;};
    if(mode==='ignored')ctx.tick=at=>{p.position=29.921+at/1000;};
    if(mode==='timer-overrun'){const set=ctx.setTimeout;ctx.setTimeout=(fn,ms)=>set(fn,ms===50?1000:ms);}
    vm.runInContext(read('public/client/zero-converge.js'),ctx);
    return {ctx,p,events,starts:()=>starts,error:()=>Math.abs(ctx.watchFusionYouTubeTarget()-p.position)*1000};
  };
  await check('WF06JG-03:qualified TV 79ms plateau gets a bounded fresh trial after neutral measured motion',()=>{
    const L=retentionEpisode();L.ctx.advance(115000);
    assert.ok(L.starts()>=4&&L.starts()<=6,`starts ${L.starts()}`);assert.ok(L.error()<=50,`residual ${L.error()}`);
    assert.ok(L.events.some(e=>e.kind==='zero-actuator-measurement-rearmed'&&e.reason==='fresh-stable-evidence'));
    assert.ok(L.events.some(e=>e.kind==='zero-actuator-verified'&&e.reason==='verified'));assert.equal(L.p.rate,1);
    assert.ok(L.p.calls.every(([k])=>k==='rate'));
  });
  await check('WF06JG-04:ignored or unqualified TV plateau cannot earn extra neutral-motion budget',()=>{
    for(const mode of ['ignored','unqualified']){
      const L=retentionEpisode(mode);L.ctx.advance(140000);assert.ok(L.starts()<=3,mode);assert.equal(L.p.rate,1);
      assert.ok(!L.events.some(e=>e.kind==='zero-actuator-measurement-rearmed'),mode);
      assert.ok(!L.events.some(e=>e.kind==='zero-actuator-verified'&&e.reason==='verified'),mode);
    }
  });
  await check('WF06JG-05:qualified viewer retention releases immediately on fresh-source loss',()=>{
    const L=retentionEpisode();L.ctx.advance(2250);assert.equal(L.p.rate,1.25);
    L.ctx.watchFusionPlayout.hasSourceReference=()=>false;L.ctx.advance(50);
    assert.equal(L.p.rate,1);assert.ok(L.events.some(e=>e.reason==='viewer-retention-reference-lost'));
    assert.ok(!L.events.some(e=>e.kind==='zero-actuator-verified'&&e.reason==='verified'));
  });
  await check('WF06JG-06:late timer restores normal rate without certifying the overrun',()=>{
    const L=retentionEpisode('timer-overrun');L.ctx.advance(3300);assert.equal(L.p.rate,1);
    assert.ok(L.events.some(e=>e.reason==='rate-timer-overrun'));assert.ok(!L.events.some(e=>e.kind==='zero-actuator-verified'));
  });
  // A TV that actually changes speed can lose reference confidence before the
  // settled window. Repeated temporary vetoes must not strand a real residual.
  const viewerEpisode=(mode='clean')=>{
    const ctx=world(),p=fakePlayer(ctx,{position:29.91});roomGlobals(ctx,p,{targetOffsetSec:0,uncertaintyMs:12});
    let starts=0,startedAt=-Infinity,shift=0,timer;const events=[];
    const veto=()=>ctx.clock()-startedAt>=225&&ctx.clock()-startedAt<925;
    ctx.watchFusionPlayout.status=()=>({source:'live',reference:'linked-tab',sourcePhaseMs:54,uncertaintyMs:12,mirrorContradicted:veto(),anchorPositionMs:29946,anchorAt:1.7e12,rate:1,phaseMs:54});
    ctx.watchFusionPlayout.hasSourceReference=()=>mode!=='unqualified'&&!(mode==='stale'&&starts>0);
    ctx.watchFusionYouTubeTarget=()=>30+ctx.clock()/1000+shift;
    ctx.watchFusionViewerArbiter.snapshot=()=>({timelineErrorMs:(ctx.watchFusionYouTubeTarget()-p.position)*1000,timelineObservedAtMs:ctx.clock()});
    ctx.watchFusionRoomSyncLog={note:(kind,detail)=>events.push({kind,...detail})};
    p.setPlaybackRate=r=>{p.calls.push(['rate',r]);ctx.clearTimeout(timer);if(r===1)p.rate=1;else {starts++;startedAt=ctx.clock();timer=ctx.setTimeout(()=>{p.rate=r;},175);}};
    if(mode==='ignored')ctx.tick=at=>{p.position=29.91+at/1000;};
    vm.runInContext(read('public/client/zero-converge.js'),ctx);
    return {ctx,p,events,starts:()=>starts,shift:()=>{shift=.12;},error:()=>Math.abs(ctx.watchFusionYouTubeTarget()-p.position)*1000};
  };
  await check('WF06JD-01:viewer measured rate progress survives short reference vetoes and retains fine alignment',()=>{
    const L=viewerEpisode();L.ctx.advance(42000);
    assert.ok(L.error()<=16,`settled residual ${L.error().toFixed(1)}ms`);
    assert.ok(L.starts()>3&&L.starts()<=9);assert.equal(L.p.rate,1);
    assert.ok(L.events.filter(e=>e.kind==='zero-actuator-verified'&&e.reason==='verified').length>=3);
    assert.ok(L.p.calls.every(([k])=>k==='rate'));
    L.p.position-=.07;L.ctx.advance(42000);assert.ok(L.error()<=16);assert.equal(L.p.rate,1);
    for(let i=0;i<20;i++){L.ctx.advance(1000);assert.ok(L.error()<=16);}
  });
  await check('WF06JD-02:unqualified or ignored viewer commands cannot earn extra retry budget',()=>{
    for(const mode of ['unqualified','ignored','stale']){
      const L=viewerEpisode(mode);L.ctx.advance(100000);
      assert.ok(L.starts()<=3,mode);assert.equal(L.p.rate,1);
      assert.ok(!L.events.some(e=>e.kind==='zero-actuator-verified'&&e.reason==='verified'),mode);
      assert.ok(L.p.calls.every(([k])=>k==='rate'));
    }
  });
  await check('WF06JD-03:interrupted viewer correction cannot learn across a discontinuous target',()=>{
    const L=viewerEpisode();for(let i=0;i<50&&!L.events.some(e=>e.kind==='zero-actuator-finished'&&e.reason==='mirror-contradicted');i++)L.ctx.advance(100);
    assert.ok(L.events.some(e=>e.kind==='zero-actuator-finished'&&e.reason==='mirror-contradicted'));L.shift();L.ctx.advance(6000);
    assert.ok(!L.events.some(e=>e.kind==='zero-actuator-verified'&&e.reason==='verified'));
    assert.equal(L.p.rate,1);assert.ok(L.p.calls.every(([k])=>k==='rate'));
  });
  await check('WF06I-01:three measured pulses interrupted by temporary source trust loss finish convergence',()=>{
    const ctx=world(),p=fakePlayer(ctx,{position:29.508});roomGlobals(ctx,p,{targetOffsetSec:0,host:true,uncertaintyMs:10});
    let starts=0,startedAt=-Infinity;const events=[];
    ctx.watchFusionPlayout.status=()=>({source:'live',reference:'linked-tab',uncertaintyMs:10});
    ctx.WatchFusionHostSeekPolicy={sourceBlocker:()=>starts<=3&&ctx.clock()-startedAt>=550&&ctx.clock()-startedAt<1450?'host-source-unverified':null};
    ctx.watchFusionViewerArbiter.snapshot=()=>({timelineErrorMs:(30+ctx.clock()/1000-p.position)*1000,timelineObservedAtMs:ctx.clock()});
    ctx.watchFusionRoomSyncLog={note:(kind,detail)=>events.push({kind,...detail})};
    p.setPlaybackRate=r=>{p.calls.push(['rate',r]);if(r!==1){starts++;startedAt=ctx.clock();}p.rate=r;};
    vm.runInContext(read('public/client/zero-converge.js'),ctx);ctx.advance(45000);
    assert.ok(Math.abs(75-p.position)*1000<=25,`residual ${Math.round((75-p.position)*1000)}ms`);
    assert.ok(events.filter(e=>e.kind==='zero-actuator-finished'&&e.reason==='reference-changed').length>=3);
    assert.ok(events.filter(e=>e.kind==='zero-actuator-verified'&&e.reason==='verified').length>=3);
    assert.equal(p.rate,1);assert.ok(starts<=8&&p.calls.every(([k])=>k==='rate'));
    // New drift on the same video, after established lock.
    p.position-=.22;ctx.advance(30000);
    assert.ok(Math.abs(105-p.position)*1000<=25);assert.equal(p.rate,1);assert.ok(starts<=12);
  });
  await check('WF06I-02:interrupted pulse cannot learn from a displaced reference or player',()=>{
    for(const mode of ['shifted-target','new-player','new-segment']){
      const ctx=world(),p=fakePlayer(ctx,{position:29.508});roomGlobals(ctx,p,{targetOffsetSec:0,host:true,uncertaintyMs:10});
      let start=-Infinity,veto=false,shift=0;const events=[];
      ctx.watchFusionPlayout.status=()=>({source:'live',reference:'linked-tab',uncertaintyMs:10});
      ctx.WatchFusionHostSeekPolicy={sourceBlocker:()=>veto?'host-source-unverified':null};
      ctx.watchFusionYouTubeTarget=()=>30+ctx.clock()/1000+shift;
      ctx.watchFusionViewerArbiter.snapshot=()=>({timelineErrorMs:(ctx.watchFusionYouTubeTarget()-p.position)*1000,timelineObservedAtMs:ctx.clock()});
      ctx.watchFusionRoomSyncLog={note:(kind,detail)=>events.push({kind,...detail})};
      p.setPlaybackRate=r=>{if(r!==1)start=ctx.clock();p.rate=r;};
      vm.runInContext(read('public/client/zero-converge.js'),ctx);
      for(let i=0;i<60&&start===-Infinity;i++)ctx.advance(100);
      assert.ok(Number.isFinite(start));ctx.advance(550);veto=true;ctx.advance(100);
      if(mode==='shifted-target')shift=.2;else if(mode==='new-player')ctx.ytPlayer={...p};else ctx.state.playoutSegment++;
      ctx.advance(1200);veto=false;ctx.advance(3600);
      assert.ok(!events.some(e=>e.kind==='zero-actuator-verified'&&e.reason==='verified'),mode);
      assert.equal(ctx.WatchFusionZeroConverge.diagnostics().hostRateRecheck.measuredImprovement,false,mode);
    }
  });
  await check('V13108G-01:trace-attempt-1-worse-landing-stops-the-actuator-instead-of-retrying', () => {
    const {H, notes, kinds} = host();
    const t1 = drive(H, {errorMs: 327}, 2000, 12000);
    assert.ok(t1 !== null, 'fixture must trigger attempt 1 at 327 ms');
    H.accept(true, t1);
    verify(H, t1, 2500, ms => 407 + ((ms / 250) % 2 ? 4 : -4), 9000);
    const d = H.diagnostics();
    assert.equal(d.outcome, 'solo-source-no-progress');
    assert.equal(d.beforeMs, 327); assert.ok(d.residualMs >= 400 && d.residualMs <= 412); assert.ok(d.progressMs < 0);
    const backoff = notes.find(n => n.kind === 'host-source-backoff');
    assert.ok(backoff && backoff.beforeMs === 327 && backoff.progressMs < 0, 'the stop is recorded with its evidence');
    assert.equal(drive(H, {errorMs: 407}, t1 + 9500, t1 + 60000), null, 'no second rejoin after a worsening landing');
    assert.equal(H.diagnostics().attempts, 1);
    assert.ok(!kinds().includes('host-source-settled'));
  });
  await check('V13108G-02:a-held-player-reading-and-a-brief-dip-never-count-as-landing', () => {
    const {H} = host();
    const t2 = drive(H, {errorMs: 434}, 2000, 12000);
    H.accept(true, t2);
    // 92 ms while the arbiter holds the paused, pre-seeked player (inactive), then 345 -> 463 -> 649 ms.
    verify(H, t2, 1500, ms => ms < 2500 ? 345 : ms < 4500 ? 463 : 520, 9000, 92);
    let d = H.diagnostics();
    assert.notEqual(d.stage, 'settled'); assert.equal(d.outcome, 'solo-source-no-progress');
    assert.ok(d.residualMs > 434, 'the residual is the resumed window, not the 92 ms held reading');
    // 200 ms of real improvement that rebounds by >200 ms is not progress either.
    const b = host(), t = drive(b.H, {errorMs: 500}, 2000, 12000);
    b.H.accept(true, t);
    verify(b.H, t, 1000, ms => ms < 2000 ? 300 : 520, 9000);
    d = b.H.diagnostics();
    assert.equal(d.outcome, 'solo-source-no-progress'); assert.notEqual(d.stage, 'settled');
    assert.equal(drive(b.H, {errorMs: 520}, t + 9500, t + 60000), null, 'never amplified into another attempt');
  });
  await check('V13108G-03:measured-progress-keeps-the-bounded-retry-and-settles', () => {
    const {H, notes} = host();
    const t1 = drive(H, {errorMs: 600}, 2000, 12000);
    H.accept(true, t1);
    verify(H, t1, 2000, () => 250, 9000);
    assert.equal(H.diagnostics().outcome, 'solo-source-landing-incomplete');
    const inc = notes.find(n => n.kind === 'host-source-landing-incomplete');
    assert.ok(inc && inc.beforeMs === 600 && inc.residualMs === 250 && inc.progressMs === 350, 'before/residual/progress recorded');
    const t2 = drive(H, {errorMs: 250}, t1 + 9250, t1 + 40000);
    assert.ok(t2 !== null && t2 - t1 >= 12000, 'a second bounded attempt after the retry wait');
    H.accept(true, t2);
    verify(H, t2, 2000, () => 40, 6000);
    assert.equal(H.diagnostics().stage, 'settled');
    assert.equal(H.diagnostics().attempts, 2);
  });

  await check('V13108G-04:no-valid-resumed-window-is-never-judged-or-retried', () => {
    const {H, notes} = host();
    const t = drive(H, {errorMs: 400}, 2000, 12000);
    H.accept(true, t);
    verify(H, t, 17000, () => 400, 17000);
    assert.equal(H.diagnostics().outcome, 'solo-source-unverified');
    assert.ok(notes.some(n => n.kind === 'host-source-backoff' && n.reason === 'no-resumed-window'));
    assert.equal(drive(H, {errorMs: 400}, t + 17500, t + 60000), null);
  });

  await check('V13108G-05:mirror-contradiction-holds-host-source-until-coherent', () => {
    const {H, notes} = host();
    const contradiction = {driftMs: -1342, ageMs: 200};
    assert.equal(drive(H, {errorMs: 400, contradiction}, 0, 15000), null, 'sourcePhase +19 ms vs mirror -1.3 s: do not act');
    assert.equal(H.diagnostics().outcome, 'solo-source-contradicted');
    assert.equal(notes.filter(n => n.kind === 'host-source-contradicted').length, 1, 'reported once per episode');
    assert.equal(notes[0].mirrorDriftMs, -1342); assert.equal(notes[0].sourcePhaseMs, 19);
    const t = drive(H, {errorMs: 400}, 15250, 30000);
    assert.ok(t !== null && t - 15250 >= 3200, 'recovers on fresh dwell once the evidence is coherent');
  });

  await check('V13108G-06:mirror-gate-exposes-a-held-large-disagreement-and-its-sample-age', () => {
    let perf = 10000, wall = 1_700_000_000_000; const notes = [];
    const ctx = {window: {watchFusionRoomSyncLog: {note: (kind, d) => notes.push({kind, ...d})}}, performance: {now: () => perf}, Date: {now: () => wall}, Math, Number};
    vm.runInNewContext(read('public/client/mirror-convergence-gate.js'), ctx);
    const G = ctx.window.WatchFusionMirrorConvergenceGate;
    assert.equal(typeof G.contradicted, 'function', 'no contradiction signal');
    const plan = drift => ({publish: true, reason: 'drift', drift});
    assert.equal(G.defer(plan(-1.342), {sampledAt: wall - 120, currentTime: 3.7}, 'p'), true);
    assert.deepEqual({...G.contradicted()}, {driftMs: -1342, ageMs: 0});
    assert.equal(notes[0].sampleAgeMs, 120); assert.equal(notes[0].reason, 'isolated-sample');
    perf += 4100; wall += 4100;
    assert.equal(G.contradicted(), null, 'clears once no disagreement is seen for 4 s');
    let current = 10, published = false;
    for (let i = 0; i < 8 && !published; i++) { perf += 300; wall += 300; current += .3; published = G.defer(plan(-.9), {sampledAt: wall, currentTime: current}, 'p') === false; }
    assert.ok(published, 'a confirmed, progressing disagreement still re-anchors the room');
    assert.equal(G.contradicted(), null, 'a publish resolves it');
  });

  await check('V13108G-06B:fresh-advancing-source-samples-clear-an-isolated-mirror-outlier', () => {
    let now = 10000;
    const c = {sourcePhaseMs:-41};
    const ctx = {window:{watchFusionPlayout:{status:()=>c,hasSourceReference:()=>true}},
      Date:{now:()=>now},performance:{now:()=>now},estimatedServerNow:()=>now,Math,Number};
    vm.runInNewContext(read('public/client/mirror-convergence-gate.js'),ctx);
    const gate=ctx.window.WatchFusionMirrorConvergenceGate;
    assert.equal(gate.defer({publish:true,reason:'drift',drift:-1.18},{sampledAt:now,currentTime:30},'p'),true);
    assert.ok(gate.contradicted());
    const steady={publish:false,reason:'steady',drift:-.041};
    now+=200;
    gate.observeSteady(steady,{sampledAt:now,currentTime:31,rate:1},'p');
    assert.ok(gate.contradicted(),'a single sample cannot clear the veto');
    now+=200;
    gate.observeSteady(steady,{sampledAt:now,currentTime:31,rate:1},'p');
    assert.ok(gate.contradicted(),'a frozen sample cannot clear the veto');
    now+=200;
    gate.observeSteady(steady,{sampledAt:now,currentTime:31.2,rate:1},'p');
    assert.equal(gate.contradicted(),null);
  });

  await check('V13108G-06C:large-automatic-mirror-jumps-need-fresh-moving-source-confirmation', () => {
    let now = 10000, fresh = true;
    const c = {sourcePhaseMs:-150};
    const ctx = {window:{watchFusionPlayout:{status:()=>c,hasSourceReference:()=>fresh}},
      Date:{now:()=>now},performance:{now:()=>now},estimatedServerNow:()=>now,Math,Number};
    vm.runInNewContext(read('public/client/mirror-convergence-gate.js'),ctx);
    const gate=ctx.window.WatchFusionMirrorConvergenceGate;
    const plan={publish:true,reason:'drift',drift:-3.7};
    for(let i=0;i<=4;i++){
      now+=300;
      assert.equal(gate.defer(plan,{sampledAt:now,currentTime:100+i*.3},'p'),true);
    }
    assert.ok(gate.contradicted());
    fresh=false;
    now+=300;
    assert.equal(gate.defer(plan,{sampledAt:now,currentTime:101.5},'p'),false,
      'a confirmed moving jump can publish after the old reference expires');
    assert.equal(gate.defer({...plan,reason:'state'},{sampledAt:now,currentTime:101.5},'p'),false);
  });

  await check('V13108G-06D:two advancing source samples repair a stale mirror baseline without publishing', () => {
    let now = 10_000;
    const c = {segment:3, sourcePhaseMs:4, phaseMs:4, anchorAt:now, anchorPositionMs:30_000, rate:1};
    const notes = [];
    const ctx = {window:{watchFusionPlayout:{status:()=>c,hasSourceReference:()=>true},
      watchFusionRoomSyncLog:{note:(kind, detail)=>notes.push({kind, ...detail})}},
      Date:{now:()=>now},performance:{now:()=>now},estimatedServerNow:()=>now,Math,Number};
    vm.runInNewContext(read('public/client/mirror-convergence-gate.js'),ctx);
    const gate=ctx.window.WatchFusionMirrorConvergenceGate;
    const plan={publish:true,reason:'drift',drift:1.05};
    const sample=offset=>({pageUrl:'p',sampledAt:now,currentTime:30.004+(now-10_000)/1000+offset,rate:1});
    assert.equal(gate.defer(plan,sample(-1),'p'),true);
    assert.equal(typeof gate.rebase, 'function');
    now+=250;
    assert.equal(gate.rebase(plan,sample(-1),'p'),false,'advancing but off-source');
    assert.ok(gate.contradicted());
    assert.equal(gate.rebase(plan,sample(0),'p'),false,'one coherent reading');
    now+=250;
    c.segment++;
    assert.equal(gate.rebase(plan,sample(0),'p'),false,'evidence cannot cross a segment');
    now+=250;
    assert.equal(gate.rebase(plan,sample(0),'p'),true);
    assert.equal(gate.contradicted(),null);
    assert.equal(gate.diagnostics().published,0);
    assert.equal(notes.filter(e=>e.kind==='mirror-anchor-rebased').length,1);
  });

  await check('V13108G-07:rejoin-probe-measures-commanded-landed-and-late-release', () => {
    assert.ok(exists('public/client/rejoin-probe.js'), 'rejoin-probe.js missing');
    let now = 0, wall = 0, playerPos = 100, playing = true, timers = [];
    const ctx = {Math, Number, JSON, console, performance: {now: () => now}};
    ctx.globalThis = ctx; ctx.window = ctx;
    ctx.setTimeout = (fn, ms) => { timers.push({at: now + ms, fn}); return timers.length; }; ctx.clearTimeout = () => {};
    ctx.localStorage = {getItem: () => null, setItem() {}};
    // Match the app's script order in this isolated deterministic VM.
    vm.runInNewContext(read('public/client/viewer-release-evidence.js'), ctx);
    vm.runInNewContext(read('public/client/viewer-timing-math.js'), ctx);
    vm.runInNewContext(read('public/client/viewer-sync-arbiter.js'), ctx);
    vm.runInNewContext(read('public/client/rejoin-probe.js'), ctx);
    const A = ctx.WatchFusionViewerSyncArbiter.createViewerSyncArbiter({timers: {setTimeout: ctx.setTimeout, clearTimeout: ctx.clearTimeout}});
    ctx.watchFusionViewerArbiter = A;
    const target = at => 100.5 + at / 1000; // the room is 500 ms ahead of the laptop
    const raw = {baseRate: 1, now: () => now, target: () => target(now), current: () => playerPos, state: () => playing ? 1 : 2,
      availableRates: () => [1], buffered: () => true, referenceTrusted: () => true, referenceUncertaintyMs: () => 10,
      seek: pos => { playerPos = pos - .4; }, pause: () => { playing = false; }, play: () => { playing = true; }, rate() {}};
    const io = ctx.WatchFusionRejoinProbe.wrap(raw);
    A.tick('s', now, io);
    assert.equal(A.rejoinNow(now, io, 'manual'), true, 'fixture: fixed-rate rejoin');
    for (let i = 0; i < 40 && !playing; i++) {
      now += 100;
      const due = timers.filter(x => x.at + 300 <= now); timers = timers.filter(x => x.at + 300 > now); // timers fire 300 ms late
      due.forEach(x => x.fn());
      // Once the release is scheduled, model a throttled page: no tick backstop, only the late timer.
      if (!playing && A.snapshot().reason !== 'rejoin-scheduled-release') A.tick('s', now, io);
    }
    const p = ctx.WatchFusionRejoinProbe.last();
    assert.ok(p, 'no landing record');
    assert.ok(Math.abs(p.leadMs - 1500) <= 1, 'commanded lead'); assert.equal(p.landedShortMs, 400, 'keyframe snap');
    assert.ok(p.releaseErrMs <= -250 && p.releaseErrMs >= -400, 'late timer is visible: ' + p.releaseErrMs);
    ctx.WatchFusionRejoinProbe.resumed(120, now + 2000);
    assert.equal(ctx.WatchFusionRejoinProbe.last().startLatencyMs, p.releaseLeadMs + 120);
  });

  await check('V13108G-08:zero-converge-pulse-exports-error-not-position', () => {
    const src = read('public/client/zero-converge.js');
    assert.match(src, /zero-converge-pulse', \{errorMs: Math\.round\(m\)/);
    assert.doesNotMatch(src, /zero-converge-pulse', \{positionMs/);
  });

  await check('V13108G-09:a-correction-opens-a-capped-denser-trace-burst', () => {
    const element = () => ({value: '', textContent: '', open: false, addEventListener() {}, focus() {}, select() {}});
    const nodes = {syncRoomLog: element(), syncRoomLogText: element(), syncRoomLogCopy: element(), syncRoomLogClear: element(), syncRoomLogCount: element()};
    let now = 100000;
    const ctx = {document: {getElementById: id => nodes[id] || null}, navigator: {}, performance: {now: () => now},
      roomId: 'room-1', session: {memberId: 'h'}, isHost: () => true,
      state: {presentationEpoch: 1, playoutSegment: 6, hostId: 'h', playback: {rate: 1, position:60, projectedAt:now-10}, members: [{id: 'h', name: 'Laptop-Side'}]},
      estimatedServerNow: () => now, setTimeout, console, Date, JSON, Math, Object, Number, Array, String, RegExp};
    ctx.window = ctx;
    vm.runInNewContext(read('public/client/precision-policy.js'), ctx);
    vm.runInNewContext(read('public/client/sync-room-log.js'), ctx);
    const log = ctx.watchFusionRoomSyncLog;
    const peer = () => ({member: 'h', playoutSegment:6, sampledAt: now - 10, positionMs: 60000 - 300, roomPositionMs: 60000, targetPositionMs: 60000,
      ready: true, playing: true, buffering: false, rttMs: 10, rate: 1, audible: true});
    log.observe([peer()], {reference: 'linked-tab', source: 'live'});
    log.note('host-source-rejoin-accepted', {attempts: 1});
    for (let i = 0; i < 20; i++) { now += 600; log.observe([peer()], {reference: 'linked-tab', source: 'live'}); }
    const shots = JSON.parse(log.export()).snapshots.length;
    assert.ok(shots >= 10 && shots <= 13, 'about 6 s of 500 ms snapshots, then normal cadence: ' + shots);
    log.note('rejoin-landing', {leadMs: 1500, landedShortMs: 400, releaseLeadMs: 180, releaseErrMs: -70, holdMs: 2600});
    const ev = JSON.parse(log.export()).events.at(-1);
    assert.deepEqual([ev.kind, ev.leadMs, ev.landedShortMs, ev.releaseErrMs], ['rejoin-landing', 1500, 400, -70]);
  });

  await check('V13108G-10:wiring-probe-and-contradiction-reach-the-live-path', () => {
    const ps = read('public/playback-sync.js'), sf = read('src/server/static-files.js');
    assert.match(ps, /WatchFusionRejoinProbe\?\.wrap\?\.\(raw\) \?\? raw\)\(arbiterIo\(baseRate, duration\)\)/);
    assert.match(ps, /contradiction:window\.WatchFusionMirrorConvergenceGate\?\.contradicted\?\.\(\)/);
    assert.ok(sf.indexOf("'client/rejoin-probe.js'") > 0 && sf.indexOf("'client/rejoin-probe.js'") < sf.indexOf("'playback-sync.js'"));
  });
}
