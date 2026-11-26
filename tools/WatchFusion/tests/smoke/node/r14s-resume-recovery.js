// R14s regression contracts: baseline-compatible tests for a terminal TV decoder
// across a real room pause/resume. No browser/audio/YouTube output is simulated.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const ROOT = process.env.WF_R14S_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SCOPE = 'ROOM:AAAAAAAAAAA:4:20';
function lab(store = new Map(), wallBase = 1000000) {
  let wall = wallBase; class ClockDate extends Date {static now(){return wall;}}
  let hidden = false;
  const actions = [], notes = [];
  const ctx = {window: {watchFusionRoomSyncLog:{note:(kind, detail)=>notes.push([kind,detail])}},
    document:{get hidden(){return hidden;}}, sessionStorage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)}, Number, Math, Date:ClockDate, console};
  vm.runInNewContext(read('public/client/tv-decoder-rescue.js'), ctx);
  const rescue = ctx.window.WatchFusionDecoderRescue;
  const input = (t, opts = {}) => (wall=wallBase+t,{scope:SCOPE, nowMs:t, buffering:true, playing:false, exhausted:false,
    trusted:true, sourceBuffering:false, drift:-12, position:0,
    reload:()=>actions.push('reload'),rebuild:()=>actions.push('rebuild'),...opts});
  const wedge = (from,to,opts={})=>{for(let t=from;t<=to;t+=250)rescue.consider(input(t,opts));};
  return {rescue, input, actions, notes, wedge, setHidden:v=>{hidden=v;}};
}
function exhaust(L) { L.wedge(0,55000); assert.deepEqual(L.actions,['reload','rebuild']); assert.equal(L.rescue.diagnostics().steps,2); }

export async function runR14sRecoveryChecks(check) {
  const proven = {playing:true,buffering:false,exhausted:true,qualifiedStall:true,stalledMs:6500,drift:7};
  await check('WF06JC-01:verified exhausted stall reuses evidence and failed reload escalates before old delay',()=>{
    const L=lab(); assert.equal(L.rescue.consider(L.input(7000,proven)),true);assert.deepEqual(L.actions,['reload']);
    for(let t=7250;t<15000;t+=250)assert.equal(L.rescue.consider(L.input(t,{...proven,fastOnly:true})),false);
    assert.equal(L.rescue.consider(L.input(15000,{...proven,fastOnly:true})),true);
    assert.deepEqual(L.actions,['reload','rebuild']);assert.equal(L.notes.at(-1)[1].reason,'verified-reload-failure');
    for(let t=15250;t<45000;t+=250)L.rescue.consider(L.input(t,{...proven,fastOnly:true}));
    assert.deepEqual(L.actions,['reload','rebuild']);
  });
  await check('WF06JC-02:reload failure shortcut cannot act on hidden stale buffering or unproven motion',()=>{
    for(const bad of [{qualifiedStall:false},{trusted:false},{sourceBuffering:true},{stalledMs:5999},{playing:false},{buffering:true},{position:NaN}]){
      const L=lab();L.rescue.consider(L.input(7000,proven));
      for(let t=15000;t<22000;t+=250)assert.equal(L.rescue.consider(L.input(t,{...proven,...bad,fastOnly:true})),false);
      assert.deepEqual(L.actions,['reload']);
    }
    const L=lab();L.rescue.consider(L.input(7000,proven));L.setHidden(true);assert.equal(L.rescue.consider(L.input(15000,{...proven,fastOnly:true})),false);
    L.setHidden(false);for(let t=15000;t<30000;t+=250)L.rescue.consider(L.input(t,{...proven,fastOnly:true,exhausted:false,stalledMs:0,position:t/1000}));
    assert.deepEqual(L.actions,['reload']);
  });
  await check('WF06JC-03:same tab refresh retains attempted ladder but requires fresh failure proof',()=>{
    const store=new Map(), A=lab(store);A.rescue.consider(A.input(7000,proven));
    const B=lab(store,1009000); B.rescue.consider(B.input(0,{...proven,stalledMs:0,fastOnly:true}));
    assert.equal(B.rescue.diagnostics().steps,1);assert.equal(B.notes[0][0],'tv-decoder-resumed');assert.deepEqual(B.actions,[]);
    assert.equal(B.rescue.consider(B.input(6000,{...proven,fastOnly:true})),true);assert.deepEqual(B.actions,['rebuild']);
    const C=lab(store,1016000);C.rescue.consider(C.input(0,{...proven,stalledMs:0,fastOnly:true}));assert.equal(C.rescue.diagnostics().steps,2);
    C.wedge(7000,45000,proven);assert.deepEqual(C.actions,[]);
    const D=lab(store,1020000);D.rescue.consider(D.input(0,{...proven,scope:'OTHER:BBBBBBBBBBB:5:1',stalledMs:0,fastOnly:true}));assert.equal(D.rescue.diagnostics().steps,0);
  });
  await check('WF06JC-04:expired or reversed wall clock never resurrects decoder recovery state',()=>{
    for(const base of [999000,1708000]){const store=new Map(),A=lab(store);A.rescue.consider(A.input(7000,proven));const B=lab(store,base);B.rescue.consider(B.input(0,{...proven,stalledMs:0,fastOnly:true}));assert.equal(B.rescue.diagnostics().steps,0);assert.deepEqual(B.actions,[]);}
  });

  await check('R14S-01:terminal-after-two-steps-stays-spent-while-source-remains-playing',()=>{
    const L=lab(); exhaust(L);L.wedge(60000,120000);
    assert.deepEqual(L.actions,['reload','rebuild']);
    assert.equal(L.rescue.diagnostics().outcome,'terminal-recovery-spent');
  });
  await check('R14S-13:explicit-restart-requires-a-stuck-player-and-preserves-the-automatic-budget',()=>{
    const L=lab(); exhaust(L);
    assert.equal(L.rescue.consider(L.input(60000,{manual:true,trusted:false})),false);
    assert.equal(L.rescue.consider(L.input(61000,{manual:true,sourceBuffering:true})),false);
    assert.equal(L.rescue.consider(L.input(62000,{manual:true,drift:-.25})),false);
    assert.equal(L.rescue.consider(L.input(63000,{manual:true,buffering:false,playing:true})),false);
    assert.deepEqual(L.actions,['reload','rebuild']);
    assert.equal(L.rescue.consider(L.input(64000,{manual:true})),true);
    assert.equal(L.rescue.consider(L.input(64250,{manual:true})),true);
    L.wedge(65000,100000);
    assert.deepEqual(L.actions,['reload','rebuild','rebuild']);
    assert.equal(L.rescue.diagnostics().steps,2);
    assert.equal(L.notes.filter(([kind])=>kind==='tv-decoder-manual-restart').length,1);
  });
  await check('R14S-02:long-real-pause-resume-rearms-once-then-requires-new-9s-buffer-evidence',()=>{
    const L=lab(); exhaust(L);
    assert.equal(L.rescue.observeTransport({scope:SCOPE, nowMs:80000, paused:true}),false);
    assert.equal(L.rescue.observeTransport({scope:SCOPE, nowMs:160000, paused:true}),false);
    assert.equal(L.rescue.observeTransport({scope:SCOPE, nowMs:160000, paused:false}),true);
    assert.equal(L.rescue.diagnostics().outcome,'long-pause-resume-budget-rearmed');
    assert.equal(L.rescue.diagnostics().rearmCount,1);
    assert.equal(L.rescue.diagnostics().lastRearmDwellMs,80000);
    assert.deepEqual(L.actions,['reload','rebuild'],'room transition itself never commands a player');
    L.wedge(160000,168500);
    assert.deepEqual(L.actions,['reload','rebuild'],'the original wedge dwell still protects a cold TV');
    L.wedge(168750,172000);
    assert.deepEqual(L.actions,['reload','rebuild','reload']);
    assert.equal(L.notes.filter(([k])=>k==='tv-resume-rearmed').length,1);
  });
  await check('R14S-03:brief-pause-and-multiple-segment-updates-never-refill-terminal-budget',()=>{
    const L=lab();exhaust(L);
    for(let t=56000;t<=135000;t+=1000) L.rescue.observeTransport({scope:'ROOM:AAAAAAAAAAA:4:'+Math.floor(t/1000),nowMs:t,paused:false});
    assert.equal(L.rescue.diagnostics().steps,2,'playout-segment churn has no rearm authority');
    L.rescue.observeTransport({scope:SCOPE,nowMs:140000,paused:true});
    assert.equal(L.rescue.observeTransport({scope:SCOPE,nowMs:144000,paused:false}),false);
    L.wedge(144000,170000);
    assert.deepEqual(L.actions,['reload','rebuild']);
    assert.equal(L.rescue.diagnostics().rearmCount,0);
  });
  await check('R14S-04:terminal-rearm-requires-quiet-time-after-the-last-recovery-step',()=>{
    const L=lab();exhaust(L);
    L.rescue.observeTransport({scope:SCOPE,nowMs:56000,paused:true});
    assert.equal(L.rescue.observeTransport({scope:SCOPE,nowMs:77000,paused:false}),false,
      'a lengthy pause does not circumvent the cooldown');
    L.wedge(77000,100000);assert.deepEqual(L.actions,['reload','rebuild']);
  });
  await check('R14S-05:no-second-rearm-in-ten-minutes-even-with-another-long-pause',()=>{
    const L=lab();exhaust(L);
    L.rescue.observeTransport({scope:SCOPE,nowMs:80000,paused:true});
    assert.equal(L.rescue.observeTransport({scope:SCOPE,nowMs:160000,paused:false}),true);
    L.wedge(160000,215000);
    assert.deepEqual(L.actions,['reload','rebuild','reload','rebuild']);
    assert.equal(L.rescue.diagnostics().steps,2);
    L.rescue.observeTransport({scope:SCOPE,nowMs:245000,paused:true});
    assert.equal(L.rescue.observeTransport({scope:SCOPE,nowMs:310000,paused:false}),false);
    L.wedge(310000,355000);
    assert.equal(L.actions.length,4,'no infinite pause/play reload loop');
    assert.equal(L.rescue.diagnostics().rearmCount,1);
  });
  await check('R14S-06:resume-with-stale-or-buffering-source-has-zero-automatic-reloads',()=>{
    const L=lab();exhaust(L);
    L.rescue.observeTransport({scope:SCOPE,nowMs:80000,paused:true});
    assert.equal(L.rescue.observeTransport({scope:SCOPE,nowMs:160000,paused:false}),true);
    for(let t=160000;t<=200000;t+=250)L.rescue.consider(L.input(t,{trusted:false,sourceBuffering:true}));
    assert.deepEqual(L.actions,['reload','rebuild']);
    assert.equal(L.rescue.diagnostics().outcome,'room-reference-not-live');
    L.wedge(200250,215000);
    assert.equal(L.actions.length,3,'fresh source proof is required before acting');
  });
  await check('R14S-07:an-already-advancing-TV-at-200ms-never-enters-decoder-recovery',()=>{
    const L=lab();
    for(let t=1000;t<=50000;t+=500) L.rescue.consider(L.input(t,{playing:true,buffering:false,exhausted:false,
      drift:-.2, position:40+(t-1000)/1000}));
    assert.deepEqual(L.actions,[]);
    assert.equal(L.rescue.diagnostics().steps,0);
  });
  await check('R14S-08:window-hidden-TV-cannot-rearm-terminal-budget',()=>{
    const L=lab(); exhaust(L);
    L.rescue.observeTransport({scope:SCOPE,nowMs:80000,paused:true});
    L.setHidden(true);
    assert.equal(L.rescue.observeTransport({scope:SCOPE,nowMs:160000,paused:false}),false);
    L.setHidden(false);L.wedge(160000,200000);
    assert.equal(L.actions.length,2);
  });
  await check('R14S-09:source-track-change-grants-the-existing-one-video-budget-once',()=>{
    const L=lab(); exhaust(L);
    const next='ROOM:BBBBBBBBBBB:5:27';
    L.rescue.observeTransport({scope:next,nowMs:65000,paused:false});
    assert.equal(L.rescue.diagnostics().steps,0);
    for(let t=65000;t<=120000;t+=250)L.rescue.consider(L.input(t,{scope:next}));
    assert.deepEqual(L.actions,['reload','rebuild','reload','rebuild']);
    assert.equal(L.rescue.diagnostics().steps,2);
  });
  await check('R14S-10:playback-wires-local-observer-for-both-roles-with-no-seek',()=>{
    const source=read('public/playback-sync.js');
    assert.match(source,/window\.WatchFusionDecoderRescue\?\.observeTransport\?\.\(\{scope, nowMs:performance\.now\(\), paused:roomPaused\}\)/);
    const decoder=read('public/client/tv-decoder-rescue.js');
    const observer=decoder.slice(decoder.indexOf('function observeTransport('),decoder.indexOf('function observeHealth('));
    assert.doesNotMatch(observer,/\.seek\(|\.pause\(|\.play\(|\.reload\(|\.rebuild\(/);
  });
  await check('R14S-11:group-spread-is-presented-before-absolute-room-clock-estimate',()=>{
    const center=read('public/client/sync-center.js');
    const group=center.indexOf("['Player-to-player timeline spread'");
    const room=center.indexOf("['Player vs room target (not audio)'");
    const source=center.indexOf("['Player vs linked source (estimate)'");
    assert.ok(group>0 && room>group && source>room,'relative timeline comes first');
    assert.match(center,/progression qualified/);
    assert.match(center,/provisional/);
    assert.match(center,/not speaker audio/);
    assert.match(center,/Speaker phase', peer.ready \? 'Not measured'/);
  });
  await check('R14S-12:the-late-trace-is-source-seeks-not-TV-automatic-corrections',()=>{
    // Actual 2026-11-21 trace, distilled; only timeline and control counters.
    const before={host:-14,tv:-171,tvCorrections:0,at:'03:44:09'};
    const after={host:1,tv:22,tvCorrections:0,at:'03:45:10'};
    const sourceSeeks=['03:44:54','03:45:04'];
    assert.ok(Math.abs(before.host-before.tv)>100);
    assert.ok(Math.abs(after.host-after.tv)<=50);
    assert.equal(after.tvCorrections-before.tvCorrections,0,
      'source commands, not a TV actuator, caused the observed late convergence');
    assert.equal(sourceSeeks.length,2);
  });
}
