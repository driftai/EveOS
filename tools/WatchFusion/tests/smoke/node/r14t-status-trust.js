// R14t: read-only status evidence qualification falsifiers; driven by the real modules.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const ROOT = process.env.WF_FALSIFIER_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
function uiLab() {
  let now = 200_000;
  const nodes = new Map();
  const node = tag => ({tag, className:'', textContent:'', hidden:false, open:false, children:[], append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},setAttribute(){},addEventListener(){}});
  const lookup = id => {if (!nodes.has(id)) nodes.set(id,node('div'));return nodes.get(id);};
  const context = {
    $:lookup, document:{createElement:node, activeElement:null},
    state:{presentationEpoch:1,playoutSegment:1,source:{videoId:'track-1'},playback:{rate:1,paused:false,position:now/1000,projectedAt:now},linkedSourceActive:false},
    session:{publicId:'host'}, estimatedServerNow:()=>now, isHost:()=>true,
    Math,Date,Number,Map,Set,JSON,Object,console
  };
  context.window=context;
  vm.runInNewContext(read('public/client/precision-policy.js'), context);
  vm.runInNewContext(read('public/client/sync-center.js'),context,{filename:'sync-center.js'});
  const render = peers => {
    const list=node('ul');
    context.watchFusionSyncCenter.renderPeers(list,peers,[{id:'host',name:'Laptop'},{id:'tv',name:'TV'}]);
    return list.children.map(card=>({status:card.children[0].children[1].textContent,metrics:Object.fromEntries(card.children[1].children.map(m=>[m.children[0].textContent,m.children[1].textContent]))}));
  };
  const peer=(member,pos,extra={})=>({member,playoutSegment:context.state.playoutSegment,ready:true,playing:true,buffering:false,positionMs:pos,targetPositionMs:now,roomPositionMs:now,sampledAt:now,rate:1,
    sensor:{clockState:'bounded',clockBoundMs:8},startupPhase:'decoder-confirmed',recentCorrection:'locked',...extra});
  return {render,peer,now:()=>now,advance:ms=>{now+=ms;},state:context.state,progress:context.WatchFusionSyncProgressEvidence};
}
function logLab() {
  let now=Date.now();const elements=new Map();
  const node=()=>({value:'',open:false,textContent:'',addEventListener(){},focus(){},select(){}});
  const get=id=>{if(!elements.has(id))elements.set(id,node());return elements.get(id);};
  const ctx={document:{getElementById:get}, navigator:{}, roomId:'room',session:{memberId:'host',publicId:'host'},
    state:{presentationEpoch:1,playoutSegment:1,hostId:'host',playback:{rate:1,position:now/1000,projectedAt:now},members:[{id:'host',name:'Laptop'},{id:'tv',name:'TV'}]},
    estimatedServerNow:()=>now,performance:{now:()=>now},Date,JSON,Math,Number,Map,Set,Object,console};
  ctx.window=ctx; ctx.isHost=()=>true;
  vm.runInNewContext(read('public/client/precision-policy.js'), ctx);
  vm.runInNewContext(read('public/client/sync-room-log.js'),ctx,{filename:'sync-room-log.js'});
  const peer=(member,offset,overrides={})=>({member,playoutSegment:ctx.state.playoutSegment,ready:true,playing:true,buffering:false,
    sampledAt:now-10,positionMs:now-10+offset,roomPositionMs:now-10,targetPositionMs:now-10,rate:1,
    sensor:{clockState:'bounded',clockBoundMs:8,heldMs:0,audibleOutput:'player'},startupPhase:'decoder-confirmed',recentCorrection:'locked',...overrides});
  const observe=peers=>{ctx.watchFusionRoomSyncLog.observe(peers,{reference:'linked-tab',source:'live'});const data=JSON.parse(ctx.watchFusionRoomSyncLog.export());return data.snapshots.at(-1);};
  return {peer,observe,advance:ms=>{now+=ms;},now:()=>now,log:ctx.watchFusionRoomSyncLog};
}
export async function runR14tStatusChecks(check) {
  await check('R14T-01:bounded-clock-does-not-prove-decoder-playback',()=>{
    const lab=uiLab();const t=lab.progress.createProgressEvidence(), p=lab.peer('tv',100_000,{startupPhase:'decoder-stalled',recentCorrection:'stall-recovery-exhausted'});
    assert.equal(t.inspect([p],lab.now(),'scope').get('tv').state,'stalled');
    assert.equal(t.inspect([p],lab.now(),'scope').get('tv').qualified,false);
  });
  await check('R14T-02:progression-requires-three-real-increasing-samples',()=>{
    const lab=uiLab(), t=lab.progress.createProgressEvidence();
    assert.equal(t.inspect([lab.peer('tv',100_000)],lab.now(),'scope').get('tv').qualified,false);
    lab.advance(700);assert.equal(t.inspect([lab.peer('tv',100_700)],lab.now(),'scope').get('tv').qualified,false);
    lab.advance(800);const q=t.inspect([lab.peer('tv',101_500)],lab.now(),'scope').get('tv');
    assert.equal(q.qualified,true);assert.equal(q.state,'advancing');
  });
  await check('R14T-03:stalled-and-jumped-timestamps-lose-lock-even-with-bounded-clock',()=>{
    const lab=uiLab(), t=lab.progress.createProgressEvidence();
    t.inspect([lab.peer('tv',100_000)],lab.now(),'s');lab.advance(700);t.inspect([lab.peer('tv',100_700)],lab.now(),'s');lab.advance(800);t.inspect([lab.peer('tv',101_500)],lab.now(),'s');
    lab.advance(700);assert.equal(t.inspect([lab.peer('tv',120_000)],lab.now(),'s').get('tv').state,'jumped');
    lab.advance(800);assert.equal(t.inspect([lab.peer('tv',120_000)],lab.now(),'s').get('tv').qualified,false);
    lab.advance(900);assert.equal(t.inspect([lab.peer('tv',120_000)],lab.now(),'s').get('tv').state,'verifying');
    lab.advance(900);assert.equal(t.inspect([lab.peer('tv',120_000)],lab.now(),'s').get('tv').state,'position-held');
  });
  await check('R14T-04:scope-change-brief-pause-and-stale-reports-cannot-inherit-lock',()=>{
    const lab=uiLab(), t=lab.progress.createProgressEvidence();
    t.inspect([lab.peer('tv',100_000)],lab.now(),'song1');lab.advance(700);t.inspect([lab.peer('tv',100_700)],lab.now(),'song1');lab.advance(800);
    assert.equal(t.inspect([lab.peer('tv',101_500)],lab.now(),'song1').get('tv').qualified,true);
    assert.equal(t.inspect([lab.peer('tv',101_500)],lab.now(),'song2').get('tv').qualified,false);
    assert.equal(t.inspect([lab.peer('tv',101_500,{playing:false})],lab.now(),'song2').get('tv').state,'paused');
    assert.equal(t.inspect([lab.peer('tv',101_500,{sampledAt:lab.now()-5000})],lab.now(),'song2').get('tv').state,'stale');
  });
  await check('R14T-05:200ms-shared-offset-does-not-claim-two-players-out-of-sync',()=>{
    const l=uiLab();
    let cards=l.render([l.peer('host',l.now()-180),l.peer('tv',l.now()-200)]);
    assert.match(cards[0].metrics['Player-to-player timeline spread'],/Unverified/);
    l.advance(700);cards=l.render([l.peer('host',l.now()-180),l.peer('tv',l.now()-200)]);
    l.advance(900);cards=l.render([l.peer('host',l.now()-180),l.peer('tv',l.now()-200)]);
    assert.match(cards[0].metrics['Player-to-player timeline spread'],/20 ms/);
    assert.match(cards[0].metrics['Player vs room target (not audio)'],/−180 ms|\-180 ms/);
    assert.doesNotMatch(cards[0].metrics['Player-to-player timeline spread'],/180 ms|200 ms/);
  });
  await check('R14T-06:decoder-stall-hides-misleading-group-spread-and-lock-badge',()=>{
    const l=uiLab();l.render([l.peer('host',l.now()-10),l.peer('tv',l.now()-12)]);
    l.advance(700);l.render([l.peer('host',l.now()-10),l.peer('tv',l.now()-12)]);
    l.advance(900);l.render([l.peer('host',l.now()-10),l.peer('tv',l.now()-12)]);
    l.advance(700);const cards=l.render([l.peer('host',l.now()-10),l.peer('tv',l.now()-8500,{startupPhase:'decoder-stalled',recentCorrection:'stall-recovery-exhausted'})]);
    assert.match(cards[0].metrics['Player-to-player timeline spread'],/Unverified|N\/A/);
    assert.match(cards[1].status,/Decoder stalled/);
    assert.match(cards[1].metrics['Player vs room target (not audio)'],/Unverified/);
    assert.ok(!('Player-room position (diagnostic)' in cards[1].metrics));
  });
  await check('R14T-07:log-preserves-raw-stall-position-but-denies-trusted-offset',()=>{
    const l=logLab();const s=l.observe([l.peer('host',-10),l.peer('tv',-22000,{startupPhase:'decoder-stalled',recentCorrection:'stall-recovery-exhausted'})]);
    const tv=s.peers.find(x=>x.device==='TV');
    assert.equal(tv.rawOffsetMs,-22000);assert.equal(tv.targetErrorMs,null);
    assert.equal(tv.timingQuality,'decoder-progress-unverified');
    assert.ok(tv.signals.includes('DECODER_PROGRESS_UNVERIFIED'));
    assert.equal(s.groupPhase,'unmeasured-single-player');assert.equal(s.groupSpreadMs,null);
  });
  await check('R14T-08:log-keeps-healthy-progress-facts-without-changing-controller',()=>{
    const l=logLab();const s=l.observe([l.peer('host',-180),l.peer('tv',-200)]);
    assert.equal(s.groupSpreadMs,20);assert.equal(s.groupPhase,'common-mode-offset');
    assert.equal(s.peers.find(x=>x.device==='TV').targetErrorMs,-200);
  });
  await check('R14T-10:exported-trace-includes-the-active-timing-policy-and-host-rate-verdict',()=>{
    const {log}=logLab();
    const detail={reason:'measured-improvement',beforeMs:59,residualMs:42,progressMs:17,expectedMs:41};
    log.note('host-zero-rate-recheck-verified',{...detail,extra:'discard'});
    const data=JSON.parse(log.export());
    assert.equal(data.diagnosticsVersion,'v13.10.8x-room-recovery');
    const event=data.events.find(e=>e.kind==='host-zero-rate-recheck-verified');
    for(const [key,value] of Object.entries(detail)) assert.equal(event[key],value);
    assert.equal(event.extra,undefined);
  });
  await check('R14T-09:status-modules-never-call-seek-play-pause-rate-or-source-controls',()=>{
    const s=read('public/client/sync-center.js'), t=read('public/client/sync-room-log.js');
    for (const text of [s,t]) {
      assert.doesNotMatch(text,/\.seekTo\(|\.playVideo\(|\.pauseVideo\(|\.setPlaybackRate\(|\.loadVideoById\(|\.control\(['"](?:seek|pause|play)/);
    }
  });
}
