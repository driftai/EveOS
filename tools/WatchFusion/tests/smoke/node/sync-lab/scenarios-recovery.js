// Real-trace regressions (Nov 15, 2026 physical TV + laptop runs): natural
// starts where YouTube reported PLAYING while the timeline stayed frozen, so the
// startup gate warmed forever and both viewers fell ~1 s/s behind the room.
import { createRoomLab, summarize } from './room-lab.js';
import { PROFILES } from './fake-youtube.js';
import fs from 'node:fs';
import vm from 'node:vm';

async function pair() {
  const lab = await createRoomLab();
  const t0 = lab.clock.now();
  const laptop = lab.addViewer('laptop', PROFILES.laptop);
  const tv = lab.addViewer('tv', PROFILES.fixedTv, {offsetSec: 1.2});
  return {lab, t0, laptop, tv, at: s => t0 + s * 1000};
}
const arbiterOf = device => device.diagnostics()?.arbiter || {};
const settled = (device, from, to, p95 = 200) => { const s = summarize(device, from, to); return {ok: s.p95AbsMs <= p95, summary: s}; };

// Exercise the actual arbiter, including callbacks delivered after cancellation.
function deadlineFixture({host=false, background=false}={}) {
  let now=0, pos=29, playing=true, valid=true, speed=1; const timers=[],ops=[];
  const ctx={Math,Number,JSON,Map,Set,console,performance:{now:()=>now}};ctx.window=ctx.globalThis=ctx;
  ctx.setTimeout=(fn,ms)=>{timers.push({fn,due:now+ms});return timers.length;};ctx.clearTimeout=()=>{};
  for(const script of ['viewer-release-evidence','viewer-timing-math','host-seek-policy','viewer-sync-arbiter'])vm.runInNewContext(fs.readFileSync(new URL('../../../../public/client/'+script+'.js',import.meta.url),'utf8'),ctx);
  const arb=ctx.WatchFusionViewerSyncArbiter.createViewerSyncArbiter({timers:{setTimeout:ctx.setTimeout,clearTimeout:ctx.clearTimeout}});
  const io={baseRate:1,hostLinked:host,follower:!host,linkedSourceActive:()=>true,background:()=>background,valid:()=>valid,
    now:()=>now,target:()=>30+now/1000,current:()=>pos,state:()=>playing?1:2,availableRates:()=>[1],buffered:()=>true,
    referenceTrusted:()=>true,sourceReferenceQualified:()=>true,hostFineHoldTrusted:()=>true,referenceUncertaintyMs:()=>10,
    sourceBuffering:()=>false,mirrorContradicted:()=>false,seek:p=>{pos=p;ops.push('seek');},pause:()=>{playing=false;ops.push('pause');},play:()=>{playing=true;ops.push('play');},rate:r=>{speed=r;ops.push('rate:'+r);}};
  const scope='room:video:epoch:1'; const at=t=>{if(playing)pos+=(t-now)/1000*speed;now=t;};
  arb.tick(scope,now,io);
  return {arb,io,timers,ops,at,scope,playing:()=>playing,invalidate:()=>valid=false};
}

export const RECOVERY_SCENARIOS = {
  async 'SYNC-52:failed TV reload escalates promptly after transition while both healthy members keep playing'() {
    const lab=await createRoomLab({seed:62,sourceNoiseMs:0,fineTrim:true});
    try {
      const host=lab.addViewer('host',PROFILES.laptop), phone=lab.addViewer('phone',PROFILES.phone);
      const tv=lab.addViewer('tv',{...PROFILES.variableTv,keyframeSec:0,quantumMs:0,startLatencyMs:0});
      tv.ctx.playerPrimed=true;
      let start=0;const actions=[];
      tv.player.loadVideoById=()=>{actions.push(['reload',lab.clock.now()-start]);tv.player.wedge('never');};
      tv.ctx.ensurePlayer=(id,pos)=>{actions.push(['rebuild',lab.clock.now()-start]);tv.player.setTrack(id);tv.player.jump(pos);tv.ctx.ytPlayer=tv.player;tv.ctx.ytPlayerReady=true;};
      await lab.run(12000);lab.nextTrack('VideoB00001');tv.player.wedge('never');start=lab.clock.now();
      await lab.run(75000);
      const summaries=[host,phone,tv].map(d=>summarize(d,start+35000,lab.clock.now()));
      const healthy=[host,phone].map(d=>({seeks:d.player.stats.seeks,loads:d.player.stats.loads,pauses:d.player.stats.pauses}));
      const tails=[host,phone,tv].map(d=>d.samples.filter(s=>s.at>=start+35000));
      const gap=Math.max(...tails[0].map((s,i)=>Math.max(Math.abs(s.errorMs-tails[1][i].errorMs),Math.abs(s.errorMs-tails[2][i].errorMs))));
      const detail={actions,summaries,healthy,gap,tvSeeks:tv.player.stats.seeks};
      return {ok:actions.length===2&&actions[0][0]==='reload'&&actions[1][0]==='rebuild'&&actions[1][1]<=32000&&actions[1][1]-actions[0][1]<=9000&&summaries.every(s=>s.samples>=150&&s.maxAbsMs<=50&&s.frozenMs===0)&&gap<=50&&healthy.every(h=>h.seeks===0&&h.loads===1&&h.pauses===0)&&tv.player.stats.seeks<=2,detail};
    } finally {lab.close();}
  },

  async 'SYNC-50:per-video summaries retain unready and unsynchronized outcomes after detail expiry'() {
    let now=1700000000000;const elem={value:'',textContent:'',open:false,addEventListener(){}};
    class ClockDate extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
    const ctx={Date:ClockDate,document:{getElementById:()=>elem},performance:{now:()=>now},estimatedServerNow:()=>now,roomId:'room',session:{memberId:'h'},isHost:()=>true,state:{source:{videoId:'A',title:'First'},presentationEpoch:1,playoutSegment:1,hostId:'h',playback:{rate:1,position:60,projectedAt:now-10},members:[{id:'h',name:'Host'},{id:'tv',name:'TV'}]}};ctx.window=ctx.globalThis=ctx;
    vm.runInNewContext(fs.readFileSync(new URL('../../../../public/client/precision-policy.js',import.meta.url),'utf8'),ctx);
    vm.runInNewContext(fs.readFileSync(new URL('../../../../public/client/sync-room-log.js',import.meta.url),'utf8'),ctx);
    const log=ctx.watchFusionRoomSyncLog,peer=(member,error)=>({member,playoutSegment:ctx.state.playoutSegment,sampledAt:now-10,positionMs:60000+now-10-ctx.state.playback.projectedAt+error,roomPositionMs:60000+now-10-ctx.state.playback.projectedAt,targetPositionMs:60000+now-10-ctx.state.playback.projectedAt,ready:true,playing:true,buffering:false,rate:1,rttMs:10,audible:true,sensor:{domain:'player-timeline',heldMs:0,audibleOutput:'player',clockBoundMs:6,clockState:'bounded',timelineState:'advancing'}});
    const observe=rows=>log.observe(rows,{reference:'linked-tab',source:'live',sourceReferenceAt:now-20},{members:2,reporting:rows.length});
    observe([peer('h',0),peer('tv',20)]);now+=5000;observe([peer('h',0)]);now+=5000;observe([peer('h',0),peer('tv',230)]);
    now+=1800001;ctx.state.source={videoId:'B',title:'Second'};ctx.state.playoutSegment++;observe([peer('h',0),peer('tv',0)]);
    const r=JSON.parse(log.export()),t=r.trackSummaries?.[0];return {ok:r.snapshots.length===1&&r.trackSummaries?.length===2&&t.samples===3&&t.within50===1&&t.qualifiedWithin50===1&&t.unready===1&&t.unmeasured===1&&t.above100===1,detail:{retained:r.snapshots.length,first:t}};
  },
  async 'SYNC-46:interrupted decoder progress is not a verified release'() {
    const ctx={};ctx.window=ctx.globalThis=ctx;vm.runInNewContext(fs.readFileSync(new URL('../../../../public/client/viewer-release-evidence.js',import.meta.url),'utf8'),ctx);
    function run(interrupt){const e=ctx.WatchFusionReleaseEvidence.createReleaseEvidence();let pos=20,state=1;e.start(0);const io={state:()=>state,current:()=>pos,baseRate:1,referenceTrusted:()=>true,sourceBuffering:()=>false};
      for(let t=200;t<=2600;t+=200){state=interrupt&&t===1000?3:1;if(state===1)pos+=.2;e.observe(t,io);}
      return e.qualified({releaseVerified:true,releasedAt:0},2600);}
    const clean=run(false),interrupted=run(true);return {ok:clean&&!interrupted,detail:{clean,interrupted}};
  },
  async 'SYNC-47:hidden host rejects expired linked reference and reacquires without a seek'() {
    const lab=await createRoomLab({seed:47,sourceNoiseMs:0,fineTrim:true});const h=lab.addViewer('host',PROFILES.laptop),tv=lab.addViewer('tv',{...PROFILES.variableTv,quantumMs:0});try{
      h.ctx.document.hidden=true;await lab.run(5000);const fresh=h.ctx.watchFusionPlayout.status()?.reference==='linked-tab';
      lab.linkedSource(false);await lab.run(5000);const stale=h.ctx.watchFusionPlayout.status();
      lab.linkedSource(true);await lab.run(5000);const restored=h.ctx.watchFusionPlayout.status()?.reference==='linked-tab';
      const detail={fresh,expired:stale===null,restored,hostSeeks:h.player.stats.seeks,tvSeeks:tv.player.stats.seeks,spread:Math.abs(h.errorMs()-tv.errorMs())};
      return {ok:fresh&&stale===null&&restored&&detail.hostSeeks===0&&detail.tvSeeks===0&&detail.spread<=50,detail};
    }finally{lab.close();}
  },
  async 'SYNC-48:host terminal decoder rescue restores playback without disturbing a healthy TV'() {
    const lab=await createRoomLab({seed:48,sourceNoiseMs:0,fineTrim:true});const h=lab.addViewer('host',PROFILES.laptop),tv=lab.addViewer('tv',{...PROFILES.variableTv,quantumMs:0});try{
      await lab.run(20000);const at=lab.clock.now(), before=tv.player.stats.seeks;
      h.player.wedge('never');const load=h.player.loadVideoById.bind(h.player);h.player.loadVideoById=(args)=>{h.player.wedge('never',0);load(args);};
      await lab.run(70000);const a=h.samples.filter(x=>x.at>=at+50000),b=tv.samples.filter(x=>x.at>=at+50000),healthy=tv.samples.filter(x=>x.at>=at);
      const detail={hostLoads:h.player.stats.loads,hostSeeks:h.player.stats.seeks,tvSeeks:tv.player.stats.seeks-before,tvLoads:tv.player.stats.loads,hostMax:Math.max(...a.map(x=>Math.abs(x.errorMs))),roomMax:Math.max(...a.map((x,j)=>Math.abs(x.errorMs-b[j].errorMs))),bad:a.filter(x=>x.frozen||x.state!==1).length,tvBad:healthy.filter(x=>x.frozen||x.state!==1||Math.abs(x.errorMs)>50).length};
      return {ok:detail.hostLoads===1&&detail.hostSeeks<=5&&detail.tvSeeks===0&&detail.tvLoads===0&&detail.hostMax<=50&&detail.roomMax<=50&&detail.bad===0&&detail.tvBad===0,detail};
    }finally{lab.close();}
  },
  async 'SYNC-49:coherent fresh mirror samples tolerate slower cadence without weakening source identity'() {
    let now=10000;const c={segment:1,sourcePhaseMs:4,phaseMs:4,anchorAt:now,anchorPositionMs:30000,rate:1};const ctx={Date:{now:()=>now},performance:{now:()=>now},estimatedServerNow:()=>now,watchFusionPlayout:{status:()=>c,hasSourceReference:()=>true}};ctx.window=ctx.globalThis=ctx;
    vm.runInNewContext(fs.readFileSync(new URL('../../../../public/client/mirror-convergence-gate.js',import.meta.url),'utf8'),ctx);
    const gate=ctx.WatchFusionMirrorConvergenceGate,plan={publish:true,reason:'drift',drift:1.1},sample=(age=0)=>({pageUrl:'p',sampledAt:now-age,currentTime:30.004+(now-age-10000)/1000,rate:1});
    gate.defer(plan,sample(),'p');const first=gate.rebase(plan,sample(),'p');now+=1200;const coherent=gate.rebase(plan,sample(),'p');gate.defer(plan,sample(),'p');gate.rebase(plan,sample(),'p');now+=1200;const stale=gate.rebase(plan,sample(600),'p');
    return {ok:!first&&coherent&&!stale&&gate.diagnostics().published===0,detail:{first,coherent,stale}};
  },
  async 'SYNC-43:late or stale rejoin callbacks cannot certify or restart the wrong player'() {
    const late=deadlineFixture();late.arb.rejoinNow(0,late.io,'manual');
    late.at(100);late.arb.tick(late.scope,100,late.io);late.at(200);late.arb.tick(late.scope,200,late.io);
    const timer=late.timers.at(-1);if(!timer)return {ok:false,detail:{reason:'no scheduled release'}};
    late.at(timer.due+700);timer.fn();const lateState=late.arb.snapshot();
    const stale=deadlineFixture();stale.arb.rejoinNow(0,stale.io,'manual');stale.at(100);stale.arb.tick(stale.scope,100,stale.io);stale.at(200);stale.arb.tick(stale.scope,200,stale.io);
    const old=stale.timers.at(-1);stale.invalidate();stale.at(old.due+600);old.fn();
    const detail={lateReason:lateState.reason,latePlaying:late.playing(),postRelease:lateState.postRelease,staleOps:stale.ops,staleOwned:stale.arb.owns()};
    return {ok:late.playing()&&lateState.reason==='release-deadline-missed'&&!lateState.postRelease&&!stale.ops.includes('play')&&!stale.arb.owns(),detail};
  },
  async 'SYNC-44:qualified hidden host recovery never schedules a timed pause and has one seek per video'() {
    const h=deadlineFixture({host:true,background:true});const first=h.arb.rejoinNow(0,h.io,'host-source');
    h.at(1000);h.arb.tick('room:video:epoch:2',1000,h.io);h.io.current=()=>0;
    const second=h.arb.rejoinNow(1000,h.io,'host-source');
    return {ok:first&&!second&&h.playing()&&h.ops.join(',')==='seek'&&h.timers.length===0,detail:{first,second,ops:h.ops,reason:h.arb.snapshot().reason}};
  },
  async 'SYNC-45:background linked host retains only fresh timing and short videos reacquire both players'() {
    const lab=await createRoomLab({seed:45,sourceNoiseMs:0,fineTrim:true});
    const host=lab.addViewer('host',PROFILES.laptop),tv=lab.addViewer('tv',{...PROFILES.variableTv,quantumMs:0});
    const tracks=[];try {
      for(let i=0;i<3;i++) {
        if(i)lab.nextTrack('WF06H-track-'+i);
        const t0=lab.clock.now(), hs=host.player.stats.seeks, vs=tv.player.stats.seeks;
        host.ctx.document.hidden=true;host.ctx.document.visibilityState='hidden';
        // Clamp client timeouts while the player/clock continue independently.
        host.ctx.setTimeout=(fn,ms)=>lab.clock.setTimeout(fn,Math.ceil((lab.clock.now()+Math.max(0,ms))/1000)*1000-lab.clock.now());
        await lab.run(5000);const fresh=host.ctx.watchFusionPlayout.status()?.reference==='linked-tab';
        host.player.wedge('seek');
        await lab.run(25000);const hiddenError=Math.abs(host.errorMs());
        host.ctx.document.hidden=false;host.ctx.document.visibilityState='visible';host.ctx.setTimeout=lab.clock.setTimeout;
        await lab.run(150000);
        const a=host.samples.filter(x=>x.at>=t0+45000),b=tv.samples.filter(x=>x.at>=t0+45000);
        const detail={fresh,hiddenError,maxHost:Math.max(...a.map(x=>Math.abs(x.errorMs))),maxTv:Math.max(...b.map(x=>Math.abs(x.errorMs))),maxSpread:Math.max(...a.map((x,j)=>Math.abs(x.errorMs-b[j].errorMs))),bad:a.concat(b).filter(x=>x.frozen||x.state!==1).length,hostSeeks:host.player.stats.seeks-hs,tvSeeks:tv.player.stats.seeks-vs,samples:a.length};tracks.push(detail);
      }
      return {ok:tracks.every(t=>t.fresh&&t.hiddenError<=700&&t.maxHost<=50&&t.maxTv<=50&&t.maxSpread<=50&&t.bad===0&&t.hostSeeks<=3&&t.tvSeeks<=1&&t.samples>=540),detail:{tracks}};
    }finally{lab.close();}
  },

  async 'SYNC-42:rate-capable TV waits for qualified timing instead of seeking into a decoder freeze'() {
    const lab=await createRoomLab({seed:42,sourceNoiseMs:0,fineTrim:true});
    const store=new Map([['watchfusion.viewerSyncModel.v1',JSON.stringify({rateHonored:false,rateRejections:2,rateGain:.71})]]);
    const host=lab.addViewer('host',PROFILES.laptop);
    const tv=lab.addViewer('tv',{...PROFILES.variableTv,quantumMs:0},{offsetSec:.648,store});
    const start=lab.clock.now(), playout=tv.ctx.watchFusionPlayout, qualified=playout.hasSourceReference;
    // The source timeline still advances; authority qualification is delayed/intermittent.
    playout.hasSourceReference=(...a)=>lab.clock.now()-start>=12000&&qualified(...a);
    tv.player.freezeAfterNextSeeks(6,120000);
    try {
      await lab.run(12000);const early={seeks:tv.player.stats.seeks,rates:tv.player.stats.rateRequests.filter(r=>r!==1).length};
      await lab.run(48000);
      const h=host.samples.filter(s=>s.at>=start+25000), v=tv.samples.filter(s=>s.at>=start+25000);
      const gap=Math.max(...h.map((s,i)=>Math.abs(s.errorMs-v[i].errorMs)));
      const detail={early,gap,hostMax:Math.max(...h.map(s=>Math.abs(s.errorMs))),tvMax:Math.max(...v.map(s=>Math.abs(s.errorMs))),seeks:tv.player.stats.seeks,loads:tv.player.stats.loads,hostSeeks:host.player.stats.seeks,rates:tv.player.stats.rateRequests,frozen:v.filter(s=>s.frozen||s.state!==1).length};
      return {ok:early.seeks===0&&early.rates===0&&gap<=50&&detail.hostMax<=25&&detail.tvMax<=50&&detail.seeks===0&&detail.loads===0&&detail.hostSeeks===0&&detail.frozen===0&&tv.player.getPlaybackRate()===1,detail};
    } finally {lab.close();}
  },
  async 'SYNC-41:resume with 533ms host and 600ms TV latency regains fine lock without seeks'() {
    const lab=await createRoomLab({seed:41,sourceNoiseMs:0,fineTrim:true});
    const saved=()=>new Map([['watchfusion.viewerSyncModel.v1',JSON.stringify({rateHonored:false,rateRejections:2,rateGain:.71})]]);
    try {
      const host=lab.addViewer('host',PROFILES.laptop,{store:saved()});
      const tv=lab.addViewer('tv',{...PROFILES.variableTv,quantumMs:0},{store:saved()});
      await lab.run(15000);lab.pause();await lab.run(25000);
      host.player.options.startLatencyMs=533;tv.player.options.startLatencyMs=600;
      const start=lab.clock.now();lab.resume();await lab.run(60000);
      const end=lab.clock.now(), h=summarize(host,start+20000,end), v=summarize(tv,start+20000,end);
      const tail=tv.samples.filter(s=>s.at>=start+20000);
      const gap=Math.max(...host.samples.filter(s=>s.at>=start+20000).map((s,i)=>Math.abs(s.errorMs-tail[i].errorMs)));
      const detail={host:h,tv:v,gap,hostRates:host.player.stats.rateRequests,tvRates:tv.player.stats.rateRequests,hostSeeks:host.player.stats.seeks,tvSeeks:tv.player.stats.seeks};
      return {ok:gap<=50 && h.maxAbsMs<=25 && v.maxAbsMs<=25 && h.frozenMs===0&&v.frozenMs===0&&[host,tv].every(d=>d.player.stats.seeks===0&&d.player.stats.loads===0&&d.player.getPlaybackRate()===1),detail};
    } finally {lab.close();}
  },
  async 'SYNC-33:Sync me restarts an exhausted buffered TV in the same room'() {
    const lab=await createRoomLab({seed:33,sourceNoiseMs:0});
    try {
      const host=lab.addViewer('host',PROFILES.laptop);
      const tv=lab.addViewer('tv',{...PROFILES.variableTv,quantumMs:0});
      const memberId=tv.ctx.session.memberId;
      tv.ctx.playerPrimed=true;
      let rebuilds=0, reloads=0;
      tv.player.loadVideoById=()=>{reloads++;tv.player.stall(180000);};
      tv.ctx.ensurePlayer=(videoId,start)=>{
        tv.ctx.ytPlayer=tv.player;
        tv.ctx.ytPlayerReady=true;
        if(++rebuilds===1){tv.player.stall(180000);return;}
        tv.player.setTrack(videoId);
        tv.player.jump(start);
      };
      await lab.run(5000);
      tv.player.stall(180000);
      await lab.run(46000);
      const before={reloads,rebuilds,members:lab.room.members.size,segment:tv.ctx.state.playoutSegment,
        exhausted:tv.ctx.WatchFusionDecoderRescue.diagnostics().outcome};
      tv.syncMe();
      await lab.run(17000);
      const tvResult=summarize(tv,lab.clock.now()-5000,lab.clock.now());
      const after={reloads,rebuilds,members:lab.room.members.size,segment:tv.ctx.state.playoutSegment};
      return {ok:before.exhausted==='terminal-recovery-spent' && before.reloads===1 && before.rebuilds===1 &&
        rebuilds===2 && reloads===1 && after.members===before.members && after.segment===before.segment &&
        tv.ctx.session.memberId===memberId && tvResult.p95AbsMs<=200 && tvResult.frozenMs===0 &&
        Math.abs(host.errorMs())<=100,detail:{before,after,tvResult}};
    } finally {lab.close();}
  },
  async 'SYNC-13:trace 3 replay, pause + backward scrub + play leaves both viewers PLAYING but frozen'() {
    const r = await pair();
    await r.lab.run(40000);
    r.lab.pause(); await r.lab.run(3000);
    r.lab.hostSeek(r.lab.source.truePosition() - 9.3); await r.lab.run(2000);
    r.lab.resume(); await r.lab.run(300);
    r.tv.player.wedge('pause'); r.laptop.player.wedge('pause');
    await r.lab.run(60000);
    const tv = settled(r.tv, r.at(80), r.at(105)), laptop = settled(r.laptop, r.at(80), r.at(105));
    const detail = {tv: tv.summary, laptop: laptop.summary, tvLoads: r.tv.player.stats.loads, tvStall: arbiterOf(r.tv).stallSteps, laptopStall: arbiterOf(r.laptop).stallSteps};
    r.lab.close();
    return {ok: tv.ok && laptop.ok && detail.tvLoads === 0, detail};
  },
  async 'SYNC-14:a frozen TV that only a seek revives recovers through one rejoin'() {
    const r = await pair();
    await r.lab.run(40000);
    const seeks = r.tv.player.stats.seeks;
    r.tv.player.wedge('seek');
    await r.lab.run(45000);
    const tv = settled(r.tv, r.at(65), r.at(85));
    const detail = {tv: tv.summary, seeks: r.tv.player.stats.seeks - seeks, stall: arbiterOf(r.tv).stallSteps, loads: r.tv.player.stats.loads};
    r.lab.close();
    return {ok: tv.ok && detail.seeks <= 3 && detail.loads === 0, detail};
  },
  async 'SYNC-15:a permanently frozen player gets a bounded ladder, never a loop'() {
    const r = await pair();
    await r.lab.run(40000);
    const seeks = r.tv.player.stats.seeks;
    r.tv.player.wedge('never');
    await r.lab.run(30000);
    const mid = r.tv.player.stats.seeks;
    await r.lab.run(60000);
    const detail = {seeks: r.tv.player.stats.seeks - seeks, lateSeeks: r.tv.player.stats.seeks - mid, stall: arbiterOf(r.tv).stallSteps,
      reason: r.tv.diagnostics()?.action, loads: r.tv.player.stats.loads, laptop: settled(r.laptop, r.at(100), r.at(130)).summary};
    r.lab.close();
    // v13.10.3 adds exactly one decoder reload after the exhausted ladder; it must not restart the ladder.
    return {ok: detail.stall === 3 && detail.loads <= 1 && detail.seeks <= 2 + detail.loads && detail.lateSeeks === 0 && detail.laptop.p95AbsMs <= 200, detail};
  },
  async 'SYNC-16:a 40 s freeze that ignores pause and seek still ends in a recovered lock'() {
    const r = await pair();
    await r.lab.run(40000);
    r.tv.player.wedge('never', 40000);
    await r.lab.run(70000);
    const tv = settled(r.tv, r.at(90), r.at(110));
    const a = arbiterOf(r.tv);
    const detail = {tv: tv.summary, stall: a.stallSteps, displaced: a.displacedRejoins, rejoins: a.rejoins, loads: r.tv.player.stats.loads};
    r.lab.close();
    // One decoder reload (v13.10.3) is allowed; a reload loop or a restarted ladder is not.
    return {ok: tv.ok && detail.loads <= 1, detail};
  },
  async 'SYNC-18:a second 45 s timeline jump in one segment (reclaim spent) is recovered once, not left forever'() {
    const r = await pair();
    await r.lab.run(40000);
    r.laptop.player.jump(-45); await r.lab.run(20000);
    r.laptop.player.jump(-45); await r.lab.run(30000);
    const laptop = settled(r.laptop, r.at(75), r.at(90));
    const detail = {laptop: laptop.summary, displaced: arbiterOf(r.laptop).displacedRejoins, seeks: r.laptop.player.stats.seeks, loads: r.laptop.player.stats.loads};
    r.lab.close();
    return {ok: laptop.ok && detail.displaced === 1 && detail.loads === 0 && detail.seeks <= 4, detail};
  },
  async 'SYNC-22:a TV that refreezes after its first two corrective seeks still locks, bounded and fast'() {
    const r = await pair();
    await r.lab.run(40000);
    const seeks = r.tv.player.stats.seeks, from = r.lab.clock.now();
    r.tv.player.wedge('seek'); r.tv.player.freezeAfterNextSeeks(2, 7000);
    let lockedAt = -1;
    for (let t = 0; t < 90000 && lockedAt < 0; t += 1000) {
      await r.lab.run(1000);
      const s = summarize(r.tv, r.lab.clock.now() - 5000, r.lab.clock.now());
      if (t >= 5000 && s.p95AbsMs <= 200) lockedAt = r.lab.clock.now() - 5000;
    }
    const detail = {lockAfterMs: lockedAt < 0 ? null : Math.round(lockedAt - from), seeks: r.tv.player.stats.seeks - seeks,
      stall: arbiterOf(r.tv).stallSteps, loads: r.tv.player.stats.loads};
    r.lab.close();
    return {ok: lockedAt >= 0 && detail.lockAfterMs <= 30000 && detail.seeks <= 4 && detail.loads === 0, detail};
  },
  async 'SYNC-23:a decoder freeze during the first speed probe never brands a rate-capable TV as 1x-only'() {
    const lab = await createRoomLab(), t0 = lab.clock.now();
    lab.addViewer('laptop', PROFILES.laptop);
    const tv = lab.addViewer('tv', PROFILES.variableTv, {offsetSec: 1.2});
    const setRate = tv.player.setPlaybackRate.bind(tv.player);
    let froze = false;
    tv.player.setPlaybackRate = rate => { if (rate !== 1 && !froze) { froze = true; tv.player.wedge('never', 1500); } setRate(rate); };
    await lab.run(90000);
    const s = summarize(tv, t0 + 45000, t0 + 90000), model = tv.diagnostics().arbiter.model;
    const detail = {tv: s, froze, rateHonored: model.rateHonored, seeks: tv.player.stats.seeks, loads: tv.player.stats.loads};
    lab.close();
    return {ok: froze && model.rateHonored !== false && s.p95AbsMs <= 200 && detail.loads === 0, detail};
  },
  async 'SYNC-24:log 2 replay, a TV paused 8.8 s behind resumes warm and locks soon after play'() {
    const lab = await createRoomLab(), t0 = lab.clock.now();
    lab.addViewer('laptop', PROFILES.laptop);
    // A frozen TV decoder holds little buffer ahead of its stuck position.
    const r = {lab, t0, tv: lab.addViewer('tv', {...PROFILES.fixedTv, bufferAheadSec: 4}, {offsetSec: 1.2})};
    await r.lab.run(40000);
    r.tv.player.seekTo(r.tv.player.getCurrentTime() - 8.8); // the TV is 8.8 s behind as the room pauses
    r.lab.pause();
    r.tv.player.freezeAfterNextSeeks(1, 7000);               // its next seek lands, then the decoder freezes
    await r.lab.run(20000);
    const pausedError = Math.round((r.tv.player.getCurrentTime() - r.lab.source.truePosition()) * 1000);
    const resumeAt = r.lab.clock.now(), seeks = r.tv.player.stats.seeks;
    r.lab.resume();
    let lockedAt = -1;
    for (let t = 0; t < 60000 && lockedAt < 0; t += 500) {
      await r.lab.run(500);
      const s = summarize(r.tv, r.lab.clock.now() - 5000, r.lab.clock.now());
      if (t >= 5000 && s.p95AbsMs <= 200) lockedAt = r.lab.clock.now() - 5000;
    }
    const detail = {pausedErrorMs: pausedError, lockAfterResumeMs: lockedAt < 0 ? null : Math.round(lockedAt - resumeAt),
      seeksAfterResume: r.tv.player.stats.seeks - seeks, loads: r.tv.player.stats.loads, gate: r.tv.diagnostics()?.startup?.reason};
    r.lab.close();
    return {ok: lockedAt >= 0 && detail.lockAfterResumeMs <= 8000 && Math.abs(pausedError) <= 2000 && detail.loads === 0, detail};
  },
  async 'SYNC-17:once locked, three minutes of ordinary playback need no correction'() {
    const r = await pair();
    await r.lab.run(60000);
    const before = arbiterOf(r.tv).corrections, beforeLaptop = arbiterOf(r.laptop).corrections;
    await r.lab.run(180000);
    const tv = settled(r.tv, r.at(60), r.at(240)), laptop = settled(r.laptop, r.at(60), r.at(240));
    const detail = {tv: tv.summary, laptop: laptop.summary, tvExtra: arbiterOf(r.tv).corrections - before, laptopExtra: arbiterOf(r.laptop).corrections - beforeLaptop};
    r.lab.close();
    return {ok: tv.ok && laptop.ok && detail.tvExtra === 0 && detail.laptopExtra === 0, detail};
  }
};
