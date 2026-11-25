// Offline player-timeline convergence with rate changes and delayed decoder starts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
const ROOT=process.env.WF_FALSIFIER_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const read=rel=>fs.readFileSync(path.join(ROOT,rel),'utf8');
function lab({rates=[.75,1],trusted=true,mirror=false,source=true,actualRate=true,startingError=.2,
    decoderDelayMs=()=>0,buffered=()=>true,bufferOnPlay=false,savedModel={}}={}) {
  let now=50000,position=now/1000+startingError,last=now,speed=1,ops=[];
  let playerState=1,playAt=now;
  const ctx={Math,Number,Date,Map,Set,JSON,console,setTimeout:()=>1,clearTimeout(){},performance:{now:()=>now}};
  ctx.globalThis=ctx;ctx.window=ctx;ctx.storage={get:()=>JSON.stringify({rateHonored:false,rateRejections:2,...savedModel}),set:()=>{}};
  ctx.WatchFusionTimelineMath={observePosition:(at,v)=>({value:v,since:at}),projectedPosition:(at,v)=>v,chooseRate:()=>null};
  vm.runInNewContext(read('public/client/viewer-release-evidence.js'),ctx,{filename:'viewer-release-evidence.js'});
  vm.runInNewContext(read('public/client/viewer-sync-arbiter.js'),ctx,{filename:'viewer-sync-arbiter.js'});
  const io={baseRate:1,hostLinked:false,follower:true,linkedSourceActive:()=>true,tvIdentity:'room:video:epoch',
    now:()=>now,current:()=>position,target:()=>now/1000,state:()=>playerState,availableRates:()=>rates,
    referenceTrusted:()=>trusted,sourceReferenceQualified:()=>source,referenceUncertaintyMs:()=>12,
    sourceBuffering:()=>false,mirrorContradicted:()=>typeof mirror==='function'?mirror(now):mirror,speakerPhaseVerified:()=>false,
    buffered:()=>buffered(now),seek:(v,network)=>{ops.push(['seek',v,network]);position=v;},
    pause:()=>{ops.push(['pause']);playerState=2;},
    play:()=>{ops.push(['play']);playerState=bufferOnPlay?3:1;playAt=now+decoderDelayMs(now);},
    rate:r=>{ops.push(['rate',r]);if(actualRate)speed=r;}};
  const arb=ctx.WatchFusionViewerSyncArbiter.createViewerSyncArbiter({store:ctx.storage,timers:{setTimeout:()=>1,clearTimeout(){}}});
  return {ctx,arb,io,ops,bufferFor:ms=>{playerState=3;playAt=now+ms;},at:t=>{
    if(playerState===3 && t>=playAt)playerState=1;
    if(playerState===1)position+=Math.max(0,t-Math.max(last,playAt))/1000*speed;
    last=now=t;
  },now:()=>now,position:()=>position};
}
function play(L,{end=76000,step=250}={}){
 for(let t=50000;t<=end;t+=step){L.at(t);L.arb.tick('room:video:epoch:seg3',t,L.io);}
}
export async function runR14yChecks(check){
 await check('WF06I-03:measured small TV overshoot earns one reverse trial, never a blind repeat',()=>{
  const L=lab({rates:[.75,1,1.25]}),scope='room:video:epoch:seg3';
  for(const mode of ['measured','no-motion','rejected','new-scope']){
   const gate=L.ctx.WatchFusionReleaseEvidence.createTvRateRecheckGate();
   const input={scope,io:L.io,rateHonored:false,quietStallMs:30000,quietRejoinMs:30000};
   for(let t=0;t<=11000;t+=250)gate.consider({...input,nowMs:t,error:.303});
   assert.equal(gate.snapshot().attempts,1);
   gate.settle(scope,mode==='rejected'?'rejected':undefined,{probe:{nowMs:0,current:10},rate:1.25},{now:()=>1720,current:()=>mode==='no-motion'?11.72:12.15,baseRate:1});
   let follow=null;for(let t=12000;t<=25000;t+=250)follow=gate.consider({...input,scope:mode==='new-scope'?scope+'x':scope,nowMs:t,error:-.127})||follow;
   assert.equal(follow?.rate,mode==='measured'?.75:undefined,mode);
   assert.equal(gate.snapshot().attempts,mode==='measured'?2:1);
   for(let t=26000;t<=40000;t+=250)assert.equal(gate.consider({...input,nowMs:t,error:.12}),null);
  }
 });
 await check('WF06I-04:only sustained qualified lock restores a spent TV trial for a new disturbance',()=>{
  const L=lab({rates:[.75,1,1.25]}),scope='room:video:epoch:seg3';
  for(const mode of ['healthy','rejected','stale','untrusted','not-locked','frozen','raw-offset']){
   const gate=L.ctx.WatchFusionReleaseEvidence.createTvRateRecheckGate();
   const input={scope,io:L.io,rateHonored:false,quietStallMs:30000,quietRejoinMs:30000};
   for(let t=0;t<=11000;t+=250)gate.consider({...input,nowMs:t,error:.303});
   gate.settle(scope,mode==='rejected'?'rejected':undefined,{probe:{nowMs:0,current:10},rate:1.25},{now:()=>1200,current:()=>11.5,baseRate:1});
   for(let t=12000;t<=30000;t+=mode==='stale'?2000:250)gate.observeLock?.(scope,t,mode==='not-locked'?.15:.015,{...L.io,sourceReferenceQualified:()=>mode!=='untrusted',target:()=>t/1000,current:()=>mode==='frozen'?12:t/1000-(mode==='raw-offset'?.15:.015)});
   let trial=null;for(let t=31000;t<=45000;t+=250)trial=gate.consider({...input,nowMs:t,error:.303})||trial;
   assert.equal(trial?.rate,mode==='healthy'?1.25:undefined,mode);
  }
 });
 await check('R14Y-01:physical-R14x1-trace-shows-stable-200-and-300ms-TV-lead',()=>{
  const data=JSON.parse(read('tests/smoke/fixtures/20261121-r14x1-rate-plateau-redacted.json'));
  assert.equal(data.snapshots.length,94);
  const median=v=>v.sort((a,b)=>a-b)[Math.floor(v.length/2)];
  const a=data.snapshots.filter(x=>x.song===1&&x.plateau==='stable-timeline-offset').map(x=>x.relativeMs);
  const b=data.snapshots.filter(x=>x.song===2&&x.relativeMs!==null&&x.relativeMs>100);
  assert.ok(a.length>=8&&median(a)>=190&&median(a)<=215);
  assert.ok(b.length>=15&&median(b.map(x=>x.relativeMs))>=285);
  assert.ok([...a].every(Number.isFinite));
 });
 await check('R14Y-02:one-x-only-TV-never-forces-speed-pause-seek-or-reload',()=>{
  const L=lab({rates:[1]});play(L);assert.equal(L.ops.length,0);
  assert.equal(L.arb.snapshot().tvRateRecheck.attempts,0);
 });
 await check('R14Y-03:untrusted-source-and-mirror-contradiction-disable-trial',()=>{
  for(const config of [{trusted:false},{source:false},{mirror:true}]){
    const L=lab(config);play(L);assert.equal(L.ops.length,0,JSON.stringify(config));
  }
 });
 await check('R14Y-04:verified-alternate-rate-trial-is-single-and-never-seeks',()=>{
  const L=lab();play(L);const probes=L.ops.filter(x=>x[0]==='rate'&&x[1]!==1);
  assert.equal(probes.length,1,JSON.stringify(L.ops));
  assert.equal(probes[0][1],.75);assert.ok(L.ops.every(x=>x[0]==='rate'));
  assert.equal(L.arb.snapshot().tvRateRecheck.attempts,1);
 });
 await check('R14Y-05:actual-media-progress-can-confirm-a-short-800ms-trial',()=>{
  const L=lab();play(L);assert.equal(L.arb.snapshot().model.rateHonored,true);
  assert.ok(L.ops.some(x=>x[0]==='rate'&&x[1]===1));
 });
 await check('R14Y-06:non-honored-rate-remains-rejected-and-is-not-retried',()=>{
  const L=lab({actualRate:false});play(L,{end:80000});
  assert.equal(L.arb.snapshot().model.rateHonored,false);
  assert.equal(L.arb.snapshot().tvRateRecheck.attempts,1);
  assert.ok(L.ops.every(x=>x[0]==='rate'));
 });
 await check('R14Y-07:rate-proof-never-equates-player-motion-to-speaker-phase',()=>{
  const s=read('public/client/viewer-release-evidence.js');
  assert.ok(s.includes('classifyRateProbe'));
  assert.doesNotMatch(s.slice(s.indexOf('function createTvRateRecheckGate'),s.indexOf('globalThis.WatchFusionReleaseEvidence')),/\.seek\(|\.pause\(|\.play\(|\.load\(|getUserMedia|AudioContext/);
 });
 await check('R14Y-08:mirror-contradiction-interrupts-a-rate-trial-and-restores-room-speed',()=>{
  const L=lab({rates:[1,1.25],startingError:-.445,mirror:at=>at>=54200});
  play(L,{end:54500,step:50});
  assert.deepEqual(L.ops,[['rate',1.25],['rate',1]]);
  assert.equal(L.arb.owns(),false);
  assert.equal(L.arb.snapshot().model.rateHonored,false);
 });
 await check('R14Y-09:controller-growth-guard-and-source-qualification-wired',()=>{
  const paths=['public/client/viewer-sync-arbiter.js','public/client/viewer-release-evidence.js','public/playback-sync.js'];
  for(const p of paths){const lines=read(p).trimEnd().split(/\r?\n/).length;assert.ok(lines<=440,`${p} ${lines}`);}
  assert.match(read('public/playback-sync.js'),/sourceReferenceQualified:[\s\S]+?reference==='linked-tab'[^\n]+hasSourceReference/);
 });
 await check('R14Y-10:early-expiration-and-honored-classification-are-driven-by-media-progress',()=>{
  const L=lab();const classifier=L.ctx.WatchFusionReleaseEvidence.classifyRateProbe;
  let t=10000;
  const j={probe:{nowMs:t,current:1},rate:.75};
  const c=(pos,at)=>classifier(j,{state:()=>1,sourceBuffering:()=>false,referenceTrusted:()=>true,mirrorContradicted:()=>false,
    current:()=>pos,baseRate:1},at);
  assert.equal(c(1.32,t+400),'unverified');
  assert.equal(c(1.45,t+600),'honored');
  assert.equal(c(1.60,t+600),'rejected');
  assert.equal(c(1.54,t+600),'unverified');
 });
 await check('TV-LATE-01:advancing-fixed-rate-TV-recovers-a-one-second-post-release-lag',()=>{
  const L=lab({rates:[1],startingError:-4,decoderDelayMs:()=>1280});
  play(L,{end:70000,step:50});
  assert.equal(L.ops.filter(([kind])=>kind==='seek').length,2,'initial rejoin and one early retry');
  assert.ok(L.ops.filter(([kind])=>kind==='seek').every(([, , network])=>network===false));
  assert.ok(Math.abs(L.position()-L.now()/1000)<.05,'settled player residual');
 });
 await check('TV-LATE-02:unbuffered-or-unqualified-TV-cannot-bypass-the-release-guard',()=>{
  for(const config of [{buffered:at=>at<54000},{source:false},{mirror:true}]){
    const L=lab({rates:[1],startingError:-4,decoderDelayMs:()=>1280,...config});
    L.arb.rejoinNow(50000,L.io,'hydrate');
    play(L,{end:70000,step:50});
    assert.equal(L.ops.filter(([kind])=>kind==='seek').length,1);
  }
 });
 await check('TV-LATE-03:failed-buffered-retry-does-not-loop',()=>{
  const L=lab({rates:[1],startingError:-4,decoderDelayMs:at=>at<56000?1280:2200});
  play(L,{end:115000,step:50});
  assert.equal(L.ops.filter(([kind])=>kind==='seek').length,2);
  assert.equal(L.arb.snapshot().reason,'late-release-retry-spent');
 });
 await check('TV-LATE-04:normal-startup-buffering-allows-retry-but-a-later-buffer-break-disqualifies-it',()=>{
  for(const interrupted of [false,true]){
    const L=lab({rates:[1],startingError:-4,decoderDelayMs:()=>1650,bufferOnPlay:true});
    for(let t=50000;t<=70000;t+=50){
      L.at(t);
      if(interrupted && t===55000)L.bufferFor(600);
      L.arb.tick('room:video:epoch:seg3',t,L.io);
    }
    assert.equal(L.ops.filter(([kind])=>kind==='seek').length,interrupted?1:2);
    if(!interrupted)assert.ok(Math.abs(L.position()-L.now()/1000)<.05);
  }
 });
 await check('R14Y-11:advertised-speed-correction-centers-300ms-in-either-direction',()=>{
  for(const startingError of [.3,-.3]){
    const L=lab({rates:[.75,1,1.25],startingError});
    play(L,{step:50});
    assert.ok(Math.abs(L.position()-L.now()/1000)<.05,'settled player residual');
    assert.ok(L.ops.every(([kind])=>kind==='rate'));
    assert.equal(L.arb.snapshot().model.rateHonored,true);
  }
 });
 await check('R14Y-12:healthy-linked-source-lag-prefers-one-rate-trial-over-a-seek',()=>{
  for(const startingError of [-.445,-.78]){
    const L=lab({rates:[1,1.25],startingError});
    play(L,{end:62000,step:50});
    assert.equal(L.arb.snapshot().tvRateRecheck.attempts,1);
    assert.equal(L.arb.snapshot().model.rateHonored,true);
    assert.ok(Math.abs(L.position()-L.now()/1000)<.05);
    assert.ok(L.ops.every(([kind])=>kind==='rate'));
  }
 });
 await check('R14Y-13:an-advancing-TV-can-close-the-traced-1.65-second-gap-before-a-rejoin',()=>{
  const L=lab({rates:[1,1.05,1.25],startingError:-1.65});
  L.ctx.WatchFusionReleaseEvidence.tvRecoveryOwner.release(L.io.tvIdentity,49000);
  play(L,{end:61800,step:50});
  assert.deepEqual(L.ops,[['rate',1.25],['rate',1]]);
  assert.ok(Math.abs(L.position()-L.now()/1000)<.05);
 });
 await check('R14Y-14:an-ignored-long-rate-trial-returns-to-room-speed-as-soon-as-it-is-rejected',()=>{
  const L=lab({rates:[1,1.25],startingError:-1.65,actualRate:false});
  L.ctx.WatchFusionReleaseEvidence.tvRecoveryOwner.release(L.io.tvIdentity,49000);
  play(L,{end:55800,step:50});
  assert.deepEqual(L.ops,[['rate',1.25],['rate',1]]);
  assert.equal(L.arb.owns(),false);
  assert.equal(L.arb.snapshot().model.rateHonored,false);
 });
 await check('R14Y-15:a progressing but inconclusive coarse trial can finish a post-transition 350ms lag',()=>{
  let contradiction=false, interrupted=false;
  const L=lab({rates:[1,1.25],startingError:-1.65,mirror:()=>contradiction});
  const evidence=L.ctx.WatchFusionReleaseEvidence;
  L.ctx.WatchFusionReleaseEvidence={...evidence,classifyRateProbe:(...args)=>
    L.ops.filter(([,rate])=>rate===1.25).length===1?'unverified':evidence.classifyRateProbe(...args)};
  for(let at=50000;at<=85000;at+=50){
    L.at(at);
    if(!interrupted && L.arb.owns() && L.ops[0]?.[1]===1.25 && at/1000-L.position()<=.36){
      contradiction=interrupted=true;
    }
    L.arb.tick('room:video:epoch:seg3',at,L.io);
    contradiction=false;
  }
  assert.ok(interrupted,'the coarse rate burst stopped with a residual lag');
  assert.ok(Math.abs(L.position()-L.now()/1000)<=.05,'the final lag should converge');
  assert.deepEqual(L.ops,[['rate',1.25],['rate',1],['rate',1.25],['rate',1]]);
 });
 await check('R14Y-16:a final trial cannot reopen a rejected trial or reuse another segment',()=>{
  const L=lab({rates:[1,1.25]}), scope='room:video:epoch:seg3';
  for(const [verdict,nextScope,error] of [
    ['rejected',scope,.35], [undefined,'room:video:epoch:seg4',.35], [undefined,scope,1.1]
  ]){
    const gate=L.ctx.WatchFusionReleaseEvidence.createTvRateRecheckGate();
    const evidence={scope,io:L.io,rateHonored:false,quietStallMs:30000,quietRejoinMs:30000};
    for(let t=0;t<=4500;t+=250)gate.consider({...evidence,nowMs:t,error:1.65});
    assert.equal(gate.snapshot().attempts,1);
    gate.settle(scope,verdict);
    for(let t=5000;t<=20000;t+=250){
      assert.equal(gate.consider({...evidence,scope:nextScope,nowMs:t,error}),null);
    }
    assert.equal(gate.snapshot().attempts,1);
  }
 });
 await check('ADAPTIVE06D-01:stale-TV-gain-does-not-drive-790ms-lag-through-target',()=>{
  const L=lab({rates:[.75,1,1.25],startingError:-.79,savedModel:{rateGain:.71}});
  play(L,{end:65000,step:250});
  assert.ok(Math.abs(L.position()-L.now()/1000)<=.05,`residual ${L.position()-L.now()/1000}`);
  assert.deepEqual(L.ops,[['rate',1.25],['rate',1]]);
 });
 await check('ADAPTIVE06D-02:inconclusive-790ms-trial-allows-one-qualified-opposite-direction-finish',()=>{
  const L=lab({rates:[.75,1,1.25]}), scope='room:video:epoch:seg3';
  const gate=L.ctx.WatchFusionReleaseEvidence.createTvRateRecheckGate();
  const input={scope,io:L.io,rateHonored:false,quietStallMs:30000,quietRejoinMs:30000};
  for(let t=0;t<=4500;t+=250)gate.consider({...input,nowMs:t,error:.79});
  assert.equal(gate.snapshot().attempts,1);gate.settle(scope,undefined);
  let finish=null;for(let t=5000;t<=20000;t+=250)finish=gate.consider({...input,nowMs:t,error:-.295})||finish;
  assert.equal(finish?.rate,.75);assert.equal(gate.snapshot().attempts,2);gate.settle(scope,undefined);
  for(let t=21000;t<=40000;t+=250)assert.equal(gate.consider({...input,nowMs:t,error:-.295}),null);
 });
 await check('ADAPTIVE06D-03:rejected-trial-never-earns-opposite-direction-retry',()=>{
  const L=lab({rates:[.75,1,1.25]}), scope='room:video:epoch:seg3';
  const gate=L.ctx.WatchFusionReleaseEvidence.createTvRateRecheckGate();
  const input={scope,io:L.io,rateHonored:false,quietStallMs:30000,quietRejoinMs:30000};
  for(let t=0;t<=4500;t+=250)gate.consider({...input,nowMs:t,error:.79});
  gate.settle(scope,'rejected');
  for(let t=5000;t<=20000;t+=250)assert.equal(gate.consider({...input,nowMs:t,error:-.295}),null);
  assert.equal(gate.snapshot().attempts,1);
 });

 await check('ADAPTIVE06D-04:follow-up-is-gated-by-advertised-rate-source-trust-and-scope',()=>{
  const L=lab({rates:[.75,1,1.25]}), scope='room:video:epoch:seg3';
  for(const mode of ['no-slow-rate','untrusted','mirror','changed-segment']){
    const gate=L.ctx.WatchFusionReleaseEvidence.createTvRateRecheckGate();
    const input={scope,io:L.io,rateHonored:false,quietStallMs:30000,quietRejoinMs:30000};
    for(let t=0;t<=4500;t+=250)gate.consider({...input,nowMs:t,error:.79});
    gate.settle(scope,undefined);
    const io={...L.io,...(mode==='no-slow-rate'?{availableRates:()=>[1,1.25]}:mode==='untrusted'?{sourceReferenceQualified:()=>false}:mode==='mirror'?{mirrorContradicted:()=>true}:{})};
    for(let t=5000;t<=20000;t+=250)assert.equal(gate.consider({...input,io,scope:mode==='changed-segment'?'room:video:epoch:seg4':scope,nowMs:t,error:-.295}),null,mode);
    assert.equal(gate.snapshot().attempts,1);
  }
 });
 await check('ADAPTIVE06D-05:phase-brake-is-viewer-only-and-does-not-infer-rate-capability',()=>{
  const L=lab(), brake=L.ctx.WatchFusionReleaseEvidence.viewerRateBrake;
  const io={...L.io,target:()=>1,current:()=>1.01};
  const job={before:.79,recheck:true};
  assert.equal(brake(job,io,50000),true);
  for(const changes of [{hostLinked:true},{follower:false},{sourceBuffering:()=>true},{sourceReferenceQualified:()=>false},{mirrorContradicted:()=>true},{referenceUncertaintyMs:()=>36}])assert.equal(brake(job,{...io,...changes},50000),false);
  assert.equal(brake({...job,before:.079},io,50000),false);
  assert.equal(brake({...job,recheck:false},io,50000),false);
  assert.equal(brake({before:.79},io,50000),false);
 });

 await check('ADAPTIVE06E-01:597ms to 362ms inconclusive trial earns exactly one qualified finish',()=>{
  const L=lab({rates:[.75,1,1.25]}), scope='room:video:epoch:seg3';
  const gate=L.ctx.WatchFusionReleaseEvidence.createTvRateRecheckGate();
  const input={scope,io:L.io,rateHonored:false,quietStallMs:30000,quietRejoinMs:30000};
  for(let t=0;t<=4500;t+=250)gate.consider({...input,nowMs:t,error:.597});
  assert.equal(gate.snapshot().attempts,1);gate.settle(scope,undefined);
  let finish=null;for(let t=5000;t<=20000;t+=250)finish=gate.consider({...input,nowMs:t,error:.362})||finish;
  assert.equal(finish?.rate,1.25);assert.equal(gate.snapshot().attempts,2);gate.settle(scope,undefined);
  for(let t=21000;t<=40000;t+=250)assert.equal(gate.consider({...input,nowMs:t,error:.15}),null);
 });
 await check('ADAPTIVE06E-02:failed progress, rejection and changed scope do not earn a finish',()=>{
  const L=lab({rates:[1,1.25]}), scope='room:video:epoch:seg3';
  for(const [verdict,error,nextScope,initial=.597] of [[undefined,.41,scope],[undefined,.43,scope,.64],['rejected',.362,scope],
      [undefined,.362,'room:video:epoch:seg4'],['honored',.362,scope],[undefined,.597,scope]]){
    const gate=L.ctx.WatchFusionReleaseEvidence.createTvRateRecheckGate();
    const input={scope,io:L.io,rateHonored:false,quietStallMs:30000,quietRejoinMs:30000};
    for(let t=0;t<=4500;t+=250)gate.consider({...input,nowMs:t,error:initial});
    gate.settle(scope,verdict);
    for(let t=5000;t<=20000;t+=250)assert.equal(gate.consider({...input,scope:nextScope,nowMs:t,error}),null);
    assert.equal(gate.snapshot().attempts,1);
  }
 });
 await check('ADAPTIVE06E-03:follow-up dwell restarts when source evidence is lost',()=>{
  const L=lab({rates:[1,1.25]}), scope='room:video:epoch:seg3';
  const gate=L.ctx.WatchFusionReleaseEvidence.createTvRateRecheckGate();
  const input={scope,io:L.io,rateHonored:false,quietStallMs:30000,quietRejoinMs:30000};
  for(let t=0;t<=4500;t+=250)gate.consider({...input,nowMs:t,error:.597});
  gate.settle(scope,undefined);
  for(let t=5000;t<=8000;t+=250)assert.equal(gate.consider({...input,nowMs:t,error:.362}),null);
  assert.equal(gate.consider({...input,io:{...L.io,mirrorContradicted:()=>true},nowMs:8250,error:.362}),null);
  for(let t=8500;t<12500;t+=250)assert.equal(gate.consider({...input,nowMs:t,error:.362}),null);
  assert.equal(gate.consider({...input,nowMs:12500,error:.362})?.rate,1.25);
  assert.equal(gate.snapshot().attempts,2);
 });

}
