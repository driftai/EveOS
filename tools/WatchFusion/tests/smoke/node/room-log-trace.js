import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { world, fakePlayer, roomGlobals } from './v13107-falsifiers.js';

const source = fs.readFileSync(new URL('../../../public/client/sync-room-log.js', import.meta.url), 'utf8');

function loadRoomLog() {
  const element = () => ({value:'', textContent:'', addEventListener() {}, focus() {}, select() {}});
  const nodes = {syncRoomLog:element(), syncRoomLogText:element(), syncRoomLogCopy:element(),
    syncRoomLogClear:element(), syncRoomLogCount:element()};
  let serverNow = 1000;
  const context = {document:{getElementById:id => nodes[id] || null}, navigator:{}, performance:{now:() => serverNow},
    roomId:'room-1', session:{memberId:'tv'}, state:{presentationEpoch:1, members:[{id:'tv', name:'TV'}]},
    estimatedServerNow:() => serverNow, setTimeout, console};
  context.window = context;
  vm.runInNewContext(source, context, {filename:'sync-room-log.js'});
  return {ctx:context,log:context.window.watchFusionRoomSyncLog, advance:ms => {serverNow += ms;}};
}

export async function runRoomLogChecks(check) {
  await check('ROOMLOG-01:source-trust transitions are recorded immediately, not on the 4.5 s cadence', () => {
    const {log, advance} = loadRoomLog();
    const peer = {member:'tv', positionMs:5000, roomPositionMs:5000};
    const snapshots = () => JSON.parse(log.export()).snapshots.map(row => row.source);
    log.observe([peer], {reference:'room-clock', source:'off-phase'});
    advance(500);
    log.observe([peer], {reference:'room-clock', source:'off-phase'});
    assert.deepEqual(snapshots(), ['off-phase'], 'an unchanged state still waits for the periodic cadence');
    advance(500);
    log.observe([peer], {reference:'room-clock', source:'live'});
    advance(400);
    log.observe([peer], {reference:'room-clock', source:'frozen'});
    assert.deepEqual(snapshots(), ['off-phase','live','frozen'], 'each src change lands in the trace at once');
  });
  await run06jPrecisionChecks(check);
  await runActivityChecks(check);
  await runCopyIsolationChecks(check);
  await run06jhChecks(check);
}

// 06j: identical media samples against different private target leases are not a room comparison.
function precisionFixture({rate=1, anchorShift=0}={}) {
  const node=()=>({value:'',open:false,textContent:'',children:[],append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},addEventListener(){},setAttribute(){},focus(){},select(){}});
  const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
  let now=200000;
  const ctx={document:{getElementById:get,createElement:node,activeElement:null},$:get,navigator:{},roomId:'r',session:{memberId:'h',publicId:'h'},state:{presentationEpoch:1,playoutSegment:4,hostId:'h',source:{videoId:'song'},linkedSourceActive:true,playback:{rate,paused:false,position:200+anchorShift/1000,projectedAt:now},members:[{id:'h',name:'Host'},{id:'v',name:'TV'}]},performance:{now:()=>now},estimatedServerNow:()=>now,console};ctx.window=ctx;ctx.isHost=()=>true;
  const read=name=>fs.readFileSync(new URL('../../../public/client/'+name+'.js',import.meta.url),'utf8');
  for(const name of ['precision-policy','sensor-provenance','sync-room-log','sync-center'])vm.runInNewContext(read(name),ctx);
  const peer=(member,{age=10,offset=0,target=0,localAnchor=0,speed=rate,extra={}}={})=>({member,playoutSegment:4,ready:true,playing:true,buffering:false,sampledAt:now-age,positionMs:200000+(now-200000)*rate-age*speed+offset,roomPositionMs:200000+(now-200000-age)*rate+localAnchor,targetPositionMs:200000+(now-200000-age)*rate+target,rate:speed,startupPhase:'fine-locked',recentCorrection:'locked',sensor:{clockState:'bounded',clockBoundMs:8,timelineState:'advancing',heldMs:1,audibleOutput:'player'},...extra});
  const rows=(a,b)=>[peer('h',a),peer('v',b)];
  ctx.watchFusionPlayout={sourceErrorMs:(p,c,t)=>c?.source==='live'&&p.playoutSegment===4&&p.ready&&p.playing&&!p.buffering&&!p.correcting&&t-p.sampledAt<=1500?p.testSourceError??null:null};
  const observe=(a,b,options={},rosterSize=2)=>{const reports=rows(a,b).filter(p=>!p.omit);ctx.watchFusionRoomSyncLog.observe(reports,{segment:4,reference:'linked-tab',source:'live',sourceReferenceAt:now-80,uncertaintyMs:10,phaseMs:35,...options},{members:rosterSize,reporting:reports.length});return JSON.parse(ctx.watchFusionRoomSyncLog.export()).snapshots.at(-1);};
  const list=node();const ui=(a,b)=>{ctx.watchFusionSyncCenter.renderPeers(list,rows(a,b),ctx.state.members);return Object.fromEntries(list.children[0].children[1].children.map(m=>[m.children[0].textContent,m.children[1].textContent]));};
  return {ctx,observe,ui,advance:ms=>{now+=ms;}};
}
export async function run06jPrecisionChecks(check){
  await check('WF06JE-05:fresh sample clock provenance is exported without source identifiers',()=>{
    for(const [age,clock,gap] of [[100,'server-qualified',1000],[100,'relay-bounded',null],[3000,null,null]]){
      const l=precisionFixture();l.ctx.watchFusionLinkedTab={active:()=>true,metadata:()=>({sampledAt:Date.now()-age,sampleClock:clock||'server-qualified',relayAgeGapMs:1000,pageUrl:'private-source'})};
      const e=l.observe({},{}).linkedSourceEvidence;assert.equal(e.sampleClock,clock);assert.equal(e.relayAgeGapMs,gap);assert.ok(!JSON.stringify(e).includes('private-source'));
    }
  });
  await check('WF06J-01:mixed target leases do not inflate 13ms into 48ms',()=>{
    const s=precisionFixture().observe({age:8,offset:27},{age:610,offset:14,target:35});
    assert.equal(s.timelineSpreadMs,13);assert.equal(s.groupSpreadMs,13);assert.equal(s.peers[1].relativeToHostMs,-13);
    assert.equal(s.peers[0].targetErrorMs,27);assert.equal(s.peers[1].targetErrorMs,-21);assert.equal(s.speakerPhase,'not-measured');
  });
  await check('WF06J-02:separate targets cannot hide real 130ms separation',()=>{
    const s=precisionFixture().observe({offset:0},{age:610,offset:130,target:130});assert.equal(s.timelineSpreadMs,130);assert.equal(s.groupPhase,'players-disagree');
  });
  await check('WF06J-03:republished room anchors cannot change player separation',()=>{
    const s=precisionFixture({anchorShift:100}).observe({age:8,offset:27},{age:610,offset:14,target:35,localAnchor:100});
    assert.equal(s.timelineSpreadMs,13);assert.equal(s.comparisonReference,'common-room-clock');assert.equal(s.commonModeMs,-73);
  });
  await check('WF06J-04:stale future replaced and recovering reports are not comparison witnesses',()=>{
    for(const b of [{age:1501},{age:-1},{extra:{playoutSegment:3}},{extra:{playoutSegment:null}},{extra:{correcting:true}},{extra:{startupPhase:'decoder-stalled'}},{extra:{positionMs:null}}]){
      const s=precisionFixture().observe({},b);assert.equal(s.timelineSpreadMs,null,JSON.stringify(b));assert.equal(s.timelinePlayerCount,1);
    }
  });
  await check('WF06J-05:project observations at their actual rates not the room rate',()=>{
    const s=precisionFixture({rate:1.25}).observe({age:100,speed:1.25,offset:12},{age:800,speed:1,offset:2});
    assert.equal(s.timelineSpreadMs,10);assert.equal(s.peers[1].relativeToHostMs,-10);
  });
  await check('WF06J-06:Sync Center uses a common instant rather than per-player room anchors',()=>{
    const l=precisionFixture(),a={age:8,offset:27},b={age:610,offset:14,localAnchor:100};let metrics;
    for(let i=0;i<5;i++){metrics=l.ui(a,b);l.advance(700);}
    assert.match(metrics['Player-to-player timeline spread'],/^13 ms \(/);assert.match(metrics['Clock-only spread upper estimate'],/^30 ms /);
  });
  await check('WF06J-07:small point estimate is not proof of ultra precision',()=>{
    const s=precisionFixture().observe({offset:1},{offset:6});assert.equal(s.timelineSpreadMs,5);assert.ok(s.clockOnlySpreadUpperMs>=21);assert.equal(s.speakerPhase,'not-measured');
    const uncertain=precisionFixture().observe({offset:0,extra:{sensor:{clockState:'bounded',clockBoundMs:80,audibleOutput:'player',timelineState:'advancing'}}},{offset:90});assert.equal(uncertain.groupPhase,'players-disagree');
    const t=JSON.parse(precisionFixture().ctx.watchFusionRoomSyncLog.export());assert.equal(t.traceVersion,'adaptive-room-06je-trace');
    const l=precisionFixture();l.observe({offset:0},{offset:4});l.advance(5000);l.observe({offset:0},{offset:8});
    const summary=JSON.parse(l.ctx.watchFusionRoomSyncLog.export()).trackSummaries[0];assert.equal(summary.within5,1);assert.equal(summary.within10,2);
  });
  await check('WF06J-08:held slow and jumped positions cannot certify a timeline comparison',()=>{
    for(const timelineState of ['held','slow','jumped']){const s=precisionFixture().observe({}, {extra:{sensor:{clockState:'bounded',clockBoundMs:8,timelineState,heldMs:1,audibleOutput:'player'}}});assert.equal(s.timelineSpreadMs,null,timelineState);}
  });
}

async function runActivityChecks(check){
  const missing={extra:{omit:true}}, valid=error=>({offset:error,extra:{testSourceError:error}});
  await check('WF06JA-01:hidden absent host does not invalidate qualified TV source following or become a full room pass',()=>{
    const l=precisionFixture();l.ctx.document.hidden=true;const s=l.observe(missing,valid(8));
    assert.equal(s.activity.localParticipation,'background-inactive');assert.equal(s.activity.sourceContinuity,'viewer-source-within-50');
    assert.equal(s.timelineSpreadMs,null);assert.equal(s.activity.measuredViewers,1);assert.equal(s.activity.maxViewerSourceErrorMs,8);
    const t=JSON.parse(l.ctx.watchFusionRoomSyncLog.export()).trackSummaries[0];assert.equal(t.backgroundInactive,1);assert.equal(t.unmeasured,1);assert.equal(t.qualifiedWithin50,0);assert.equal(t.sourceViewerWithin50,1);
  });
  await check('WF06JA-02:hidden advancing host remains active and genuine viewer drift is not excused',()=>{
    const l=precisionFixture();l.ctx.document.hidden=true;let s=l.observe(valid(0),valid(160));
    assert.equal(s.activity.localParticipation,'background-active');assert.equal(s.activity.sourceContinuity,'viewer-source-outside-100');assert.equal(s.timelineSpreadMs,160);
    l.advance(100);s=l.observe(missing,valid(96));assert.equal(s.activity.sourceContinuity,'viewer-source-monitoring');
    l.advance(100);s=l.observe(missing,valid(160));assert.equal(s.activity.sourceContinuity,'viewer-source-outside-100');assert.equal(s.timelineSpreadMs,null);
  });
  await check('WF06JA-03:foreground reacquisition persists until qualified local and room alignment',()=>{
    const l=precisionFixture();l.ctx.document.hidden=true;l.observe(missing,valid(4));l.advance(60000);l.ctx.document.hidden=false;
    let s=l.observe(missing,valid(4));assert.equal(s.activity.localParticipation,'foreground-reacquiring');assert.equal(s.activity.coverageGapMs,60000);
    l.advance(100);s=l.observe(valid(1900),valid(4));assert.equal(s.activity.localParticipation,'foreground-reacquiring');assert.equal(s.timelineSpreadMs,1896);
    l.advance(100);s=l.observe(valid(0),valid(4));assert.equal(s.activity.localParticipation,'foreground-active');assert.equal(s.timelineSpreadMs,4);
  });
  await check('WF06JA-04:missing stale held or unqualified source evidence never certifies continuity',()=>{
    for(const [tv,c] of [[missing,{}],[{age:1600,extra:{testSourceError:0}},{}],[{extra:{testSourceError:0,sensor:{timelineState:'held',clockState:'bounded',audibleOutput:'player'}}},{}],[valid(0),{sourceReferenceAt:1}],[valid(0),{source:'frozen'}]]){
      const l=precisionFixture();l.ctx.document.hidden=true;const s=l.observe(missing,tv,c);
      assert.ok(['viewer-source-unmeasured','source-unverified'].includes(s.activity.sourceContinuity));assert.equal(s.activity.measuredViewers,0);assert.equal(s.timelineSpreadMs,null);
    }
  });
  await check('WF06JA-05:ordinary visible outage and deliberate pause have different labels; room scope resets',()=>{
    const l=precisionFixture();l.ctx.document.hidden=false;let s=l.observe(missing,valid(3));assert.equal(s.activity.localParticipation,'foreground-unavailable');
    l.ctx.document.hidden=true;l.advance(100);l.observe(missing,valid(3));l.ctx.roomId='another';l.ctx.document.hidden=false;l.advance(100);s=l.observe(missing,valid(3));assert.equal(s.activity.localParticipation,'foreground-unavailable');assert.equal(s.activity.coverageGapMs,null);
    l.ctx.state.playback.paused=true;l.advance(100);s=l.observe(missing,valid(3));assert.equal(s.activity.localParticipation,'room-paused');assert.equal(s.activity.sourceContinuity,'room-paused');
  });
}

// Exercise actual copy handlers, not a static text or presence check.
function copyFixture(){
  const doc={activeElement:null,body:{appendChild(){}},execCommand:()=>false};
  const nodes=new Map(); const element=()=>({value:'',open:true,textContent:'',disabled:false,style:{},events:{},selectionStart:0,selectionEnd:0,
    addEventListener(k,fn){this.events[k]=fn;},setAttribute(){},remove(){},focus(){doc.activeElement=this;},select(){this.selectionStart=0;this.selectionEnd=this.value.length;}});
  doc.getElementById=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);};doc.createElement=element;
  let now=1000;const ctx={document:doc,navigator:{clipboard:{writeText:async()=>{throw Error('denied');}}},performance:{now:()=>now},estimatedServerNow:()=>now,
    roomId:'room',session:{memberId:'host'},state:{presentationEpoch:1,source:{title:'Synthetic song'},members:[{id:'host',name:'Host'},{id:'tv',name:'TV'},{id:'phone',name:'Phone'}]},setTimeout,console};ctx.window=ctx;
  vm.runInNewContext(source,ctx);const log=ctx.watchFusionRoomSyncLog;
  const area=doc.getElementById('syncRoomLogText'),copy=doc.getElementById('syncRoomLogCopy'),panel=doc.getElementById('syncRoomLog'),clear=doc.getElementById('syncRoomLogClear');
  function sample(extra={}){now+=5000;log.observe([{member:'host',positionMs:1000,roomPositionMs:1000,corrections:36,...extra}],{reference:'room-clock',source:'live'},{members:3,reporting:1});}
  async function click(){await copy.events.click();await new Promise(r=>setTimeout(r,25));}
  return {ctx,doc,area,copy,panel,clear,log,sample,click};
}
const clientSource=name=>fs.readFileSync(new URL('../../../public/client/'+name+'.js',import.meta.url),'utf8');
async function runCopyIsolationChecks(check){
  await check('WF06JC-06:partial room comparison cannot certify complete room acquisition',()=>{
    const h=precisionFixture();h.ctx.state.members.push({id:'phone',name:'Phone'});h.observe({offset:2},{offset:4},{},2);
    let t=JSON.parse(h.ctx.watchFusionRoomSyncLog.export()).trackSummaries[0];assert.equal(t.within50,1);assert.equal(t.fullRoomWithin50,0);assert.equal(t.fullRoomUnmeasured,1);assert.equal(t.firstAllWithin50At,null);
    h.advance(100);h.ctx.state.members.pop();h.observe({offset:2},{offset:4},{},2);t=JSON.parse(h.ctx.watchFusionRoomSyncLog.export()).trackSummaries[0];assert.equal(t.fullRoomComparable,1);assert.equal(t.fullRoomWithin50,1);assert.ok(t.firstAllWithin50At);assert.equal(t.firstQualifiedWithin50At,t.firstAllWithin50At);
  });
  await check('WF06JC-05:recovery stage and refresh evidence remain visible in copyable diagnostics',()=>{
    const h=copyFixture();h.sample({decoderRecovery:{outcome:'recovery-budget-restored',steps:1,stallMs:6500}});
    h.log.note('tv-decoder-resumed',{step:1,reason:'recovery-budget-restored'});
    assert.match(h.area.value,/recovery recovery-budget-restored \(1\/2\)/);
    const t=JSON.parse(h.log.export());assert.equal(t.snapshots[0].peers[0].decoderRecovery.steps,1);
    assert.ok(t.events.some(e=>e.kind==='tv-decoder-resumed'&&e.step===1));
  });
  await check('WF06JBR1-01:manual JSON selection survives new snapshots and repeated Select to copy',async()=>{
    const h=copyFixture();h.sample();await h.click();const captured=h.area.value;assert.equal(JSON.parse(captured).snapshots.length,1);
    for(let i=0;i<5;i++)h.sample();assert.equal(h.area.value,captured);assert.equal(h.area.selectionEnd,captured.length);
    h.doc.activeElement=h.copy;await h.click();assert.equal(h.area.value,captured);assert.equal(h.area.selectionEnd,captured.length);assert.equal(JSON.parse(h.log.export()).snapshots.length,6);
    h.panel.open=false;h.panel.events.toggle();h.doc.activeElement=null;h.panel.open=true;h.panel.events.toggle();assert.ok(!h.area.value.startsWith('{'));assert.match(h.area.value,/measured 0\/3/);assert.match(h.area.value,/36 corrections/);
  });
  await check('WF06JBR1-02:manual preview selection is not replaced while focused',()=>{
    const h=copyFixture();h.sample();h.area.focus();h.area.select();const before=h.area.value;h.sample();assert.equal(h.area.value,before);
    h.doc.activeElement=null;h.area.events.blur();assert.notEqual(h.area.value,before);
  });
  await check('WF06JBR1-03:scope or Clear invalidates an in-flight export',async()=>{
    for(const action of ['clear','room']){
      const h=copyFixture();h.sample();let finish;const started=new Promise(resolve=>{h.ctx.navigator.clipboard.writeText=()=>new Promise((_,reject)=>{finish=()=>reject(Error('denied'));resolve();});});
      const pending=h.click();await started;if(action==='clear')h.clear.events.click();else {h.ctx.roomId='other';h.sample();}
      finish();await pending;assert.equal(h.copy.disabled,false);assert.ok(!h.area.value.startsWith('{'));assert.equal(h.copy.textContent,'Copy log');
    }
  });
  await check('WF06JBR1-04:healthy room refocus does not rejoin but stale disconnected or visible-return rooms do',async()=>{
    let now=1000,requests=0,connected=true;const callbacks={};
    const ctx={roomId:'room',session:{memberId:'member'},state:{roomId:'room',revision:1},eventSource:null,remotePollTimer:null,
      performance:{now:()=>now},document:{visibilityState:'visible',addEventListener:(k,fn)=>callbacks[k]=fn},addEventListener:(k,fn)=>callbacks[k]=fn,
      watchPartyRealtime:{connected:()=>connected},setStatus(){},apiUrl:s=>s,currentName:()=> 'Host',accountId:'account',roomCode:'code',
      fetch:async()=>{requests++;throw Error('offline fixture');},console};ctx.window=ctx;
    vm.runInNewContext(clientSource('room-connection'),ctx);ctx.applyIncomingRoomState({roomId:'room',revision:2,serverTime:1000});
    for(let i=0;i<3;i++)await callbacks.focus();assert.equal(requests,0);
    now+=16000;await callbacks.focus();assert.equal(requests,1);ctx.applyIncomingRoomState({roomId:'room',revision:3,serverTime:17000});
    connected=false;await callbacks.focus();assert.equal(requests,2);connected=true;await callbacks.visibilitychange();await new Promise(r=>setTimeout(r,0));assert.equal(requests,3);
    ctx.roomId='other';await callbacks.focus();assert.equal(requests,4);
  });
  await check('WF06JBR1-05:log gestures cannot prime or unmute players, ordinary audio gestures still work',async()=>{
    const ctx=world(),p=fakePlayer(ctx,{state:1,muted:true});roomGlobals(ctx,p,{targetOffsetSec:0});
    let applications=0;Object.assign(ctx,{autoplayWasBlocked:true,userGesturePrimeUsed:false,userGesturePrimeInstalled:false,pendingVideoId:'video',suppressAudioPersistence:false,
      YT:{PlayerState:{PLAYING:1}},authoritativeRoomAudio:()=>({volume:57,muted:false}),applyRoomAudioState:()=>{applications++;p.unMute();return true;},setStatus(){}});
    vm.runInContext(clientSource('youtube-player'),ctx);ctx.installUserGesturePrime();vm.runInContext(clientSource('room-audio-unlock'),ctx);ctx.advance(500);
    for(const kind of ['pointerdown','touchstart','keydown','click'])for(const fn of ctx.windowListeners.get(kind)||[])await fn({isTrusted:true,target:{closest:s=>s==='#syncRoomLog'?{}:null}});
    assert.equal(applications,0);assert.equal(p.calls.length,0);
    for(const fn of ctx.windowListeners.get('pointerdown')||[])await fn({isTrusted:true,target:{closest:()=>null}});
    assert.ok(applications>0);assert.equal(p.muted,false);
  });
  await check('WF06JBR1-06:local linked-host hydration cannot echo a seek or pause to the source',()=>{
    let now=1000,position=30,playerState=1;const controls=[];
    const ctx={roomId:'room',state:{linkedSourceActive:true},isHost:()=>true,followsRoomPlayback:()=>true,applyingRemote:false,playerInitializing:false,primingPlayer:false,ytPlayerReady:true,
      ytPlayer:{getCurrentTime:()=>position,getPlaybackRate:()=>1,getPlayerState:()=>playerState},YT:{PlayerState:{PLAYING:1,PAUSED:2,BUFFERING:3}},performance:{now:()=>now},setInterval(){},
      watchFusionLinkedTab:{active:()=>true,applying:()=>false,metadata:()=>({paused:false}),control:(...args)=>controls.push(args)},console};ctx.window=ctx;
    vm.runInNewContext(clientSource('linked-playback-sync'),ctx);vm.runInNewContext(clientSource('commands'),ctx);
    ctx.sampleLinkedYoutubePosition();ctx.applyingRemote=true;now+=250;position=40;playerState=3;ctx.onYouTubeStateChange({data:3});ctx.sampleLinkedYoutubePosition();
    playerState=2;ctx.onYouTubeStateChange({data:2});assert.equal(controls.length,0);
    ctx.applyingRemote=false;playerState=1;ctx.sampleLinkedYoutubePosition();assert.equal(controls.length,0);
    now+=250;position=50;ctx.sampleLinkedYoutubePosition();assert.deepEqual(controls,[['seek',50]]);
  });
}

// 06jh: display lifecycle, 26ms excitation gap, repeat retention, and diagnostic load.
async function run06jhChecks(check){
  const episode=(offset=.026,mode='clean',host=true)=>{
    const ctx=world(),p=fakePlayer(ctx,{position:30-offset}),events=[],listeners={};let starts=0,witness=null;
    roomGlobals(ctx,p,{targetOffsetSec:0,host,uncertaintyMs:11});
    ctx.document.addEventListener=(k,fn)=>{(listeners[k]??=[]).push(fn);};
    ctx.watchFusionPlayout.status=()=>({source:'live',reference:'linked-tab',uncertaintyMs:11,sourcePhaseMs:0,anchorPositionMs:30000,anchorAt:1.7e12,rate:1,phaseMs:0});
    ctx.watchFusionPlayout.hasSourceReference=()=>true;
    ctx.watchPartyClock={precise:()=>mode!=='thin',rttMs:()=>mode==='thin'?60:5};
    ctx.WatchFusionHostSeekPolicy={sourceBlocker:()=>mode==='disputed'?'host-source-disagrees':null};
    ctx.watchFusionViewerArbiter.snapshot=()=>ctx.ytPlayer.rate!==1&&witness?witness:({timelineErrorMs:(ctx.watchFusionYouTubeTarget()-ctx.ytPlayer.position)*1000,timelineObservedAtMs:ctx.clock()});
    ctx.watchFusionRoomSyncLog={note:(kind,detail)=>events.push({kind,...detail})};
    p.setPlaybackRate=r=>{p.calls.push(['rate',r]);if(r!==1){starts++;witness=ctx.watchFusionViewerArbiter.snapshot();}p.rate=r;};
    if(mode==='jump'||mode==='ignored')ctx.tick=at=>{p.position=30-offset+at/1000;};
    if(mode==='jump')p.getCurrentTime=()=>p.position+(p.rate!==1?.073:0);
    vm.runInContext(clientSource('zero-converge'),ctx);
    return {ctx,p,events,starts:()=>starts,error:()=>Math.abs(ctx.watchFusionYouTubeTarget()-p.position)*1000,display:(on,type='fullscreenchange')=>{ctx.document.fullscreenElement=on?{}:null;for(const fn of listeners[type]||[])fn({type});}};
  };
  await check('WF06JH-01:precise 26ms host residual is trimmed without inventing actuator motion',()=>{
    for(const offset of [.026,.037]){const h=episode(offset);h.ctx.advance(18000);assert.ok(h.error()<=16,`residual ${h.error()}`);assert.equal(h.p.rate,1);
    assert.ok(h.events.some(e=>e.kind==='zero-actuator-verified'&&e.reason==='verified'));assert.ok(h.p.calls.every(([k])=>k==='rate'));}
  });
  await check('WF06JH-02:fullscreen interrupts an active trim and preserves spent budget',()=>{
    const h=episode(.018);h.ctx.advance(2250);assert.equal(h.p.rate,1.25);h.display(true);h.display(true,'webkitfullscreenchange');
    assert.equal(h.p.rate,1);assert.equal(h.ctx.WatchFusionZeroConverge.diagnostics().actuator.verificationReason,'display-transition');
    h.ctx.advance(8000);assert.equal(h.starts(),1);assert.ok(!h.events.some(e=>e.kind==='zero-actuator-verified'&&e.reason==='verified'));
    assert.equal(h.events.filter(e=>e.reason==='fullscreen-enter').length,1);h.display(false);assert.ok(h.events.some(e=>e.reason==='fullscreen-exit'));
  });
  await check('WF06JH-03:repeated verified micro locks do not exhaust after three lifetime rearms',()=>{
    const h=episode(.018);for(let i=0;i<6;i++){h.p.position=h.ctx.watchFusionYouTubeTarget()-.018;h.ctx.advance(24000);assert.ok(h.error()<=10,`episode ${i} residual ${h.error()}`);assert.equal(h.p.rate,1);}
    assert.equal(h.starts(),6);assert.equal(h.events.filter(e=>e.kind==='zero-actuator-verified'&&e.reason==='verified').length,6);
  });
  await check('WF06JH-04:precision step rejects a 73ms cached jump and respects clock vetoes',()=>{
    for(const mode of ['thin','disputed','jump','ignored']){const h=episode(.026,mode);h.ctx.advance(150000);assert.equal(h.p.rate,1);assert.ok(!h.events.some(e=>e.kind==='zero-actuator-verified'&&e.reason==='verified'),mode);assert.ok(h.starts()<=6,mode);if(mode==='thin'||mode==='disputed')assert.equal(h.starts(),0,mode);else {assert.ok(h.starts()>0,mode);if(mode==='jump')assert.ok(h.events.some(e=>e.reason==='implausible-phase-sample'),mode);}}
  });
  await check('WF06JH-05:same-segment viewer player replacement discards old capability evidence',()=>{
    const h=episode(.079,'ignored',false);h.ctx.advance(9000);assert.equal(h.starts(),1);
    const newPlayer=fakePlayer(h.ctx,{position:h.ctx.watchFusionYouTubeTarget()-.079});newPlayer.last=h.ctx.clock();h.ctx.ytPlayer=newPlayer;
    h.ctx.advance(250);assert.equal(h.ctx.WatchFusionZeroConverge.diagnostics().capabilities.length,0);
    h.ctx.advance(9000);assert.ok(Math.abs(h.ctx.watchFusionYouTubeTarget()-newPlayer.position)*1000<50);assert.equal(newPlayer.rate,1);assert.equal(h.p.rate,1);
  });
  await check('WF06JH-06:large-room trace retains bounded history across 40 tracks and member churn',()=>{
    const h=loadRoomLog(),c=h.ctx;c.state.hostId='tv';c.state.playoutSegment=4;c.state.playback={position:1,projectedAt:1000,rate:1,paused:false};c.state.source={videoId:'song0'};let rosterScans=0;
    c.WatchFusionPrecisionPolicy={comparisonPosition:(p,at)=>p.positionMs+(at-p.sampledAt)*p.rate};
    for(let i=0;i<1300;i++){h.advance(5000);c.state.source.videoId='song'+Math.floor(i/32);const now=c.estimatedServerNow();
      c.state.members=Array.from({length:16},(_,j)=>({id:j===0?'tv':j===15?'churn-'+i:'p'+j,name:'Device '+j}));
      c.state.members.find=function(...args){rosterScans++;return Array.prototype.find.apply(this,args);};
      const peers=c.state.members.map((m,j)=>({member:m.id,playoutSegment:4,ready:true,playing:true,buffering:false,sampledAt:now,positionMs:now+j,roomPositionMs:now,targetPositionMs:now,rate:1,startupPhase:'fine-locked',audible:true,sensor:{clockState:'bounded',clockBoundMs:5,timelineState:'advancing',audibleOutput:'player'}}));
      h.log.observe(peers,{reference:'room-clock',source:'live',segment:4},{members:16,reporting:16});h.log.note('runtime-resume',{reason:'fullscreen-enter'});
    }
    for(let i=0;i<600;i++)h.log.note('runtime-resume',{reason:'fullscreen-exit'});
    const r=JSON.parse(h.log.export());assert.equal(r.snapshots.length,1200);assert.equal(r.events.length,1800);assert.equal(r.trackSummaries.length,32);
    assert.equal(r.retention.droppedSnapshots,100);assert.ok(r.retention.droppedEvents>=100);assert.equal(r.snapshots.at(-1).timelinePlayerCount,16);assert.equal(r.snapshots.at(-1).timelineSpreadMs,15);assert.equal(rosterScans,0);
  });
  await check('WF06JH-07:duplicate display names do not invent repeated peer-state transitions',()=>{
    const h=loadRoomLog(),c=h.ctx;c.state.hostId='tv';c.state.playoutSegment=4;c.state.playback={position:1,projectedAt:1000,rate:1,paused:false};c.state.source={videoId:'song'};c.state.members=[{id:'tv',name:'TV'},{id:'phone',name:'TV'}];
    c.WatchFusionPrecisionPolicy={comparisonPosition:p=>p.positionMs};
    const sample=(changed=false)=>{const now=c.estimatedServerNow(),peers=c.state.members.map((m,i)=>({member:m.id,playoutSegment:4,ready:true,playing:true,buffering:false,sampledAt:now,positionMs:now+i,roomPositionMs:now,targetPositionMs:now,rate:1,startupPhase:i&&!changed?'decoder-confirmed':'fine-locked',audible:true,sensor:{clockState:'bounded',clockBoundMs:5,timelineState:'advancing',audibleOutput:'player'}}));h.log.observe(peers,{reference:'room-clock',source:'live',segment:4},{members:2,reporting:2});};
    sample();h.advance(500);sample();assert.equal(JSON.parse(h.log.export()).snapshots.length,1);h.advance(500);sample(true);assert.equal(JSON.parse(h.log.export()).snapshots.length,2);
  });
  await check('WF06JH-08:40 new video scopes each qualify independently without inherited correction state',()=>{
    const h=episode(.018);for(let i=0;i<40;i++){const video='video'+i;h.ctx.state.source.videoId=h.p.videoId=video;h.ctx.state.playoutSegment++;h.p.position=h.ctx.watchFusionYouTubeTarget()-.018;h.ctx.advance(9000);assert.ok(h.error()<=10,`video ${i}`);assert.equal(h.p.rate,1);assert.equal(h.ctx.WatchFusionZeroConverge.diagnostics().pulses,1);}
    assert.equal(h.starts(),40);assert.ok(h.p.calls.every(([k])=>k==='rate'));
  });
  await check('WF06JH-09:measurement retry budget renews only after verified improvement',()=>{
    const h=episode(.079,'clean',false),original=h.p.setPlaybackRate;let startsAt=0;
    h.p.setPlaybackRate=r=>{if(r===1&&h.p.rate!==1&&h.starts()-startsAt<=3)h.p.position=h.ctx.watchFusionYouTubeTarget()-.079;original(r);};
    for(let i=0;i<2;i++){startsAt=h.starts();h.p.position=h.ctx.watchFusionYouTubeTarget()-.079;h.ctx.advance(125000);assert.ok(h.error()<=50,`episode ${i} residual ${h.error()}`);assert.ok(h.starts()-startsAt>=4&&h.starts()-startsAt<=6);assert.equal(h.p.rate,1);}
    assert.equal(h.events.filter(e=>e.reason==='fresh-stable-evidence').length,2);
  });
}
