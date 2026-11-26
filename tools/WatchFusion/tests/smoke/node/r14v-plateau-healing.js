// R14v: replay of the 2026-11-21 physical late-TV-lock trace plus Nova-style
// recovery falsifiers: no hidden reloads, no budget-loop, no speaker-phase claim.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const ROOT=process.env.WF_FALSIFIER_ROOT||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const read=rel=>fs.readFileSync(path.join(ROOT,rel),'utf8');
// Sanitized actual 44 snapshots, [delta-ms, host-target-ms, TV-target-ms, TV-clock-state].
const PHYSICAL_20261121_STEADY = [[0,-3,-177,"thin"],[5606,-5,-170,"thin"],[5596,-3,-172,"thin"],[2804,-5,-178,"bounded"],[5594,-2,-179,"bounded"],[2799,-3,-173,"thin"],[5613,-4,-166,"bounded"],[2792,-6,-169,"thin"],[5598,-5,-171,"thin"],[5604,-6,-170,"thin"],[5596,-7,-172,"thin"],[5665,-5,-165,"thin"],[5536,-3,-169,"thin"],[2805,-6,-170,"bounded"],[5598,-7,-168,"thin"],[5597,-3,-173,"thin"],[5599,-6,-166,"bounded"],[5601,-6,-172,"bounded"],[2807,-6,-169,"thin"],[2791,-6,-165,"bounded"],[2804,-5,-169,"thin"],[5596,-4,-171,"thin"],[5602,-3,-162,"thin"],[5606,-7,-173,"thin"],[5600,-5,-170,"thin"],[5592,-5,-179,"thin"],[2858,-7,-169,"bounded"],[2750,-4,-175,"thin"],[5601,-5,-169,"thin"],[5593,-6,-169,"bounded"],[5597,-6,-170,"thin"],[2805,-6,-179,"bounded"],[5603,-5,-176,"thin"],[5593,-7,-175,"thin"],[2808,-6,-173,"bounded"],[2792,-6,-175,"thin"],[5602,-5,-171,"thin"],[5600,-5,-170,"thin"],[5600,-6,-167,"thin"],[5598,-4,-179,"thin"],[2813,-5,-179,"bounded"],[5645,-5,-164,"bounded"],[5553,-7,-168,"bounded"],[2794,-4,-170,"thin"]];

function decoderLab() {
  let hidden=false;
  const actions=[],notes=[];
  const ctx={window:{watchFusionRoomSyncLog:{note:(type,value)=>notes.push({type,value})}},
    document:{get hidden(){return hidden;}},Number,Math,Date,console};
  vm.runInNewContext(read('public/client/tv-decoder-rescue.js'),ctx);
  const decoder=ctx.window.WatchFusionDecoderRescue;
  const input=(t,changes={})=>({scope:'ROOM:VIDEO:4:20',nowMs:t,buffering:true,playing:false,exhausted:false,
    trusted:true,sourceBuffering:false,drift:-12,position:0,reload:()=>actions.push('reload'),
    rebuild:()=>actions.push('rebuild'),...changes});
  const wedge=(start,end,changes={})=>{
    for(let t=start;t<=end;t+=250)decoder.consider(input(t,changes));
  };
  const exhaust=()=>{wedge(0,55000);assert.equal(decoder.diagnostics().steps,2);assert.deepEqual(actions,['reload','rebuild']);};
  const healthy=(start,end,changes=()=>({}))=>{
    for(let t=start;t<=end;t+=500)decoder.consider(input(t,{playing:true,buffering:false,exhausted:false,
      drift:-.17,position:100+(t-start)/1000,...changes(t)}));
  };
  return {decoder,input,notes,actions,exhaust,healthy,wedge,hide:v=>{hidden=v;}};
}
function logLab(){
  let now=200000;
  let metadata={sampledAt:now,currentTime:40,rate:1,paused:false,tabMuted:true};
  const node=()=>({value:'',open:false,textContent:'',addEventListener(){},focus(){},select(){}});
  const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
  class ClockDate extends Date{static now(){return now;}}
  const ctx={document:{getElementById:get},navigator:{},roomId:'room',session:{memberId:'host',publicId:'host'},
    state:{presentationEpoch:1,playoutSegment:2,source:{videoId:'track'},hostId:'host',linkedSourceActive:true,playback:{rate:1,paused:false,position:now/1000,projectedAt:now},
      members:[{id:'host',name:'Laptop'},{id:'tv',name:'TV'}]},
    performance:{now:()=>now},estimatedServerNow:()=>now,Date:ClockDate,JSON,Math,Number,Map,Set,Object,console};
  ctx.watchFusionLinkedTab={active:()=>true,metadata:()=>metadata};ctx.isHost=()=>true;ctx.window=ctx;
  vm.runInNewContext(read('public/client/precision-policy.js'), ctx);
  vm.runInNewContext(read('public/client/sync-room-log.js'),ctx,{filename:'sync-room-log.js'});
  const peer=(member,offset,changes={})=>({member,playoutSegment:ctx.state.playoutSegment,ready:true,playing:true,buffering:false,sampledAt:now-10,
    positionMs:now-10+offset,roomPositionMs:now-10,targetPositionMs:now-10,rate:1,
    sensor:{clockState:'bounded',clockBoundMs:9,heldMs:1,audibleOutput:'player',timelineState:'advancing',timelineRatePct:100},
    startupPhase:'decoder-confirmed',recentCorrection:'locked',...changes});
  const observe=rows=>{
    ctx.watchFusionRoomSyncLog.observe(rows,{source:'live',reference:'linked-tab',sourceReferenceAt:now-60,uncertaintyMs:11,authorityBuffering:false});
    return JSON.parse(ctx.watchFusionRoomSyncLog.export()).snapshots.at(-1);
  };
  const advance=ms=>{now+=ms;metadata={...metadata,sampledAt:now,currentTime:metadata.currentTime+ms/1000};};
  return {peer,observe,advance,now:()=>now,ctx};
}
function uiLab(){
  let now=200000;
  const node=tag=>({tag,className:'',textContent:'',hidden:false,open:false,children:[],append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},setAttribute(){},addEventListener(){}});
  const elements=new Map(),lookup=id=>{if(!elements.has(id))elements.set(id,node('div'));return elements.get(id);};
  class ClockDate extends Date{static now(){return now;}}
  const ctx={$:lookup,document:{createElement:node,activeElement:null},
    state:{presentationEpoch:1,playoutSegment:2,source:{videoId:'track'},playback:{rate:1,paused:false,position:now/1000,projectedAt:now},linkedSourceActive:true,hostId:'host'},
    session:{publicId:'host'},estimatedServerNow:()=>now,isHost:()=>true,Date:ClockDate,Math,Number,Map,Set,JSON,Object,console};
  ctx.watchFusionPlayout={status:()=>({source:'live',reference:'linked-tab',sourceReferenceAt:now-60,uncertaintyMs:11,authorityBuffering:false}),sourceErrorMs:()=>-5};
  ctx.watchFusionLinkedTab={active:()=>true,metadata:()=>({sampledAt:now,currentTime:now/1000,rate:1,paused:false,tabMuted:true})};ctx.window=ctx;
  vm.runInNewContext(read('public/client/precision-policy.js'), ctx);
  vm.runInNewContext(read('public/client/sync-center.js'),ctx,{filename:'sync-center.js'});
  const peer=(member,offset,clockState='bounded',extra={})=>({member,playoutSegment:ctx.state.playoutSegment,ready:true,playing:true,buffering:false,sampledAt:now,
    positionMs:now+offset,roomPositionMs:now,targetPositionMs:now,rate:1,
    sensor:{clockState,clockBoundMs:34,heldMs:1,audibleOutput:'player'},startupPhase:'decoder-confirmed',recentCorrection:'observing',...extra});
  const list=node('ul');
  const render=peers=>{ctx.watchFusionSyncCenter.renderPeers(list,peers,[{id:'host',name:'Laptop'},{id:'tv',name:'TV'}]);return list.children.map(card=>({
    status:card.children[0].children[1].textContent,metrics:Object.fromEntries(card.children[1].children.map(m=>[m.children[0].textContent,m.children[1].textContent]))}));};
  return {peer,render,advance:ms=>{now+=ms;},ctx};
}
export async function runR14vChecks(check){
  await check('WF06F-04:post-decoder recovery moderate lag earns one rejoin after fresh motion',()=>{
    const l=decoderLab();l.wedge(0,10000);assert.equal(l.decoder.diagnostics().steps,1);
    let now=11000,position=100,trust=true,buffer=true,mirror=false;
    const io={follower:true,hostLinked:false,linkedSourceActive:()=>true,baseRate:1,state:()=>1,
      referenceTrusted:()=>trust,sourceReferenceQualified:()=>trust,mirrorContradicted:()=>mirror,sourceBuffering:()=>false,
      referenceUncertaintyMs:()=>25,current:()=>position,target:()=>position+2.5,buffered:()=>buffer};
    const eligible=()=>l.decoder.allowAutomaticRejoin({nowMs:now,error:2.5,lead:1.5,io});
    const advance=()=>{now+=250;position+=.25;};
    for(;now<25000;advance()){mirror=now>=17000&&now<20000;assert.equal(eligible(),false);}
    buffer=false;for(;now<28000;advance())assert.equal(eligible(),false);
    buffer=true;let accepted=0;for(;now<50000;advance())if(eligible()){assert.ok(now>=36000);accepted++;}
    assert.equal(accepted,1);assert.deepEqual(l.actions,['reload']);
    assert.equal(l.decoder.allowAutomaticRejoin({nowMs:now,error:9,lead:1.5,io}),true,'large displaced-player recovery is unchanged');
  });
  await check('WF06F-05:healthy host is unrestricted but a recovered host needs fresh qualified motion',()=>{
    const l=decoderLab();const io={follower:true,hostLinked:false,linkedSourceActive:()=>true};
    const host={...io,follower:false,hostLinked:true};
    assert.equal(l.decoder.allowAutomaticRejoin({nowMs:0,error:.6,io}),true);
    assert.equal(l.decoder.allowAutomaticRejoin({nowMs:0,error:.6,io:host}),true);
    l.exhaust();assert.equal(l.decoder.allowAutomaticRejoin({nowMs:56000,error:2.5,io:host}),false);
    let now=56000,pos=100;Object.assign(host,{baseRate:1,state:()=>1,referenceTrusted:()=>true,sourceReferenceQualified:()=>true,mirrorContradicted:()=>false,sourceBuffering:()=>false,referenceUncertaintyMs:()=>25,current:()=>pos,target:()=>pos+2.5,buffered:()=>true});
    let accepted=0;for(;now<85000;now+=250,pos+=.25)if(l.decoder.allowAutomaticRejoin({nowMs:now,error:2.5,lead:1.5,io:host})){assert.ok(now>=64000);accepted++;}
    assert.equal(accepted,1);assert.deepEqual(l.actions,['reload','rebuild']);
    assert.equal(l.decoder.allowAutomaticRejoin({nowMs:now,error:9,lead:1.5,io:host}),true);
  });
  await check('WF06F-08:real arbiter cannot repeatedly seek a recently recovered advancing TV',()=>{
    const l=decoderLab();l.wedge(0,10000);assert.equal(l.decoder.diagnostics().steps,1);
    let at=20000, pos=100, timer=0;const actions=[];
    const c={document:{hidden:false},performance:{now:()=>at},WatchFusionDecoderRescue:l.decoder};c.window=c.globalThis=c;
    for(const f of ['viewer-timing-math','viewer-release-evidence','viewer-sync-arbiter'])vm.runInNewContext(read('public/client/'+f+'.js'),c);
    const io={follower:true,hostLinked:false,linkedSourceActive:()=>true,tvIdentity:'ROOM:VIDEO:4',baseRate:1,now:()=>at,
      current:()=>pos,target:()=>pos+2.5,state:()=>1,availableRates:()=>[1],buffered:()=>true,referenceTrusted:()=>true,
      referenceUncertaintyMs:()=>25,sourceReferenceQualified:()=>true,sourceBuffering:()=>false,mirrorContradicted:()=>false,
      pause:()=>actions.push('pause'),seek:()=>actions.push('seek'),play:()=>actions.push('play'),rate:()=>actions.push('rate')};
    const arb=c.WatchFusionViewerSyncArbiter.createViewerSyncArbiter({timers:{setTimeout:()=>++timer,clearTimeout(){}}});
    const tick=()=>{arb.tick('ROOM:VIDEO:4:20',at,io);at+=250;pos+=.25;};
    for(;at<28000;)tick();assert.equal(actions.length,0,'fresh continuous motion dwell is required');
    for(;at<34000&&!arb.owns();)tick();assert.deepEqual(actions,['pause','seek']);
    arb.intent('pause',io);for(;at<60000;)tick();assert.deepEqual(actions,['pause','seek'],'one moderate-lag rejoin per recovery step');
  });
  await check('R14V-01:stable-170ms-decoder-timeline-heals-recovery-budget-only-after-one-minute',()=>{
    const l=decoderLab();l.exhaust();l.healthy(56000,131000);
    assert.equal(l.decoder.diagnostics().steps,0);
    assert.equal(l.decoder.diagnostics().healCount,1);
    assert.equal(l.decoder.diagnostics().outcome,'healed-advancing-stable-offset');
    assert.deepEqual(l.actions,['reload','rebuild'],'healing is not a seek/reload');
    assert.ok(l.notes.some(n=>n.type==='tv-decoder-recovered'&&n.value.offsetMs===-170));
  });
  await check('R14V-02:terminal-budget-remains-spent-during-the-first-45s-of-good-playback',()=>{
    const l=decoderLab();l.exhaust();l.healthy(56000,101000);
    assert.equal(l.decoder.diagnostics().steps,2);assert.equal(l.actions.length,2);
  });
  await check('R14V-03:frozen-playback-reports-do-not-heal-decoder-budget',()=>{
    const l=decoderLab();l.exhaust();l.healthy(56000,131000,()=>({position:100}));
    assert.equal(l.decoder.diagnostics().steps,2);assert.equal(l.decoder.diagnostics().healCount,0);
  });
  await check('R14V-04:unstable-or-wrong-phase-playback-cannot-heal',()=>{
    const l=decoderLab();l.exhaust();l.healthy(56000,131000,t=>({drift:(t%3000<1500?-.17:-.34)}));
    assert.equal(l.decoder.diagnostics().steps,2);
    const v=decoderLab();v.exhaust();v.healthy(56000,131000,()=>({drift:-.42}));
    assert.equal(v.decoder.diagnostics().steps,2);
  });
  await check('R14V-05:hidden-or-untrusted-source-cannot-heal',()=>{
    const l=decoderLab();l.exhaust();l.hide(true);l.healthy(56000,131000);assert.equal(l.decoder.diagnostics().steps,2);
    l.hide(false);l.healthy(131500,208000,t=>({trusted:false,sourceBuffering:true}));
    assert.equal(l.decoder.diagnostics().steps,2);
  });
  await check('R14V-06:one-healing-per-ten-minutes-no-recovery-loop',()=>{
    const l=decoderLab();l.exhaust();l.healthy(56000,131000);assert.equal(l.decoder.diagnostics().healCount,1);
    l.wedge(132000,187000);assert.equal(l.decoder.diagnostics().steps,2);
    assert.equal(l.actions.length,4);
    l.healthy(188000,264000);assert.equal(l.decoder.diagnostics().steps,2);
    assert.equal(l.decoder.diagnostics().healCount,1);assert.equal(l.actions.length,4);
  });
  await check('R14V-06B:long-pause-and-health-healing-share-one-extra-budget',()=>{
    const l=decoderLab();l.exhaust();
    l.decoder.observeTransport({scope:'ROOM:VIDEO:4:20',nowMs:80000,paused:true});
    assert.equal(l.decoder.observeTransport({scope:'ROOM:VIDEO:4:20',nowMs:160000,paused:false}),true);
    l.wedge(160000,215000);assert.equal(l.decoder.diagnostics().steps,2);
    l.healthy(216000,291000);
    assert.equal(l.decoder.diagnostics().steps,2);
    assert.equal(l.decoder.diagnostics().healCount,0);
  });
  await check('R14V-06C:Nova-old-iframe-owner-invalidated-before-decoder-rebuild',()=>{
    const order=[];
    const original={destroy:()=>order.push('destroy')};
    const ctx={window:{WatchFusionLinkedTrackOwnership:{invalidate:player=>{
      assert.equal(player,original);order.push('invalidate');}}},document:{hidden:false},
      ytPlayer:original,ytPlayerReady:true,playerPrimed:true,playerInitializing:true,
      ensurePlayer:(id,time)=>{assert.equal(id,'VIDEO');assert.equal(time,12);order.push('rebuild');},
      Number,Math,Date,console};
    vm.runInNewContext(read('public/client/tv-decoder-rescue.js'),ctx);
    ctx.window.WatchFusionDecoderRescue.rebuildPlayer('VIDEO',12);
    assert.deepEqual(order,['invalidate','destroy','rebuild']);
    assert.equal(ctx.ytPlayerReady,false);
  });
  await check('R14V-06D:failed-owner-invalidation-cannot-block-player-rebuild',()=>{
    const order=[];
    const ctx={window:{WatchFusionLinkedTrackOwnership:{invalidate:()=>{throw Error('old owner missing');}}},
      document:{hidden:false},ytPlayer:{destroy:()=>order.push('destroy')},
      ytPlayerReady:true,playerPrimed:true,playerInitializing:true,
      ensurePlayer:()=>order.push('rebuild'),Number,Math,Date,console};
    vm.runInNewContext(read('public/client/tv-decoder-rescue.js'),ctx);
    ctx.window.WatchFusionDecoderRescue.rebuildPlayer('VIDEO',12);
    assert.deepEqual(order,['destroy','rebuild']);
  });
  await check('R14V-07:Nov21-physical-plateau-median-and-jitter-stay-visible-not-zeroed',()=>{
    const l=logLab();let s;
    for(const [dt,host,tv,clock] of PHYSICAL_20261121_STEADY){
      l.advance(dt);
      s=l.observe([l.peer('host',host),l.peer('tv',tv,{sensor:{clockState:clock,clockBoundMs:34,heldMs:1,audibleOutput:'player',timelineState:'advancing',timelineRatePct:100}})]);
    }
    const spreads=PHYSICAL_20261121_STEADY.map(([,host,tv])=>host-tv).sort((a,b)=>a-b);
    assert.equal(spreads.length,44);
    assert.equal(spreads[0],159);assert.equal(spreads.at(-1),177);
    assert.equal((spreads[21]+spreads[22])/2,165.5);
    assert.equal(s.playbackPlateau.state,'stable-timeline-offset');
    assert.ok(s.playbackPlateau.medianSpreadMs>=160&&s.playbackPlateau.medianSpreadMs<=175);
    assert.ok(s.playbackPlateau.jitterMs<=25);
    assert.equal(s.playbackPlateau.speakerPhase,'not-measured');
    assert.ok(s.timelineSpreadMs>50);
    assert.notEqual(s.groupPhase,'aligned');
  });
  await check('R14V-08:no-stable-status-during-a-wedged-TV-startup',()=>{
    const l=logLab();let s;
    for(let n=0;n<10;n++){
      s=l.observe([l.peer('host',-5),l.peer('tv',-170-2800*n,{startupPhase:'decoder-stalled',recentCorrection:'viewer-stalled-while-playing'})]);
      l.advance(2800);
    }
    assert.equal(s.playbackPlateau.state,'insufficient-evidence');
    assert.equal(s.playbackPlateau.medianSpreadMs,null);
  });
  await check('R14V-09:brief-progress-cannot-be-misreported-as-long-term-stability',()=>{
    const l=logLab();let s;
    for(let n=0;n<4;n++){s=l.observe([l.peer('host',-5),l.peer('tv',-175)]);l.advance(2800);}
    assert.notEqual(s.playbackPlateau.state,'stable-timeline-offset');
  });
  await check('R14V-10:after-a-brief-stall-the-stability-window-must-requalify',()=>{
    const l=logLab();let s;
    for(let n=0;n<10;n++){s=l.observe([l.peer('host',-5),l.peer('tv',-175)]);l.advance(2800);}
    assert.equal(s.playbackPlateau.state,'stable-timeline-offset');
    s=l.observe([l.peer('host',-5),l.peer('tv',-175,{startupPhase:'decoder-stalled'})]);
    assert.equal(s.playbackPlateau.state,'insufficient-evidence');
    l.advance(2800);s=l.observe([l.peer('host',-5),l.peer('tv',-175)]);
    assert.notEqual(s.playbackPlateau.state,'stable-timeline-offset');
  });
  await check('R14V-11:thin-clock-can-prove-playback-motion-but-not-precision-lock',()=>{
    const l=uiLab();let cards;
    for(let n=0;n<4;n++){cards=l.render([l.peer('host',-5),l.peer('tv',-175,'thin')]);l.advance(750);}
    assert.match(cards[1].status,/Playback advancing.*thin-clock estimate/);
    assert.match(cards[1].metrics['Playback progression'],/Advancing/);
    assert.match(cards[0].metrics['Player-to-player timeline spread'],/170 ms.*provisional/);
    assert.doesNotMatch(cards[1].status,/Locked|aligned/);
  });
  await check('R14V-12:unsteady-clock-does-not-certify-player-progression',()=>{
    const l=uiLab();let cards;
    for(let n=0;n<4;n++){cards=l.render([l.peer('host',-5),l.peer('tv',-175,'unstable')]);l.advance(750);}
    assert.doesNotMatch(cards[1].status,/Playback advancing|Locked/);
    assert.match(cards[1].metrics['Playback progression'],/Not qualified/);
  });
  await check('R14V-13:single-player-source-only-does-not-invent-a-plateau',()=>{
    const l=logLab();let s;
    for(let n=0;n<10;n++){s=l.observe([l.peer('tv',-170)]);l.advance(2800);}
    assert.equal(s.playbackPlateau.state,'insufficient-evidence');
    assert.equal(s.playbackPlateau.speakerPhase,'not-measured');
  });
  await check('R14V-14:diagnostic-presentation-does-not-command-playback',()=>{
    for(const rel of ['public/client/sync-center.js','public/client/sync-room-log.js']){
      const source=read(rel);
      assert.doesNotMatch(source,/\.seekTo\(|\.playVideo\(|\.pauseVideo\(|\.setPlaybackRate\(|\.loadVideoById\(|\.control\(['"](?:seek|pause|play)/);
      assert.match(source,/not-measured|Not measured/);
    }
  });
}
