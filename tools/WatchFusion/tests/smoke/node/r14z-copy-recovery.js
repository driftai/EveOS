// R14z: Copy Log must not block the playback event loop or alter player state.
// The TV may perform only one source-qualified buffered post-release rescue.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
function read(relative) { return fs.readFileSync(path.join(ROOT,relative),'utf8'); }
function assert(ok, reason) {if(!ok)throw new Error(reason);}
function tvHarness() {
  const ctx={console, window:{}, setTimeout}; ctx.globalThis=ctx;
  vm.runInNewContext(read('public/client/viewer-release-evidence.js'),ctx,{timeout:1500});
  const api=ctx.WatchFusionReleaseEvidence;
  assert(!!api?.tvRecoveryOwner,'TV recovery owner missing');
  const owner=api.tvRecoveryOwner;
  let target=110, current=100, trusted=true, buffered=true, sourceReady=true, state=1, discrepancy=false;
  const io={follower:true,hostLinked:false,linkedSourceActive:()=>true,state:()=>state,
    sourceReferenceQualified:()=>sourceReady,referenceTrusted:()=>trusted,
    sourceBuffering:()=>false,mirrorContradicted:()=>discrepancy,
    referenceUncertaintyMs:()=>15,target:()=>target,current:()=>current,buffered:()=>buffered};
  // Advance the independent room clock; never derive target from decoder motion.
  const block=(value,at,error,why,io)=>{target=100+at/1000+error;return owner.block(value,at,error,why,io);};
  return {owner,block,io,setCurrent:v=>current=v,setTrusted:v=>trusted=v,setBuffered:v=>buffered=v,
    setSourceReady:v=>sourceReady=v,setState:v=>state=v,setDiscrepancy:v=>discrepancy=v};
}
function logHarness({legacy=false,blocked=false}={}) {
  const callbacks={},writes=[],fallback=[],stats={yield:0,renderWrites:0,playCalls:0};
  const area={_value:'',focus(){stats.renderWrites++},select(){stats.renderWrites++},set value(v){this._value=v;stats.renderWrites++},get value(){return this._value}};
  const copy={textContent:'Copy log',disabled:false,addEventListener(n,f){callbacks['copy-'+n]=f}};
  const panel={open:false,addEventListener(){}};
  const clear={addEventListener(){}};const count={textContent:''};
  const prior={focus(){}};
  const document={activeElement:prior,body:{appendChild(node){fallback.push(node)}},
    getElementById(id){return {syncRoomLog:panel,syncRoomLogText:area,syncRoomLogCopy:copy,syncRoomLogClear:clear,syncRoomLogCount:count}[id]||null},
    createElement(){return {style:{},value:'',setAttribute(){},focus(){},select(){},remove(){}}},
    execCommand(){return !blocked}};
  const navigator=legacy?{}:{clipboard:{async writeText(value){writes.push(value);if(blocked)throw new Error('no permission')}}};
  const ctx={console, document,navigator,window:{},roomId:'111',session:{memberId:'host'},
    state:{members:[],source:{title:'Public example'},linkedSourceActive:false},
    performance:{now:()=>1000},estimatedServerNow:()=>1000,
    setTimeout(cb,t){if(t===0)stats.yield++;return setTimeout(cb,t)},Date};
  ctx.window=ctx;
  vm.runInNewContext(read('public/client/sync-room-log.js'),ctx,{timeout:1500});
  assert(typeof ctx.watchFusionRoomSyncLog?.note==='function','Log API unavailable');
  return {ctx,callbacks,writes,fallback,stats,area,copy};
}

export async function runR14zCopyRecoverySmokes() {
  const checks=[];
  async function check(id,fn){try{await fn();checks.push({id,status:'PASS'})}catch(e){checks.push({id,status:'FAIL',error:e.message})}}
  await check('R14Z-01 one bounded TV retry on stable advancing large lag',()=>{
    const h=tvHarness(),id='111:host:videoA:seg1';h.owner.release(id,0);
    let grants=0;for(let at=5000;at<=8000;at+=500){h.setCurrent(100+at/1000);if(!h.block(id,at,3.6,'plateau',h.io))grants++}
    assert(grants===1,'expected one verified buffered retry, got '+grants);
  });
  await check('R14Z-02 no repeated retry after second release',()=>{
    const h=tvHarness(),id='111:host:videoA:seg1';h.owner.release(id,0);
    let firstGrants=0;for(let at=5000;at<=8000;at+=500){h.setCurrent(100+at/1000);if(!h.block(id,at,3.6,'plateau',h.io))firstGrants++}
    assert(firstGrants===1,'first video must consume exactly one retry before testing budget isolation');
    h.owner.release(id,8100);let blocks=0;
    for(let at=13000;at<=16000;at+=500){h.setCurrent(100+at/1000);if(h.block(id,at,3.6,'plateau',h.io))blocks++}
    assert(blocks===7,'duplicate retry was permitted');
  });
  await check('R14Z-03 stalled decoder cannot escape',()=>{
    const h=tvHarness(),id='111:host:stalled:seg1';h.owner.release(id,0);
    for(let at=5000;at<=10000;at+=500)assert(h.block(id,at,3.6,'plateau',h.io),'stalled decoder escaped');
  });
  await check('R14Z-04 unbuffered target cannot escape',()=>{
    const h=tvHarness(),id='111:host:no-buffer:seg1';h.setBuffered(false);h.owner.release(id,0);
    for(let at=5000;at<=10000;at+=500){h.setCurrent(100+at/1000);assert(h.block(id,at,3.6,'plateau',h.io),'unbuffered retry allowed')}
  });
  await check('R14Z-05 source distrust blocks retry',()=>{
    const h=tvHarness(),id='111:host:no-source:seg1';h.setSourceReady(false);h.owner.release(id,0);
    for(let at=5000;at<=10000;at+=500){h.setCurrent(100+at/1000);assert(h.block(id,at,3.6,'plateau',h.io),'untrusted retry allowed')}
  });
  await check('R14Z-06 normal smaller drift retains rejoin guard',()=>{
    const h=tvHarness(),id='111:host:small:seg1';h.owner.release(id,0);
    for(let at=5000;at<=10000;at+=500){h.setCurrent(100+at/1000);assert(h.block(id,at,.25,'plateau',h.io),'small drift bypassed guard')}
  });
  await check('R14Z-07 normal >4s rejoin and manual still pass through',()=>{
    const h=tvHarness(),id='111:host:large:seg1';h.owner.release(id,0);
    assert(h.block(id,5000,4.5,'plateau',h.io)===false,'old large gap rescue was blocked');
    assert(h.block(id,5000,.15,'manual',h.io)===false,'manual override blocked');
  });
  await check('R14Z-08 one retry budget resets only on new video identity',()=>{
    const h=tvHarness(),id='111:host:video1:seg1';h.owner.release(id,0);
    let firstGrants=0;for(let at=5000;at<=8000;at+=500){h.setCurrent(100+at/1000);if(!h.block(id,at,3.6,'plateau',h.io))firstGrants++}
    assert(firstGrants===1,'first video must consume exactly one retry before testing budget isolation');
    const next='111:host:video2:seg1';h.owner.release(next,10000);let grants=0;
    for(let at=15000;at<=18000;at+=500){h.setCurrent(100+at/1000);if(!h.block(next,at,3.6,'plateau',h.io))grants++}
    assert(grants===1,'new video did not receive separate budget');
  });
  await check('R14Z-09 Copy Log yields to playback and maintains JSON schema',async()=>{
    const h=logHarness(),log=h.ctx.watchFusionRoomSyncLog;
    for(let i=0;i<175;i++)log.note('ui-intent',{action:'play',positionMs:i});
    const ready=new Promise(resolve=>{h.ctx.navigator.clipboard.writeText=async v=>{h.writes.push(v);resolve()}});
    h.callbacks['copy-click']();await ready;
    const output=JSON.parse(h.writes[0]);
    assert(output.format==='WatchFusion room sync trace v3','schema changed');
    assert(output.events.length===176,'missing events or copy button intent');
    assert(output.events.at(-1).action==='copy-log','copy intent missing');
    assert(h.stats.yield>=10,'clipboard serialization did not yield');
    assert(h.stats.renderWrites===1,'Copy Log populated live log textarea'); // refreshScope clears it once
  });
  await check('R14Z-10 legacy LAN clipboard keeps full trace offscreen',async()=>{
    const h=logHarness({legacy:true}),log=h.ctx.watchFusionRoomSyncLog;
    for(let i=0;i<40;i++)log.note('ui-intent',{action:'play',positionMs:i});
    h.callbacks['copy-click']();
    await new Promise(r=>setTimeout(r,150));
    assert(h.fallback.length===1,'offscreen fallback not created');
    assert(JSON.parse(h.fallback[0].value).events.length===41,'legacy fallback dropped records');
    assert(!h.area.value.includes('"snapshots"'),'large trace inserted into live panel');
    assert(h.copy.disabled===false,'copy button remained disabled');
  });
  await check('R14Z-11 log export API remains complete and redacted',()=>{
    const h=logHarness(),log=h.ctx.watchFusionRoomSyncLog;
    log.note('ui-intent',{action:'seek',positionMs:12});
    const data=JSON.parse(log.export());
    assert(data.events.length===1 && data.events[0].positionMs===12,'legacy export changed');
    assert(!('roomId' in data),'room ID leaked');
  });
  await check('R14Z-12 blocked clipboard returns manual selection, never playback commands',async()=>{
    const h=logHarness({blocked:true}),log=h.ctx.watchFusionRoomSyncLog;
    log.note('ui-intent',{action:'seek',positionMs:12});
    h.callbacks['copy-click']();await new Promise(r=>setTimeout(r,100));
    assert(h.copy.textContent==='Select to copy','manual copy fallback missing');
    assert(h.area.value.includes('"events"'),'missing manual-copy data');
    assert(h.stats.playCalls===0,'UI copy tried to control playback');
  });
  return checks;
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const results=await runR14zCopyRecoverySmokes();
  for(const r of results)console.log(`${r.status} ${r.id}${r.error?' : '+r.error:''}`);
  console.log(`R14Z SCOPED: ${results.filter(r=>r.status==='PASS').length}/${results.length} PASS`);
  if(results.some(r=>r.status!=='PASS'))process.exitCode=1;
}
