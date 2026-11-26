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
// A gross-lag fast trial may qualify on a brief fresh window, but never on stale timing.
function grossRecoveryLab(){
 const ctx={Math,Number,Date,Map,Set,Object,JSON};ctx.globalThis=ctx;
 vm.runInNewContext(read('public/client/viewer-release-evidence.js'),ctx);
 const gate=ctx.WatchFusionReleaseEvidence.createTvRateRecheckGate();
 let at=0,lag=1.47,qualified=true,mirror=false,buffering=false,mode='moving',scope='room:video:epoch:seg3',precision=12,player=1,valid=true;
 const io={baseRate:1,follower:true,hostLinked:false,linkedSourceActive:()=>true,state:()=>player,valid:()=>valid,
   availableRates:()=>[1,1.25],referenceTrusted:()=>qualified,sourceReferenceQualified:()=>qualified,referenceUncertaintyMs:()=>precision,
   sourceBuffering:()=>buffering,mirrorContradicted:()=>mirror,now:()=>at,target:()=>30+at/1000+(mode==='jump'?at>=500?.2:0:0),
   current:()=>mode==='frozen'?30-lag:30+at/1000-lag+(mode==='mismatch'?.15:0)};
 const sample=(t,patch={})=>{at=t;({lag,qualified,mirror,buffering,mode,scope,precision,player,valid}={lag,qualified,mirror,buffering,mode,scope,precision,player,valid,...patch});return gate.consider({scope,nowMs:at,error:lag,io,rateHonored:false,quietStallMs:30000,quietRejoinMs:30000});};
 const start=(t=0,patch={})=>{let r=null;for(let v=t;v<=t+750;v+=250)r=sample(v,patch)||r;return r;};
 const interrupt=(t,elapsed,extra,patch={},verdict=undefined)=>{const before=io.current();at=t+elapsed;qualified=false;({mirror,buffering,valid}={mirror,buffering,valid,...patch});lag-=extra;
  gate.settle(scope,verdict,{probe:{nowMs:t,current:before},rate:1.25,valid:()=>valid},io);};
 return {gate,sample,start,interrupt,observe:(t,patch)=>{at=t;({qualified,mirror,buffering,player,valid}={qualified,mirror,buffering,player,valid,...patch});gate.observeLock(scope,t,NaN,io);}};
}
async function run06jideChecks(check){
 await check('WF06JIDE-01:gross stable advancing TV qualifies in 750ms of fresh evidence instead of waiting 2500ms',()=>{
  const L=grossRecoveryLab();for(let t=0;t<750;t+=250)assert.equal(L.sample(t),null);assert.equal(L.sample(750)?.rate,1.25);assert.equal(L.gate.snapshot().attempts,1);
 });  await check('WF06JIDE-02:missing reference windows recover without accumulating stale evidence',()=>{
  const L=grossRecoveryLab();for(let t=0;t<=500;t+=250)assert.equal(L.sample(t),null);assert.equal(L.sample(750,{qualified:false}),null);
  for(let t=1000;t<1750;t+=250)assert.equal(L.sample(t,{qualified:true}),null);assert.equal(L.sample(1750)?.rate,1.25);
 });  await check('WF06JIDE-03:fast gross acquisition requires raw motion and fresh noncontradictory reference',()=>{
  for(const patch of [{mode:'frozen'},{mode:'mismatch'},{mode:'jump'},{qualified:false},{mirror:true},{buffering:true},{precision:36},{player:3},{valid:false},{lag:.79}]){
   const L=grossRecoveryLab();assert.equal(L.start(0,patch),null,JSON.stringify(patch));assert.equal(L.gate.snapshot().attempts,0);
  }
 });  await check('WF06JIDE-04:brief pre-verdict dropout permits only one inconclusive gross retry',()=>{
  const L=grossRecoveryLab();assert.equal(L.start()?.rate,1.25);L.interrupt(750,250,0);assert.equal(L.sample(1250),null);
  assert.equal(L.start(1500,{qualified:true})?.rate,1.25);L.interrupt(2250,250,0);assert.equal(L.start(3000,{qualified:true}),null);assert.equal(L.gate.snapshot().attempts,2);
 });  await check('WF06JIDE-05:measured interrupted gross progress earns at most two fresh continuations',()=>{
  const L=grossRecoveryLab();assert.equal(L.start()?.rate,1.25);L.interrupt(750,800,.2);assert.equal(L.sample(1750),null);
  assert.equal(L.start(2000,{qualified:true})?.rate,1.25);L.interrupt(2750,800,.2);assert.equal(L.start(4000,{qualified:true})?.rate,1.25);
  L.interrupt(4750,800,.2);for(let t=6000;t<=15000;t+=250)assert.equal(L.sample(t,{qualified:true}),null);assert.equal(L.gate.snapshot().attempts,3);
 });  await check('WF06JIDE-06:contradiction buffering rejection stale scope and invalid job never earn a gross continuation',()=>{
  for(const mode of ['mirror','buffering','rejected','scope','invalid']){
   const L=grossRecoveryLab();assert.equal(L.start()?.rate,1.25);L.interrupt(750,800,.2,{mirror:mode==='mirror',buffering:mode==='buffering',valid:mode!=='invalid'},mode==='rejected'?'rejected':undefined);
   for(let t=2000;t<=7000;t+=250)assert.equal(L.sample(t,{qualified:true,mirror:false,buffering:false,valid:true,...(mode==='scope'?{scope:'room:video:epoch:seg4'}:{})}),null,mode);assert.equal(L.gate.snapshot().attempts,1);
  }
 });  await check('WF06JIDE-07:spent expedited trial still waits on unqualified reference instead of dropping seek guard',()=>{
  const L=grossRecoveryLab();assert.equal(L.start()?.rate,1.25);L.interrupt(750,800,0,{},'rejected');assert.equal(L.sample(2000),null);assert.equal(L.gate.snapshot().watching,true);
  assert.equal(L.gate.snapshot().reason,'rate-trial-awaiting-qualified-reference');assert.equal(L.sample(2250,{qualified:true}),null);assert.equal(L.gate.snapshot().watching,false);
 });
 await check('WF06JIDE-08:contradiction observed between decisions invalidates expedited evidence',()=>{
  const L=grossRecoveryLab();for(let t=0;t<=500;t+=250)assert.equal(L.sample(t),null);
  L.observe(625,{mirror:true});assert.equal(L.sample(750,{mirror:false}),null);
  assert.equal(L.sample(1000),null);assert.equal(L.sample(1250),null);assert.equal(L.sample(1500)?.rate,1.25);
 });
}
// Post-reload decoder progress transfers ordinary rejoin qualification, never actuator ownership.
function postDecoderLab(){
 let at=1000,pos=100,lag=1.1,qualified=true,mirror=false,buffer=true,valid=true,playing=1,raw='ROOM:VIDEO:4:7',targetShift=0;const ops=[],c={document:{hidden:false},performance:{now:()=>at},setTimeout:()=>1,clearTimeout(){},storage:{get:()=>null,set:()=>{}},WatchFusionTimelineMath:{observePosition:(t,v)=>({value:v,since:t}),projectedPosition:(t,v)=>v,chooseRate:()=>null}};c.window=c.globalThis=c;
 for(const f of ['tv-decoder-rescue','viewer-release-evidence','viewer-sync-arbiter'])vm.runInNewContext(read('public/client/'+f+'.js'),c);
 const d=c.WatchFusionDecoderRescue,o=c.WatchFusionReleaseEvidence.tvRecoveryOwner,a=c.WatchFusionViewerSyncArbiter.createViewerSyncArbiter({timers:{setTimeout:()=>1,clearTimeout(){}}});const io={follower:true,hostLinked:false,tvIdentity:'ROOM:VIDEO:4',baseRate:1,now:()=>at,state:()=>playing,valid:()=>valid,linkedSourceActive:()=>true,current:()=>pos,target:()=>100+(at-1000)/1000+lag+targetShift,referenceTrusted:()=>qualified,sourceReferenceQualified:()=>qualified,referenceUncertaintyMs:()=>12,sourceBuffering:()=>false,mirrorContradicted:()=>mirror,buffered:()=>buffer,availableRates:()=>[1],speakerPhaseVerified:()=>false,rate:v=>ops.push(['rate',v]),pause:()=>{ops.push(['pause']);playing=2;},play:()=>{ops.push(['play']);playing=1;},seek:(v,net)=>{ops.push(['seek',net]);pos=v;}};
 function set(t,options={}){at=t;({lag,qualified,mirror,buffer,valid,playing,raw,targetShift}={lag,qualified,mirror,buffer,valid,playing,raw,targetShift,...options});pos=options.pos??100+(at-1000)/1000+targetShift;d.observeTransport({scope:raw,nowMs:at,paused:false});}
 const input=(more={})=>({scope:raw,nowMs:at,playing:true,buffering:false,exhausted:false,stalledMs:0,position:pos,drift:-lag,trusted:qualified,sourceBuffering:false,sourceQualified:qualified,mirrorContradicted:mirror,reload:()=>ops.push(['reload']),rebuild:()=>ops.push(['rebuild']),...more});d.observeTransport({scope:raw,nowMs:at,paused:false});assert.equal(d.consider(input({qualifiedStall:true,exhausted:true,stalledMs:6500,drift:-6})),true);o.release(io.tvIdentity,at);
 function warmup(mode='good'){for(let t=1000;t<=(mode==='expired'?13500:5000);t+=250){set(t,{...(mode==='good'?{}:{pos:100})});d.settling({scope:raw,nowMs:t,ready:true,playing:true,buffering:false,position:pos,rate:1});}}
 const tryRejoin=(t,options={})=>{set(t,options);d.consider(input());return !o.block(io.tvIdentity,at,lag,'rejoin',io)&&d.allowAutomaticRejoin({nowMs:at,error:lag,io,lead:1.5});};return {d,o,a,io,c,ops,set,warmup,tryRejoin,input,scope:()=>raw};
}
async function run06jidhChecks(check){
 await check('WF06JIDH-01:measured decoder warmup delegates to one buffered rejoin before the old duplicate timeout',()=>{const L=postDecoderLab();assert.equal(L.o.block(L.io.tvIdentity,1500,1.1,'rejoin',L.io),true);L.warmup();const accepted=[];for(let t=5000;t<=40000;t+=250)if(L.tryRejoin(t))accepted.push(t);assert.deepEqual(accepted,[13000]);assert.deepEqual(L.ops,[['reload']]);});
 await check('WF06JIDH-02:frozen or expired warmup does not qualify a post-release handoff',()=>{const L=postDecoderLab();L.warmup('frozen');assert.equal(L.o.block(L.io.tvIdentity,5000,1.1,'rejoin',L.io),true);L.warmup('expired');assert.equal(L.o.block(L.io.tvIdentity,14000,1.1,'rejoin',L.io),true);});
 await check('WF06JIDH-03:source reference interruption resets the buffered rejoin evidence window',()=>{const L=postDecoderLab();L.warmup();for(let t=5000;t<=10000;t+=250)assert.equal(L.tryRejoin(t),false);assert.equal(L.tryRejoin(10250,{qualified:false}),false);const accepted=[];for(let t=10500;t<=25000;t+=250)if(L.tryRejoin(t,{qualified:true}))accepted.push(t);assert.deepEqual(accepted,[18500]);});
 await check('WF06JIDH-04:unbuffered landing or frozen raw position cannot earn a rejoin',()=>{const L=postDecoderLab();L.warmup();for(let t=5000;t<=16000;t+=250)assert.equal(L.tryRejoin(t,{buffer:false}),false);for(let t=16250;t<=26000;t+=250)assert.equal(L.tryRejoin(t,{buffer:true,pos:100}),false);});
 await check('WF06JIDH-05:five-second boundary cannot bypass a verified decoder recovery budget',()=>{const L=postDecoderLab();L.warmup();const accepted=[];for(let t=5000;t<=30000;t+=250)if(L.tryRejoin(t,{lag:5.1}))accepted.push(t);assert.deepEqual(accepted,[13000]);});
 await check('WF06JIDH-06:real arbiter uses existing pause and buffered seek after qualified decoder handoff',()=>{const L=postDecoderLab();L.warmup();let first=null;for(let t=5000;t<=23000;t+=250){L.set(t);L.d.consider(L.input());L.a.tick(L.scope(),t,L.io);if(L.ops.some(x=>x[0]==='seek')){first=t;break;}}assert.ok(first!==null&&first<26000);assert.deepEqual(L.ops,[['reload'],['pause'],['seek',false]]);});
 await check('WF06JIDH-07:segment change clears measured handoff without replenishing spent rejoin budget',()=>{const L=postDecoderLab();L.warmup();for(let t=5000;t<=13000;t+=250)L.tryRejoin(t);L.set(13500,{raw:'ROOM:VIDEO:4:8'});assert.equal(L.o.block(L.io.tvIdentity,13500,1.1,'rejoin',L.io),true);for(let t=14000;t<=40000;t+=250)assert.equal(L.tryRejoin(t),false);});
}
// TV acquisition: shortened qualified dwell, bounded residual finish, and observable blockers.
function acquisitionLab(initial=.215){let now=0,lag=initial,qualified=true,precision=12,mode='normal',scope='room:video:epoch:seg3',valid=true,mirror=false,buffer=false,rates=[.75,1,1.25],quiet=30000,player=1;const c={};c.globalThis=c;vm.runInNewContext(read('public/client/viewer-release-evidence.js'),c);const gate=c.WatchFusionReleaseEvidence.createTvRateRecheckGate(),target=()=>30+(mode==='frozen'?0:now/1000)+(mode==='jump'&&now>=3200?.2:0),io={baseRate:1,follower:true,hostLinked:false,valid:()=>valid,linkedSourceActive:()=>true,state:()=>player,availableRates:()=>rates,referenceTrusted:()=>qualified,sourceReferenceQualified:()=>qualified,referenceUncertaintyMs:()=>precision,sourceBuffering:()=>buffer,mirrorContradicted:()=>mirror,now:()=>now,target,current:()=>target()-lag+(mode==='mismatch'?.15:0)};
const set=(t,patch={})=>{now=t;({lag,qualified,precision,mode,scope,valid,mirror,buffer,rates,quiet,player}={lag,qualified,precision,mode,scope,valid,mirror,buffer,rates,quiet,player,...patch});};const sample=(t,patch={})=>{set(t,patch);return gate.consider({scope,nowMs:now,error:lag,io,rateHonored:false,quietStallMs:quiet,quietRejoinMs:quiet});};const observe=(t,patch={})=>{set(t,patch);gate.observeLock(scope,now,NaN,io);};const settle=(t,extra,patch={},verdict=undefined)=>{const before=io.current(),at=now,rate=lag>0?1.25:.75;set(t,{lag:lag-extra,...patch});gate.settle(scope,verdict,{probe:{nowMs:at,current:before},rate,valid:()=>valid},io);};const run=(a,b,patch=()=>({}),step=250)=>{const accepted=[];for(let t=a;t<=b;t+=step){const r=sample(t,patch(t));if(r)accepted.push([t,r.rate]);}return accepted;};return {gate,io,sample,observe,settle,run};}
async function run06jidiChecks(check){
 await check('WF06JIDI-01:moderate lead and lag qualify after six seconds quiet plus fresh raw dwell',()=>{for(const error of [.215,-.18]){const L=acquisitionLab(error);assert.deepEqual(L.run(0,8500,t=>({quiet:t})),[[8500,error>0?1.25:.75]]);assert.equal(L.gate.snapshot().attempts,1);}});
 await check('WF06JIDI-02:frozen raw samples or mismatched projected phase never earn expedited motion proof',()=>{for(const mode of ['frozen','mismatch']){const L=acquisitionLab();assert.deepEqual(L.run(0,16000,()=>({mode}),50),[]);assert.equal(L.gate.snapshot().attempts,0);}const L=acquisitionLab();assert.deepEqual(L.run(1000,5500,()=>({mode:'jump'})),[]);assert.deepEqual(L.run(5750,6000),[[5750,1.25]]);});
 await check('WF06JIDI-03:reference or precision dropout between decisions restarts moderate acquisition dwell',()=>{for(const patch of [{qualified:false},{precision:36},{mirror:true},{buffer:true},{valid:false}]){const L=acquisitionLab();assert.deepEqual(L.run(0,2000),[]);L.observe(2125,patch);assert.deepEqual(L.run(2250,4500,()=>({qualified:true,precision:12,mirror:false,buffer:false,valid:true})),[]);assert.deepEqual(L.run(4750,4750),[[4750,1.25]]);}});
 await check('WF06JIDI-04:a measured 340ms to 105ms reduction earns exactly one bounded finish',()=>{const L=acquisitionLab(.34);assert.deepEqual(L.run(0,2500),[[2500,1.25]]);L.settle(3440,.235);assert.deepEqual(L.run(3500,6000),[[6000,1.25]]);L.settle(6420,0);assert.deepEqual(L.run(6500,30000),[]);assert.equal(L.gate.snapshot().attempts,2);});
 await check('WF06JIDI-05:rejected invalid contradictory or rebased trials never earn a narrow residual finish',()=>{for(const mode of ['rejected','invalid','mirror','buffer','untrusted','jump','no-motion','segment']){const L=acquisitionLab(.34);assert.deepEqual(L.run(0,2500),[[2500,1.25]]);L.settle(3440,.235,{...(mode==='invalid'?{valid:false}:mode==='mirror'?{mirror:true}:mode==='buffer'?{buffer:true}:mode==='untrusted'?{qualified:false}:mode==='jump'?{mode:'jump'}:mode==='no-motion'?{lag:.34}:mode==='segment'?{scope:'room:video:epoch:seg4'}:{})},mode==='rejected'?'rejected':undefined);assert.deepEqual(L.run(3500,22000,()=>({lag:.105,qualified:true,precision:12,mirror:false,buffer:false,valid:true,mode:'normal',...(mode==='segment'?{scope:'room:video:epoch:seg4'}:{})})),[],mode);assert.equal(L.gate.snapshot().attempts,1);}});
 await check('WF06JIDI-06:moderate rate gate identifies quiet reference precision motion and capability blockers',()=>{const L=acquisitionLab();for(const [t,patch,reason] of [[0,{quiet:0},'rate-trial-quiet-time'],[7000,{quiet:30000,qualified:false},'rate-trial-awaiting-qualified-reference'],[7250,{qualified:true,precision:36},'rate-trial-precision'],[7500,{precision:12,mode:'mismatch'},'rate-trial-motion'],[7750,{mode:'normal',rates:[1]},'no-advertised-rate-actuator'],[8000,{rates:[1,1.25]},'stable-rate-trial-dwell']]){assert.equal(L.sample(t,patch),null);assert.equal(L.gate.snapshot().reason,reason);}assert.equal(L.gate.snapshot().attempts,0);});
 await check('WF06JIDI-07:remote acquisition transitions are captured at fresh report cadence and statuses identify the real gate',()=>{const line=read('public/client/sync-room-log.js').split(/\r?\n/).find(x=>x.includes('const acquisitionState='));assert.ok(line);const changed=new Function(line+'\nreturn acquisitionChanged;')();const p={role:'viewer',reportAgeMs:400,action:'tv-rate-trial-dwell',decoderRecovery:{arbiterReason:'tv-rate-trial-dwell'}},q={...p,action:'output-phase-unverified',decoderRecovery:{arbiterReason:'output-phase-unverified'}};assert.equal(changed(p,q),true);assert.equal(changed(p,p),false);assert.equal(changed({...p,reportAgeMs:1501},q),false);assert.equal(changed({...p,reportAgeMs:null},q),false);assert.equal(changed({...p,role:'host'},q),false);assert.ok(read('public/client/sync-room-log.js').includes('||acquisitionChanged(p,q)'));const arb=read('public/client/viewer-sync-arbiter.js');for(const reason of ['tv-rate-trial-awaiting-quiet','tv-rate-trial-awaiting-reference','tv-rate-trial-awaiting-precision','tv-rate-trial-awaiting-motion','tv-rate-trial-dwell','tv-rate-trial-spent']){assert.ok(arb.includes("'"+reason+"'"));assert.ok(read('public/playback-sync.js').includes("'"+reason+"':"));}assert.ok(read('public/playback-sync.js').includes('speaker phase unverified'));});
}
export async function runR14yChecks(check){
 await run06jideChecks(check);
 await run06jidfChecks(check);
 await run06jidgChecks(check);
 await run06jidhChecks(check); await run06jidiChecks(check); await run06jidjChecks(check); await run06jidkChecks(check,ROOT);
 await check('WF06JE-01:advancing 330ms post-release TV lag acquires within the shortened qualified window',()=>{
  const L=lab({rates:[1,1.25],startingError:-.33,savedModel:{rateGain:1}});
  play(L,{end:56000,step:50});
  assert.ok(Math.abs(L.position()-L.now()/1000)<=.05,`residual ${L.position()-L.now()/1000}`);
  assert.deepEqual(L.ops,[['rate',1.25],['rate',1]]);
 });
 await check('WF06JE-02:shortened plateau lane requires fresh continuous raw progress and qualified source',()=>{
  const scope='room:video:epoch:seg3';
  for(const mode of ['healthy','frozen','jump','mirror','untrusted','raw-mismatch','target-jump','gap']){
   const L=lab({rates:[1,1.25]}),gate=L.ctx.WatchFusionReleaseEvidence.createTvRateRecheckGate();
   let result=null;
   for(let t=0;t<=5000;t+=mode==='gap'?1500:250){
    const pos=30+t/1000+(mode==='jump'&&t>=1500?.2:0),target=30+t/1000+.33+(mode==='target-jump'&&t>=1500?.2:0);
    const io={...L.io,current:()=>mode==='frozen'?30:mode==='raw-mismatch'?pos+.15:pos,target:()=>target,mirrorContradicted:()=>mode==='mirror',sourceReferenceQualified:()=>mode!=='untrusted'};
    result=gate.consider({scope,io,nowMs:t,error:.33,rateHonored:false,quietStallMs:5000+t,quietRejoinMs:6000+t})||result;
   }
   assert.equal(result?.rate,mode==='healthy'?1.25:undefined,mode);
  }
 });
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

import {run06jidfChecks,run06jidgChecks} from './06jid-background-playback.js';
import {run06jidjChecks} from './06jidj-practical-playback.js';
export {run06jidjChecks};

import {run06jidkChecks} from './06jidk-recovery-continuity.js';
