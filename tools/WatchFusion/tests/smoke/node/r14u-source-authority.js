// R14u: read-only playback vs audible-output/source-ownership falsifiers.
// Real production modules in VM. No browser audio or physical speaker timing asserted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const ROOT=process.env.WF_FALSIFIER_ROOT||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','..','..');
const read=p=>fs.readFileSync(path.join(ROOT,p),'utf8');

function uiLab(){
  let now=200000, metadata={sampledAt:now,currentTime:20,rate:1,paused:false,tabMuted:true};
  const node=tag=>({tag,className:'',textContent:'',hidden:false,open:false,children:[],append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},setAttribute(){},addEventListener(){}});
  const elements=new Map(),lookup=id=>{if(!elements.has(id))elements.set(id,node('div'));return elements.get(id);};
  class ClockDate extends Date {static now(){return now;}}
  const ctx={$:lookup,document:{createElement:node,activeElement:null},
    state:{presentationEpoch:1,playoutSegment:2,source:{videoId:'song2'},playback:{rate:1,paused:false,position:now/1000,projectedAt:now},linkedSourceActive:true,hostId:'host'},
    session:{publicId:'host'},estimatedServerNow:()=>now,isHost:()=>true,Date:ClockDate,Math,Number,Map,Set,JSON,Object,console};
  ctx.watchFusionPlayout={status:()=>({source:'live',reference:'linked-tab',sourceReferenceAt:now-60,uncertaintyMs:11,authorityBuffering:false}),sourceErrorMs:()=>-20};
  ctx.watchFusionLinkedTab={active:()=>true,metadata:()=>metadata};ctx.window=ctx;
  vm.runInNewContext(read('public/client/precision-policy.js'), ctx);
  vm.runInNewContext(read('public/client/sync-center.js'),ctx,{filename:'sync-center.js'});
  const peers=(id,offset,extra={})=>({member:id,playoutSegment:ctx.state.playoutSegment,ready:true,playing:true,buffering:false,sampledAt:now,
    positionMs:now+offset,roomPositionMs:now,targetPositionMs:now,rate:1,
    sensor:{clockState:'bounded',clockBoundMs:7,audibleOutput:'player'},startupPhase:'decoder-confirmed',recentCorrection:'locked',...extra});
  const render=items=>{const list=node('ul');ctx.watchFusionSyncCenter.renderPeers(list,items,[{id:'host',name:'Laptop'},{id:'tv',name:'TV'}]);return list.children.map(card=>({
    status:card.children[0].children[1].textContent,metrics:Object.fromEntries(card.children[1].children.map(m=>[m.children[0].textContent,m.children[1].textContent]))}));};
  return {render,peers,setMetadata:value=>metadata=value,advance:ms=>{now+=ms;metadata={...metadata,sampledAt:now,currentTime:metadata.currentTime+ms/1000};},now:()=>now,ctx};
}
function logLab(){
  let now=200000,metadata={sampledAt:now,currentTime:40,rate:1,paused:false,tabMuted:true};
  const node=()=>({value:'',open:false,textContent:'',addEventListener(){},focus(){},select(){}});
  const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
  class ClockDate extends Date{static now(){return now;}}
  const ctx={document:{getElementById:get},navigator:{},roomId:'room',session:{memberId:'host',publicId:'host'},
    state:{presentationEpoch:1,playoutSegment:2,hostId:'host',linkedSourceActive:true,playback:{rate:1,paused:false,position:now/1000,projectedAt:now},
      members:[{id:'host',name:'Laptop'},{id:'tv',name:'TV'}]},
    performance:{now:()=>now},estimatedServerNow:()=>now,Date:ClockDate,JSON,Math,Number,Map,Set,Object,console};
  ctx.watchFusionLinkedTab={active:()=>true,metadata:()=>metadata};ctx.isHost=()=>true;ctx.window=ctx;
  vm.runInNewContext(read('public/client/precision-policy.js'), ctx);
  vm.runInNewContext(read('public/client/sync-room-log.js'),ctx,{filename:'sync-room-log.js'});
  const peer=(member,offset,extra={})=>({member,playoutSegment:ctx.state.playoutSegment,ready:true,playing:true,buffering:false,sampledAt:now-10,
    positionMs:now-10+offset,roomPositionMs:now-10,targetPositionMs:now-10,rate:1,sensor:{clockState:'bounded',clockBoundMs:8,heldMs:0,audibleOutput:'player'},
    startupPhase:'decoder-confirmed',recentCorrection:'locked',...extra});
  const observe=rows=>{ctx.watchFusionRoomSyncLog.observe(rows,{source:'live',reference:'linked-tab',sourceReferenceAt:now-60,uncertaintyMs:11,authorityBuffering:false});
    return JSON.parse(ctx.watchFusionRoomSyncLog.export()).snapshots.at(-1);};
  const exportText=()=>ctx.watchFusionRoomSyncLog.export();
  return {peer,observe,exportText,advance:ms=>{now+=ms;metadata={...metadata,sampledAt:now,currentTime:metadata.currentTime+ms/1000};},now:()=>now,setMetadata:m=>metadata=m,ctx};
}
export async function runR14uChecks(check){
  await check('R14U-01:one-room-player-is-not-a-false-unsynchronized-status',()=>{
    const l=uiLab();const c=l.render([l.peers('host',-3)]);
    assert.match(c[0].metrics['Player-to-player timeline spread'],/N\/A · single room player/);
    assert.match(c[0].metrics['Linked source reference'],/Live, bounded timeline/);
    assert.doesNotMatch(c[0].metrics['Player-to-player timeline spread'],/need two advancing/);
  });
  await check('R14U-02:linked-source-progression-qualifies-without-second-room-player',()=>{
    const l=uiLab();l.render([l.peers('host',-3)]);
    l.advance(700);l.render([l.peers('host',-3)]);
    l.advance(800);const c=l.render([l.peers('host',-3)]);
    assert.match(c[0].metrics['Linked source progression'],/advancing/);
    assert.match(c[0].metrics['Player-to-player timeline spread'],/single room player/);
  });
  await check('R14U-03:unembeddable-host-does-not-mean-source-or-room-is-paused',()=>{
    const l=uiLab();l.setMetadata({...l.ctx.watchFusionLinkedTab.metadata(),tabMuted:false});
    const c=l.render([l.peers('host',-12000,{ready:false,playing:false,startupPhase:'awaiting-play'}),l.peers('tv',-440)]);
    assert.match(c[0].status,/Host player inactive · linked source live/);
    assert.match(c[0].metrics['Host audio route'],/Source-tab fallback/);
  });
  await check('R14U-04:muted-native-tab-and-live-host-player-are-separated-from-timing',()=>{
    const l=uiLab(),c=l.render([l.peers('host',-2)]);
    assert.match(c[0].metrics['Linked source tab mute'],/confirmed/);
    assert.match(c[0].metrics['Host audio route'],/Room player/);
    assert.match(c[0].metrics['Player vs room target (not audio)'],/Unverified/);
  });
  await check('R14U-05:unmuted-tab-with-active-host-is-explicit-double-audio-risk',()=>{
    const l=uiLab();l.setMetadata({...l.ctx.watchFusionLinkedTab.metadata(),tabMuted:false});
    const c=l.render([l.peers('host',-2)]);
    assert.match(c[0].metrics['Linked source tab mute'],/NOT MUTED/);
    assert.match(c[0].metrics['Host audio route'],/DOUBLE AUDIO RISK/);
  });
  await check('R14U-06:source-mute-proof-expires-rather-than-claiming-verified-forever',()=>{
    const l=uiLab();const m=l.ctx.watchFusionLinkedTab.metadata();l.setMetadata({...m,sampledAt:l.now()-8000});
    const c=l.render([l.peers('host',-2)]);
    assert.match(c[0].metrics['Linked source tab mute'],/Unverified/);
    assert.match(c[0].metrics['Host audio route'],/unverified/);
    assert.doesNotMatch(c[0].metrics['Linked source progression'],/advancing/);
  });
  await check('R14U-07:song2-40ms-video-gap-is-not-reported-as-players-disagree',()=>{
    const l=logLab(),s=l.observe([l.peer('host',-8),l.peer('tv',-48)]);
    assert.equal(s.groupPhase,'aligned');assert.equal(s.groupSpreadMs,40);
    assert.equal(s.timelineSpreadMs,40);assert.equal(s.timelinePhase,'player-timelines-within-50');
  });
  await check('R14U-08:source-tab-audible-host-timeline-remains-measurable-but-not-audio-witness',()=>{
    const l=logLab(),s=l.observe([l.peer('host',-8,{sensor:{clockState:'bounded',clockBoundMs:8,audibleOutput:'source-tab'}}),l.peer('tv',-48)]);
    assert.equal(s.timelineSpreadMs,40);assert.equal(s.timelinePlayerCount,2);
    assert.equal(s.groupPhase,'unmeasured-single-player');assert.equal(s.outputs,'source-tab-audible');
    assert.equal(s.speakerPhase,'not-measured');
  });
  await check('R14U-09:log-recognizes-source-only-host-audio-fallback-and-keeps-TV-ms-offset',()=>{
    const l=logLab();l.setMetadata({...l.ctx.watchFusionLinkedTab.metadata(),tabMuted:false});
    const s=l.observe([l.peer('host',-20000,{playing:false,ready:false,startupPhase:'awaiting-play'}),l.peer('tv',-440)]);
    assert.equal(s.linkedSourceEvidence.audioRoute,'source-tab-fallback');
    assert.equal(s.linkedSourceEvidence.tabMuted,false);assert.equal(s.linkedSourceEvidence.mode,'live-linked-source');
    assert.equal(s.timelinePlayerCount,1);assert.equal(s.groupSpreadMs,null);
    assert.equal(s.peers.find(p=>p.device==='TV').targetErrorMs,-440);
  });
  await check('R14U-10:log-identifies-double-audio-risk-without-auto-muting',()=>{
    const l=logLab();l.setMetadata({...l.ctx.watchFusionLinkedTab.metadata(),tabMuted:false});
    const s=l.observe([l.peer('host',-5),l.peer('tv',-8)]);
    assert.equal(s.linkedSourceEvidence.audioRoute,'double-audio-risk');
  });
  await check('R14U-11:stale-mute-confirmation-becomes-unverified-in-export',()=>{
    const l=logLab();l.setMetadata({...l.ctx.watchFusionLinkedTab.metadata(),sampledAt:l.now()-7000,tabMuted:true});
    const s=l.observe([l.peer('host',-5)]);
    assert.equal(s.linkedSourceEvidence.tabMuted,null);
    assert.equal(s.linkedSourceEvidence.audioRoute,'unverified');
  });
  await check('R14U-12:stalled-decoder-cannot-be-counted-as-a-healthy-source-timeline-peer',()=>{
    const l=logLab();const s=l.observe([l.peer('host',-5),l.peer('tv',-21000,{startupPhase:'decoder-stalled',recentCorrection:'stall-recovery-exhausted'})]);
    assert.equal(s.timelinePlayerCount,1);assert.equal(s.timelineSpreadMs,null);
    assert.equal(s.peers[1].targetErrorMs,null);assert.equal(s.peers[1].rawOffsetMs,-21000);
  });
  await check('R14U-13:export-redacts-source-url-and-mute-events-remain-discrete-data',()=>{
    const l=logLab();l.setMetadata({...l.ctx.watchFusionLinkedTab.metadata(),pageUrl:'https://secret.example/token/ABC',tabMuted:false});
    l.observe([l.peer('host',-5)]);const raw=l.exportText();
    assert.equal(JSON.parse(raw).diagnosticsVersion,'v13.10.8x-room-recovery');
    assert.match(raw,/"tabMuted": false/);
    assert.doesNotMatch(raw,/secret\.example|token\/ABC/);
  });
  await check('R14U-14:status-code-is-read-only-and-does-not-claim-sub-ms-speaker-precision',()=>{
    for(const source of [read('public/client/sync-center.js'),read('public/client/sync-room-log.js')]){
      assert.doesNotMatch(source,/\.seekTo\(|\.playVideo\(|\.pauseVideo\(|\.setPlaybackRate\(|\.loadVideoById\(|\.control\(['"](?:seek|pause|play)/);
      assert.match(source,/speaker|Speaker/);
    }
  });
}
