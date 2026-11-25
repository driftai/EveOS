/* SYNC-25: four successive linked-source songs with all three room viewers.
 * This is the same real coordinator, IFrame arbiter and virtual decoder used by
 * the other sync labs. Track replacements are explicit transports, not seeks.
 */
import {createRoomLab, summarize} from './room-lab.js';
import {PROFILES} from './fake-youtube.js';

// Trace-inspired acquisition with a stale learned rate gain. These use the real
// controller/coordinator and virtual decoder, not replayed output or speaker timing.
async function acquiredRoom(offsetSec, seed, noiseMs, requireReverse) {
  const lab = await createRoomLab({seed, sourceNoiseMs:noiseMs, fineTrim:true});
  const saved = () => new Map([['watchfusion.viewerSyncModel.v1', JSON.stringify({rateHonored:false,rateRejections:2,rateGain:.71})]]);
  try {
    const host = lab.addViewer('host',PROFILES.laptop,{store:saved()});
    const tv = lab.addViewer('tv',{...PROFILES.variableTv,quantumMs:0},{offsetSec,store:saved()});
    const started=lab.clock.now();
    await lab.run(20000);
    const before={host:host.player.stats.rateRequests.length,tv:tv.player.stats.rateRequests.length,
      corrections:tv.diagnostics().arbiter.corrections};
    await lab.run(180000);
    const samples=host.samples.map((h,i)=>({at:h.at,gap:Math.abs(h.errorMs-tv.samples[i].errorMs),
      host:Math.abs(h.errorMs),tv:Math.abs(tv.samples[i].errorMs),playing:h.state===1&&tv.samples[i].state===1}));
    const late=samples.filter(s=>s.at>=started+20000);
    const detail={samples:late.length,maxGapMs:Math.max(...late.map(s=>s.gap)),
      maxHostMs:Math.max(...late.map(s=>s.host)),maxTvMs:Math.max(...late.map(s=>s.tv)),
      tvRates:tv.player.stats.rateRequests,extraCorrections:tv.diagnostics().arbiter.corrections-before.corrections,
      tvSeeks:tv.player.stats.seeks,hostSeeks:host.player.stats.seeks};
    const ok=late.length>=720&&late.every(s=>s.playing&&s.gap<=50&&s.host<=50&&s.tv<=50)&&
      detail.maxGapMs<=25&&detail.tvRates[0]===1.25&&(!requireReverse||detail.tvRates.includes(.75))&&
      detail.tvRates.length<=(requireReverse?4:2)&&detail.extraCorrections===0&&
      host.player.stats.rateRequests.length===before.host&&tv.player.stats.rateRequests.length===before.tv&&
      [host,tv].every(d=>d.player.stats.seeks===0&&d.player.stats.loads===0&&d.player.getPlaybackRate()===1);
    return {ok,detail};
  } finally {lab.close();}
}

// Trace-shaped fault injection: first rate proof is inconclusive and the
// mirror veto arrives after real progress. No synthetic correction outcomes.
async function partialRateRoom({multiple=false, rejects=false, vetoMs=2500, seed=37}={}) {
  const lab=await createRoomLab({seed,sourceNoiseMs:0,fineTrim:true});
  const saved=()=>new Map([['watchfusion.viewerSyncModel.v1',JSON.stringify({rateHonored:false,rateRejections:2,rateGain:1})]]);
  const host=lab.addViewer('host',PROFILES.laptop,{store:saved()});
  const tv=lab.addViewer('tv',{...PROFILES.variableTv,quantumMs:0,honorsRate:!rejects},{offsetSec:rejects?.36:.597,store:saved()});
  const evidence=tv.ctx.WatchFusionReleaseEvidence, mirror=tv.ctx.WatchFusionMirrorConvergenceGate;
  let first=true, vetoUntil=-1, interrupted=false;
  tv.ctx.WatchFusionReleaseEvidence={...evidence,classifyRateProbe:(...args)=>
    first&&!rejects?'unverified':evidence.classifyRateProbe(...args)};
  const originalMirror=mirror.contradicted;
  mirror.contradicted=()=>lab.clock.now()<vetoUntil||originalMirror();
  const tracks=[];
  let duringVetoRate=0, vetoSamples=0;
  try {
    for(let i=0;i<(multiple?4:1);i++) {
      if(i){lab.nextTrack('WF-06E-track-'+i);tv.player.options.startLatencyMs=[0,637,590,720][i];tv.player.stall([0,637,590,720][i]);}
      first=i===0;interrupted=false;vetoUntil=-1;
      const ratesAt=tv.player.stats.rateRequests.length,hostRatesAt=host.player.stats.rateRequests.length;
      const seeksAt=tv.player.stats.seeks,loadsAt=tv.player.stats.loads,started=lab.clock.now();
      const hostSeeksAt=host.player.stats.seeks,hostLoadsAt=host.player.stats.loads;
      await lab.run(40000,250,now=>{
        if(first&&!interrupted&&!rejects&&tv.player.getPlaybackRate()>1&&tv.errorMs()<=362){
          vetoUntil=now+vetoMs;interrupted=true;
        }
        if(interrupted&&now>=vetoUntil)first=false;
        if(interrupted&&now<vetoUntil-250&&now>=vetoUntil-vetoMs+750){
          vetoSamples++;if(tv.player.getPlaybackRate()!==1)duringVetoRate++;
        }
      });
      await lab.run(30000);
      const tail=tv.samples.filter(s=>s.at>=started+40000);
      const hostTail=host.samples.filter(s=>s.at>=started+40000);
      const detail={interrupted,rates:tv.player.stats.rateRequests.slice(ratesAt),
        hostRates:host.player.stats.rateRequests.length-hostRatesAt,
        maxGapMs:Math.max(...tail.map((s,j)=>Math.abs(s.errorMs-hostTail[j].errorMs))),
        maxTvMs:Math.max(...tail.map(s=>Math.abs(s.errorMs))),maxHostMs:Math.max(...hostTail.map(s=>Math.abs(s.errorMs))),
        seeks:tv.player.stats.seeks-seeksAt,loads:tv.player.stats.loads-loadsAt,
        hostSeeks:host.player.stats.seeks-hostSeeksAt,hostLoads:host.player.stats.loads-hostLoadsAt,
        frozen:tail.filter(s=>s.frozen||s.state!==1).length+hostTail.filter(s=>s.frozen||s.state!==1).length,
        reason:tv.diagnostics().arbiter.reason,attempts:tv.diagnostics().arbiter.tvRateRecheck.attempts,
        rate:tv.player.getPlaybackRate()};
      tracks.push(detail);
    }
    const good=tracks.every(t=>t.maxGapMs<=50&&t.maxTvMs<=50&&t.maxHostMs<=50&&t.seeks===0&&t.loads===0&&t.rate===1&&t.rates.length<=12&&t.hostRates===0&&t.hostSeeks===0&&t.hostLoads===0&&t.frozen===0);
    return {ok:rejects?tracks[0].rates.filter(r=>r!==1).length===1&&tracks[0].rate===1&&tracks[0].seeks===0&&tracks[0].loads===0&&tracks[0].reason==='tv-rate-trial-spent'&&tracks[0].hostRates===0&&tracks[0].hostSeeks===0&&tracks[0].hostLoads===0:good&&tracks[0].interrupted&&tracks[0].rates.filter(r=>r>1).length===2&&vetoSamples>0&&duringVetoRate===0,detail:{tracks,vetoSamples,duringVetoRate}};
  } finally {lab.close();}
}

// Test the actual position of every member, not its reported lock state.
async function interruptedFineLockRoom(){
  const lab=await createRoomLab({seed:51,sourceNoiseMs:0,fineTrim:true});
  const saved=()=>new Map([['watchfusion.viewerSyncModel.v1',JSON.stringify({rateHonored:false,rateRejections:2,rateGain:.71})]]);
  const host=lab.addViewer('host',PROFILES.laptop,{offsetSec:.492,rttMs:10,store:saved()});
  const tv=lab.addViewer('tv',{...PROFILES.variableTv,quantumMs:0},{offsetSec:.303,rttMs:30,store:saved()});
  const policy=host.ctx.WatchFusionHostSeekPolicy, original=policy.sourceBlocker;
  const hostSet=host.player.setPlaybackRate;let hostPulses=0,startedAt=-Infinity;
  host.player.setPlaybackRate=r=>{if(r!==1){hostPulses++;startedAt=lab.clock.now();}hostSet(r);};
  host.ctx.WatchFusionHostSeekPolicy={...policy,sourceBlocker:t=>hostPulses<=3&&lab.clock.now()-startedAt>=550&&lab.clock.now()-startedAt<1450?'host-source-unverified':original(t)};
  const evidence=tv.ctx.WatchFusionReleaseEvidence, tvSet=tv.player.setPlaybackRate;
  let first=true,delayed=false,restoreTimer=null,overshoot=0;
  // First TV probe is inconclusive, and the decoder applies rate restoration late.
  // Actual progress and overshoot are still measured independently by the lab.
  tv.ctx.WatchFusionReleaseEvidence={...evidence,classifyRateProbe:(...args)=>first?'unverified':evidence.classifyRateProbe(...args)};
  tv.player.setPlaybackRate=r=>{
    if(r!==1){lab.clock.clearTimeout(restoreTimer);tvSet(r);return;}
    if(first&&tv.player.getPlaybackRate()>1&&!delayed){delayed=true;restoreTimer=lab.clock.setTimeout(()=>{tvSet(1);first=false;overshoot=tv.errorMs();},650);return;}
    if(delayed&&first)return;
    tvSet(r);
  };
  const stages=[];
  const settle=async(label)=>{
    const from=lab.clock.now();await lab.run(45000);
    const rates=host.player.stats.rateRequests.length+tv.player.stats.rateRequests.length;await lab.run(30000);
    const hs=host.samples.filter(s=>s.at>=from+45000),ts=tv.samples.filter(s=>s.at>=from+45000);
    stages.push({label,samples:hs.length,maxHost:Math.max(...hs.map(s=>Math.abs(s.errorMs))),maxTv:Math.max(...ts.map(s=>Math.abs(s.errorMs))),maxGap:Math.max(...hs.map((s,i)=>Math.abs(s.errorMs-ts[i].errorMs))),unready:hs.filter(s=>s.frozen||s.state!==1).length+ts.filter(s=>s.frozen||s.state!==1).length,lateRateCommands:host.player.stats.rateRequests.length+tv.player.stats.rateRequests.length-rates});
  };
  try{
    await settle('interrupted-acquisition');
    host.player.jump(-.22);tv.player.jump(-.303);await settle('same-video-disturbance-1');
    tv.player.jump(.18);await settle('same-video-disturbance-2');
    const detail={stages,hostPulses,delayed,overshoot,hostSeeks:host.player.stats.seeks,tvSeeks:tv.player.stats.seeks,hostLoads:host.player.stats.loads,tvLoads:tv.player.stats.loads,hostRates:host.player.stats.rateRequests,tvRates:tv.player.stats.rateRequests};
    return {ok:delayed&&overshoot< -100&&hostPulses>=3&&hostPulses<=10&&detail.tvRates.length<=12&&stages.every(s=>s.samples>=120&&s.maxHost<=50&&s.maxTv<=50&&s.maxGap<=50&&s.unready===0&&s.lateRateCommands===0)&&[host,tv].every(d=>d.player.stats.seeks===0&&d.player.stats.loads===0&&d.player.getPlaybackRate()===1),detail};
  }finally{lab.close();}
}

export const MULTISONG_SCENARIOS = {
  async 'SYNC-51:interrupted fine acquisition and repeated same-video drift recover actual room lock'(){return interruptedFineLockRoom();},
  async 'SYNC-37:partially effective TV trial recovers a subsecond plateau'() {return partialRateRoom();},
  async 'SYNC-38:four successive tracks preserve tight lock after partial convergence'() {return partialRateRoom({multiple:true});},
  async 'SYNC-39:mirror veto restores base speed and defers the finish until fresh evidence'() {return partialRateRoom({vetoMs:12000,seed:39});},
  async 'SYNC-40:unresponsive advertised rate does not earn repeated trials'() {return partialRateRoom({rejects:true});},
  async 'SYNC-35:790ms acquisition preserves near-zero room lock for three minutes'() {
    return acquiredRoom(.790,42,8,false);
  },
  async 'SYNC-36:bounded reverse follow-up converges without disturbing the host'() {
    return acquiredRoom(.650,42,0,true);
  },
  async 'SYNC-32:two linked tracks keep a tight lock and bound TV catch-up after a buffered transition'() {
    const lab = await createRoomLab({seed:32, sourceNoiseMs:0, fineTrim:true});
    const saved = () => new Map([['watchfusion.viewerSyncModel.v1', JSON.stringify({rateHonored:false, rateRejections:2})]]);
    const host = lab.addViewer('host', PROFILES.laptop, {offsetSec:.059, store:saved()});
    const tv = lab.addViewer('tv', {...PROFILES.variableTv, quantumMs:0}, {offsetSec:.012, store:saved()});
    const setHostRate = host.player.setPlaybackRate;
    let pendingRate;
    host.player.setPlaybackRate = rate => {
      lab.clock.clearTimeout(pendingRate);
      if (rate === 1) setHostRate(rate);
      else pendingRate = lab.clock.setTimeout(() => setHostRate(rate), 100);
    };
    const players = [host,tv];
    const measure = () => {
      const end=lab.clock.now();
      const positions=players.map(d=>d.samples.filter(s=>s.at>=end-5000 && s.at<=end));
      const gaps=positions[0].map((s,i)=>Math.abs(s.errorMs-positions[1][i].errorMs));
      return {maxGapMs:Math.max(...gaps), players:players.map(d=>({
        ...summarize(d,end-5000,end), seeks:d.player.stats.seeks, loads:d.player.stats.loads,
        roomRate:d.player.getPlaybackRate(), phase:d.diagnostics().startup.transitionPhase
      }))};
    };
    try {
      await lab.run(20000);
      const first=measure(), firstRateProof=host.ctx.WatchFusionZeroConverge.diagnostics().hostRateRecheck.measuredImprovement;
      const priorRateRequests = tv.player.stats.rateRequests.length;
      lab.nextTrack('WF-Song-002');
      tv.player.stall(850);
      await lab.run(3000);
      const startupGapMs = Math.abs(host.errorMs() - tv.errorMs());
      await lab.run(22000);
      const second=measure();
      await lab.run(12000);
      const settled=measure();
      const tvUsedRate = tv.player.stats.rateRequests.slice(priorRateRequests).some(rate=>rate>1);
      const ok=firstRateProof && first.maxGapMs<=25 && first.players.every(p=>p.p95AbsMs<=25 && p.seeks===0 && p.loads===0) &&
        startupGapMs>=400 && tvUsedRate && second.maxGapMs<=50 && settled.maxGapMs<=50 &&
        second.players.every(p=>p.seeks===0) && settled.players.every(p=>
        p.samples>=20 && p.frozenMs===0 && p.p95AbsMs<=50 && p.phase==='decoder-confirmed' &&
        p.seeks===0 && p.loads===1 && p.roomRate===1);
      return {ok,detail:{firstRateProof,startupGapMs,tvUsedRate,first,second,settled}};
    } finally {lab.close();}
  },
  async 'SYNC-25:four-song three-member transitions keep late locks without reload or seek loops'() {
    const lab = await createRoomLab({seed: 37, sourceNoiseMs: 12});
    const host = lab.addViewer('laptop', PROFILES.laptop);
    const phone = lab.addViewer('phone', PROFILES.phone, {offsetSec: .05});
    const tv = lab.addViewer('tv', PROFILES.fixedTv, {offsetSec: 1.2});
    const devices = [host, phone, tv], songs = [];
    try {
      for (let i = 0; i < 4; i++) {
        if (i) lab.nextTrack('WF-Song-0' + (i + 1));
        await lab.run(12000);
        if (i === 1) lab.source.stall(450); // source stall, not a viewer seek
        if (i === 2) phone.player.stall(650); // one viewer buffers
        if (i === 3) { lab.pause(); await lab.run(1500); lab.resume(); }
        await lab.run(67000);
        const end = lab.clock.now();
        const summaries = devices.map(d => {
          const report = d.diagnostics?.() || {};
          return {name: d.name, ...summarize(d, end - 25000, end),
            seeks: d.player.stats.seeks, loads: d.player.stats.loads,
            corrections: report.arbiter?.corrections ?? 0,
            startupPhase: report.startup?.transitionPhase ?? null,
            decoderFirstProgressMs: report.startup?.firstProgressDelayMs ?? null,
            learnedReleaseLatencyMs: report.arbiter?.model?.releaseLatencyMs ?? null,
            verifiedReleases: report.arbiter?.model?.verifiedReleases ?? 0,
            arbiterReason: report.arbiter?.reason ?? null};
        });
        songs.push({song:i+1, summaries});
      }
      // Only three *intentional* track loads, plus at most one bounded recovery;
      // progress and phase must converge independently on all three devices.
      const late = songs.flatMap(s => s.summaries);
      const stable = late.every(s => s.samples >= 60 && s.frozenMs === 0 &&
        s.p95AbsMs <= 400 && s.within200 >= 85);
      const bounded = devices.every(d => d.player.stats.loads <= 4 &&
        d.player.stats.seeks <= 16 && d.player.stats.networkSeeks <= 5);
      return {ok: stable && bounded, detail: {songs, totals: devices.map(d => ({name:d.name,
        seeks:d.player.stats.seeks, networkSeeks:d.player.stats.networkSeeks,
        loads:d.player.stats.loads, rates:d.player.stats.rateRequests.length}))}};
    } finally {lab.close();}
  }
};
