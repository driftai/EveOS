// R14w: source-first regression tests, not playback or acoustic calibration.
// Physical replay is redacted to timestamps, coarse song/segment IDs and qualified sensor fields.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath,pathToFileURL} from 'node:url';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const ROOT=process.env.WF_FALSIFIER_ROOT||path.resolve(HERE,'../../..');
const read=rel=>fs.readFileSync(path.join(ROOT,rel),'utf8');
const fixture=JSON.parse(fs.readFileSync(path.resolve(HERE,'../fixtures/20261121-long-run-redacted.json'),'utf8'));

function logLab(){
  let now=500000,meta={sampledAt:500000,tabMuted:true,paused:false,currentTime:0,rate:1};
  const el=()=>({value:'',open:false,textContent:'',addEventListener(){},focus(){},select(){}});
  const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,el());return nodes.get(id);};
  class ClockDate extends Date{static now(){return now;}}
  const ctx={document:{getElementById:get},navigator:{},roomId:'r',session:{memberId:'host',publicId:'host'},
    state:{presentationEpoch:1,playoutSegment:2,source:{videoId:'song1'},hostId:'host',linkedSourceActive:true,playback:{rate:1,paused:false,position:now/1000,projectedAt:now},members:[{id:'host',name:'Laptop-Side'},{id:'tv',name:'Tv-side'}]},
    performance:{now:()=>now},estimatedServerNow:()=>now,Date:ClockDate,JSON,Math,Number,Map,Set,Object,console};
  ctx.isHost=()=>true;ctx.watchFusionLinkedTab={active:()=>true,metadata:()=>meta};ctx.window=ctx;
  vm.runInNewContext(read('public/client/precision-policy.js'), ctx);
  vm.runInNewContext(read('public/client/sync-room-log.js'),ctx,{filename:'sync-room-log.js'});
  const peer=(member,error,extra={})=>({member,playoutSegment:ctx.state.playoutSegment,ready:true,playing:true,buffering:false,sampledAt:now-10,
    positionMs:now-10+(error??0),roomPositionMs:now-10,targetPositionMs:now-10,rate:1,mode:'youtube',
    sensor:{domain:'player-timeline',clockState:'bounded',clockBoundMs:15,heldMs:1,cadenceMs:50,audibleOutput:'player',timelineState:'advancing',timelineRatePct:100},
    startupPhase:'fine-locked',recentCorrection:'locked',...extra});
  const observe=(peers,options={})=>{
    ctx.watchFusionRoomSyncLog.observe(peers,{source:'live',reference:'linked-tab',sourceReferenceAt:now-80,uncertaintyMs:11,authorityBuffering:false,...options});
    return JSON.parse(ctx.watchFusionRoomSyncLog.export()).snapshots.at(-1);
  };
  const step=(ms,changes={})=>{now+=ms;meta={...meta,sampledAt:now,currentTime:meta.currentTime+ms/1000,...changes};};
  return {ctx,peer,observe,step,setTime:x=>{now=x;meta.sampledAt=now;},now:()=>now};
}
function runPlateau(gap,clock='bounded',motion='advancing'){
  const l=logLab();let s;
  for(let i=0;i<11;i++){
    s=l.observe([l.peer('host',0),l.peer('tv',gap,{sensor:{domain:'player-timeline',clockState:clock,clockBoundMs:33,heldMs:1,cadenceMs:50,audibleOutput:'player',timelineState:motion,timelineRatePct:100}})]);
    l.step(2800);
  }
  return {s,l};
}
function sensorLab(){
  const c={performance:{now:()=>0},Math,Number,Date,console};c.window=c;
  vm.runInNewContext(read('public/client/sensor-provenance.js'),c,{filename:'sensor-provenance.js'});
  return c.WatchFusionSensorProvenance;
}
export async function runR14wChecks(check){
  await check('R14W-01:fine-locked-peers-earn-stable-plateau-within-50',()=>{
    const {s}=runPlateau(7);
    assert.equal(s.playbackPlateau.state,'stable-timeline-offset');
    assert.equal(s.playbackPlateau.targetBand,'within-50');
    assert.equal(s.playbackPlateau.medianSpreadMs,7);
    assert.ok(s.playbackPlateau.observedMs>=20000);
    assert.equal(s.speakerPhase,'not-measured');
  });
  await check('R14W-02:stable-138ms-plateau-fully-reported-not-falsely-aligned',()=>{
    const {s}=runPlateau(138);
    assert.equal(s.playbackPlateau.state,'stable-timeline-offset');
    assert.equal(s.playbackPlateau.targetBand,'outside-50');
    assert.equal(s.playbackPlateau.medianSpreadMs,138);
    assert.equal(s.timelinePhase,'player-timelines-differ');
    assert.equal(s.peers.find(x=>x.role==='viewer').relativeToHostMs,138);
    assert.equal(s.playbackPlateau.speakerPhase,'not-measured');
  });
  await check('R14W-03:thin-clock-motion-can-be-stable-but-never-precise-aligned',()=>{
    const {s}=runPlateau(12,'thin');
    assert.equal(s.playbackPlateau.state,'stable-timeline-offset');
    assert.equal(s.groupPhase,'unmeasured-clock');
    assert.equal(s.timelineSpreadMs,12);
  });
  await check('R14W-04:held-slow-jumped-and-unverified-positions-cannot-earn-plateau',()=>{
    for(const state of ['held','slow','jumped','unverified']){
      const {s}=runPlateau(2,'bounded',state);
      assert.equal(s.playbackPlateau.state,'insufficient-evidence',state);
      assert.equal(s.playbackPlateau.samples,0,state);
    }
  });
  await check('R14W-05:discontinuous-motion-stale-source-or-unavailable-iframe-removes-stable-witness',()=>{
    const {l}=runPlateau(7);let s;
    s=l.observe([l.peer('host',0),l.peer('tv',7,{sensor:{clockState:'bounded',clockBoundMs:15,timelineState:'held',heldMs:800,audibleOutput:'player'}})]);
    assert.equal(s.playbackPlateau.state,'insufficient-evidence');
    for(let i=0;i<10;i++){s=l.observe([l.peer('host',0),l.peer('tv',7)],{source:'off-phase'});l.step(2800);}
    assert.equal(s.playbackPlateau.state,'insufficient-evidence');
    for(let i=0;i<10;i++){s=l.observe([l.peer('host',0),l.peer('tv',7,{playing:false,startupPhase:'decoder-stalled'})]);l.step(2800);}
    assert.equal(s.playbackPlateau.state,'insufficient-evidence');
  });
  await check('R14W-06:segment-change-requires-new-plateau-witnesses',()=>{
    const {l}=runPlateau(7);l.ctx.state.playoutSegment=3;
    const s=l.observe([l.peer('host',0),l.peer('tv',7)]);
    assert.notEqual(s.playbackPlateau.state,'stable-timeline-offset');
  });
  await check('R14W-07:host-recovery-not-needed-is-display-only-no-gate-change',()=>{
    const l=logLab();const healthy=l.observe([l.peer('host',2,{hostRecovery:{outcome:'no-healthy-peer-witness',hostErrorMs:2,stage:'observe',attempts:0}}),l.peer('tv',130)]);
    const host=healthy.peers.find(p=>p.role==='host');
    assert.equal(host.hostRecovery.outcome,'no-healthy-peer-witness');
    assert.equal(host.hostRecoveryMeaning,'not-needed-host-in-band');
    const off=l.observe([l.peer('host',190,{hostRecovery:{outcome:'no-healthy-peer-witness',hostErrorMs:190,stage:'observe'}}),l.peer('tv',130)]);
    assert.equal(off.peers.find(p=>p.role==='host').hostRecoveryMeaning,'no-qualified-peer-witness');
  });
  await check('R14W-08:Nova-timeline-motion-classifies-advancing-held-seek-and-video-reset',()=>{
    const p=sensorLab(),media={getVideoData:()=>({video_id:'a'}),getCurrentTime:()=>0,getPlayerState:()=>1,getPlaybackRate:()=>1,getVolume:()=>50,isMuted:()=>false};
    for(let t=0;t<=2400;t+=50)p.track(media,t,t/1000,true,1);
    const a=p.describe({media,now:2400,clock:{boundMs:10,ageMs:50,precise:true,samples:4,spreadMs:2}});
    assert.equal(a.timelineState,'advancing');assert.ok(a.timelineRatePct>=90&&a.timelineRatePct<=110);
    for(let t=2450;t<=4850;t+=50)p.track(media,t,2.4,true,1);
    const b=p.describe({media,now:4850});assert.equal(b.timelineState,'held');
    p.track(media,4900,99,true,1);assert.equal(p.describe({media,now:4900}).timelineState,'unverified');
    media.getVideoData=()=>({video_id:'b'});p.track(media,4950,0,true,1);
    assert.equal(p.describe({media,now:4950}).timelineState,'unverified');
  });
  await check('R14W-09:server-timeline-sanitizer-enums-rate-bounds-and-no-free-text',async()=>{
    const mod=await import(pathToFileURL(path.join(ROOT,'src/server/presentation-report-schema.js')).href);
    const a=mod.sanitizeSensor({domain:'player-timeline',timelineState:'advancing',timelineRatePct:99.4,clockState:'bounded',audibleOutput:'player'});
    assert.equal(a.timelineState,'advancing');assert.equal(a.timelineRatePct,99);
    const bad=mod.sanitizeSensor({timelineState:'<script>',timelineRatePct:500,domain:'https://bad.example',audibleOutput:'x'});
    assert.equal(bad.timelineState,'unverified');assert.equal(bad.timelineRatePct,null);assert.equal(bad.domain,null);
  });
  await check('R14W-10:backend-preserves-Nova-39-character-correction-reason-with-bounded-payload',()=>{
    const source=read('src/server/presentation-routes.js');
    assert.match(source,/maxBytes: 2560/);
    assert.match(source,/recentCorrection:.*\{1,42\}/);
    assert.doesNotMatch(source,/maxBytes:\s*(?:Infinity|1e6)/);
    const allow=/^[a-z-]{1,42}$/;
    assert.equal(allow.test('viewer-landing-source-evidence-unverified'),true);
    assert.equal(allow.test('x'.repeat(60)),false);
  });
  await check('R14W-11:real-180-snapshot-Nov21-replay-recognizes-outside-band-and-two-recovered-locks',()=>{
    const l=logLab(),out=[];let last=0, prevSong=null;
    for(const r of fixture.data){
      const [dt,song,segment,ref,source,buffering,sourceAge,uncertainty,hp,hb,he,hphase,hclock,hbound,hheld,hout,tp,tb,te,tphase,tclock,tbound,theld,tout]=r;
      const delta=dt-last;if(delta<0)throw Error('unsorted fixture');l.step(delta);last=dt;
      l.ctx.state.playoutSegment=segment;
      if(song!==prevSong){l.ctx.state.source.videoId='song'+song;prevSong=song;}
      const make=(member,playing,buffer,error,phase,clock,bound,held,output)=>l.peer(member,error,{playing:playing===true,buffering:buffer===true,ready:!!phase,startupPhase:phase,
        sampledAt:l.now()-10,sensor:{domain:'player-timeline',clockState:clock||'unknown',clockBoundMs:bound??null,heldMs:held??null,audibleOutput:output||'unknown',
        // R14v did not measure motion rate: conditional replay of R14w motion=advancing, NOT an observed field.
        timelineState:playing&&['fine-locked','decoder-confirmed'].includes(phase)&&held!=null&&held<=25?'advancing':'unverified'},recentCorrection:phase==='fine-locked'?'locked':phase==='decoder-confirmed'?'output-phase-unverified':'viewer-warming-after-play'});
      const peers=[make('host',hp,hb,he,hphase,hclock,hbound,hheld,hout),make('tv',tp,tb,te,tphase,tclock,tbound,theld,tout)];
      const s=l.observe(peers,{reference:ref,source,authorityBuffering:buffering,sourceReferenceAt:l.now()-(sourceAge??10000),uncertaintyMs:uncertainty??11});
      out.push([song,s.playbackPlateau?.state,s.playbackPlateau?.targetBand,s.playbackPlateau?.medianSpreadMs]);
    }
    assert.equal(fixture.data.length,180);
    assert.ok(out.some(([song,state,band,median])=>song===11&&state==='stable-timeline-offset'&&band==='outside-50'&&median>=120));
    assert.ok(out.some(([song,state,band,median])=>song===12&&state==='stable-timeline-offset'&&band==='within-50'&&median<=50));
    assert.ok(out.some(([song,state,band,median])=>song===13&&state==='stable-timeline-offset'&&band==='within-50'&&median<=50));
  });
  await check('R14W-12:diagnostics-do-not-issue-any-seeks-mutes-loads-or-rate-controls',()=>{
    for(const rel of ['public/client/sensor-provenance.js','public/client/sync-room-log.js','public/client/sync-center.js']){
      const source=read(rel);
      assert.doesNotMatch(source,/\.seekTo\(|\.loadVideoById\(|\.playVideo\(|\.pauseVideo\(|\.setPlaybackRate\(|\.mute\(|\.unMute\(/);
    }
    assert.equal(fixture.description.includes('URLs'),true);
  });
}
