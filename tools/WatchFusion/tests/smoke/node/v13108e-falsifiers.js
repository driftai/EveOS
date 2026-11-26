// v13.10.8e falsifiers: timing-sensor integrity. Red on v13.10.8d (0d69e111): the presentation route drops
// hostRecovery, Trace v3 cannot carry the source-led controller or its events, nothing separates a shared
// room-clock offset from player-vs-player disagreement, and a volume-only source change rewrites the room anchor.
// Evidence type: Node VM + in-process route only. Not Playwright, not Windows, not audible playback.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.env.WF_FALSIFIER_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = rel => fs.existsSync(path.join(ROOT, rel));

async function routes() {
  const {handleRoomRoute} = await import(pathToFileURL(path.join(ROOT, 'src/server/room-routes.js')).href);
  return async function request(room, action, body, memberId) {
    const url = new URL('http://localhost/api/rooms/' + room + (action ? '/' + action : ''));
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body ?? {}))]), {
      method: body ? 'POST' : 'GET', headers: memberId ? {'x-member-id': memberId} : {}});
    const res = {writeHead(code, headers) { this.status = code; this.headers = headers; }, end(text) { this.body = JSON.parse(text); }};
    await handleRoomRoute(req, res, url, url.pathname.split('/').filter(Boolean));
    return res;
  };
}

async function room(request, tag) {
  const id = (await request('E-' + tag, 'create', {})).body.roomId;
  const host = (await request(id, 'join', {name: 'Laptop-Side', accountId: 'host-' + tag + '-acct'})).body.session;
  const tv = (await request(id, 'join', {name: 'TV', accountId: 'tv-' + tag + '-acct'})).body.session;
  const cmd = (body, who = host) => request(id, 'command', body, who.memberId);
  const {state} = (await cmd({type: 'source', input: 'rm7UdTLKt5Y'})).body;
  const report = (who, extra = {}) => ({mode: 'youtube', outputSession: 'device-for-' + who.publicId, sampledAt: Date.now(), rate: 1,
    positionMs: 5000, roomPositionMs: 5000, rttMs: 8, ready: true, playing: true, follows: who !== host, ...extra});
  const post = (who, extra = {}, epoch = state.presentationEpoch) =>
    request(id, 'presentation', {epoch, diagnostics: true, report: report(who, extra)}, who.memberId);
  const peek = (who, epoch = state.presentationEpoch) => request(id, 'presentation', {epoch, diagnostics: true}, who.memberId);
  return {id, host, tv, cmd, post, peek, state, request};
}

function roomLog(hostDiag = {}) {
  const element = () => ({value: '', textContent: '', open: false, addEventListener() {}, focus() {}, select() {}});
  const nodes = {syncRoomLog: element(), syncRoomLogText: element(), syncRoomLogCopy: element(), syncRoomLogClear: element(), syncRoomLogCount: element()};
  let now = 100000;
  const ctx = {document: {getElementById: id => nodes[id] || null}, navigator: {}, performance: {now: () => now},
    roomId: 'room-1', session: {memberId: 'h'}, isHost: () => true,
    state: {presentationEpoch: 1, playoutSegment: 6, hostId: 'h', playback: {rate: 1, position:60, projectedAt:now-10},
      members: [{id: 'h', name: 'Laptop-Side'}, {id: 'tv', name: 'TV'}, {id: 'ph', name: 'Phone'}]},
    estimatedServerNow: () => now, setTimeout, console, Date, JSON, Math, Object, Number, Array, String, RegExp};
  ctx.window = ctx;
  ctx.WatchFusionHostPeerRecovery = {diagnostics: () => ({outcome: 'source-not-trusted', stage: 'observe', attempts: 0, peerCount: 0})};
  ctx.WatchFusionHostSourceConverge = {diagnostics: () => ({outcome: 'solo-source-verifying', stage: 'verifying', attempts: 1, witnesses: 8, errorMs: -341, ...hostDiag})};
  vm.runInNewContext(read('public/client/precision-policy.js'), ctx);
  vm.runInNewContext(read('public/client/sync-room-log.js'), ctx, {filename: 'sync-room-log.js'});
  return {log: ctx.window.watchFusionRoomSyncLog, advance: ms => { now += ms; }, at: () => now};
}
const peer = (member, at, targetError, extra = {}) => ({member, playoutSegment:6, sampledAt: at - 10, positionMs: 60000 + targetError, roomPositionMs: 60000,
  targetPositionMs: 60000, ready: true, playing: true, buffering: false, rttMs: 10, rate: 1, audible: true,
  sensor: {domain: 'player-timeline', heldMs: 0, clockBoundMs: 5, clockState: 'bounded', audibleOutput: 'player'}, ...extra});

export async function runV13108eChecks(check) {
  await check('V13108E-01:presentation-route-keeps-bounded-host-recovery-and-sensor-and-drops-it-for-viewers', async () => {
    const request = await routes(), r = await room(request, 'e01');
    const hostRecovery = {outcome: 'source-not-trusted', stage: 'observe', reference: 'linked-tab', attempts: 0, peerCount: 0, hostErrorMs: -130,
      url: 'https://youtube.com/watch?v=x', linkedSource: {outcome: 'solo-source-verifying', stage: 'verifying', attempts: 1, witnesses: 8,
      errorMs: -341, verifyMs: 900, acceptedAt: 1234.5, token: 'secret-token', note: 'Free Text!'}};
    const sensor = {domain: 'player-timeline', heldMs: 40, cadenceMs: 250, clockBoundMs: 5, clockState: 'bounded', audibleOutput: 'player', raw: [1, 2]};
    assert.equal((await r.post(r.host, {hostRecovery, sensor})).status, 200);
    assert.equal((await r.post(r.tv, {hostRecovery, sensor: {domain: 'speaker', audibleOutput: 'microphone', heldMs: -5}})).status, 200);
    const peers = (await r.peek(r.tv)).body.peers;
    const h = peers.find(p => p.member === r.host.publicId), t = peers.find(p => p.member === r.tv.publicId);
    assert.equal(h.hostRecovery?.linkedSource?.outcome, 'solo-source-verifying', 'source-led host recovery must survive the route');
    assert.equal(h.hostRecovery.linkedSource.errorMs, -341);
    assert.equal(h.hostRecovery.reference, 'linked-tab');
    assert.equal(h.sensor?.audibleOutput, 'player');
    assert.equal(h.sensor.heldMs, 40);
    assert.doesNotMatch(JSON.stringify(peers), /youtube\.com|secret-token|Free Text|acceptedAt|"raw"/);
    assert.equal(t.hostRecovery, null, 'a viewer never speaks for host recovery');
    assert.deepEqual([t.sensor.domain, t.sensor.audibleOutput, t.sensor.heldMs], [null, 'unknown', null], 'unknown domains never become speaker claims');
    // Handoff: the former host loses its recovery voice at once.
    const moved = await r.cmd({type: 'transfer-host', targetMemberId: r.tv.publicId});
    assert.equal(moved.status, 200);
    const epoch = moved.body.state.presentationEpoch;
    assert.equal((await r.post(r.host, {hostRecovery}, epoch)).status, 200);
    const old = (await r.peek(r.tv, epoch)).body.peers.find(p => p.member === r.host.publicId);
    assert.equal(old.hostRecovery, null, 'after a handoff the former host no longer reports host recovery');
  });

  await check('V13108E-02:trace-v3-carries-source-led-host-recovery-from-the-wire-and-the-local-fallback', () => {
    const {log, at} = roomLog();
    const wire = peer('h', at(), -341, {hostRecovery: {outcome: 'source-not-trusted', stage: 'observe', attempts: 0,
      linkedSource: {outcome: 'solo-source-landing-incomplete', stage: 'retry-wait', attempts: 1, witnesses: 8, errorMs: -937, verifyMs: 8000}}});
    log.observe([wire], {reference: 'linked-tab', source: 'live'});
    let row = JSON.parse(log.export()).snapshots.at(-1).peers[0];
    assert.equal(row.hostRecovery?.linkedSource?.outcome, 'solo-source-landing-incomplete');
    assert.equal(row.hostRecovery.linkedSource.errorMs, -937);
    const fallback = roomLog();
    fallback.log.observe([peer('h', fallback.at(), -341)], {reference: 'linked-tab', source: 'live'});
    row = JSON.parse(fallback.log.export()).snapshots.at(-1).peers[0];
    assert.equal(row.hostRecovery?.outcome, 'source-not-trusted', 'legacy path still reported');
    assert.equal(row.hostRecovery?.linkedSource?.stage, 'verifying', 'the new controller is read when the server omits it');
  });

  await check('V13108E-03:host-source-and-mirror-drift-events-reach-the-trace', () => {
    const {log} = roomLog();
    log.note('host-source-rejoin-triggered', {errorMs: -341, dwellMs: 3300, attempts: 1});
    log.note('host-source-landing-incomplete', {errorMs: -525, attempts: 1});
    log.note('mirror-drift-observing', {driftMs: 220});
    const events = JSON.parse(log.export()).events;
    assert.deepEqual(events.map(e => e.kind), ['host-source-rejoin-triggered', 'host-source-landing-incomplete', 'mirror-drift-observing']);
    assert.equal(events[0].errorMs, -341);
    assert.equal(events[2].driftMs, 220);
  });

  await check('V13108E-04:group-phase-separates-common-mode-offset-disagreement-stale-and-single-player', () => {
    const snap = rows => { const {log, at} = roomLog(); log.observe(rows(at()), {reference: 'peer-cohort', source: 'live'}); return JSON.parse(log.export()).snapshots.at(-1); };
    let s = snap(at => [peer('h', at, -130), peer('tv', at, -128), peer('ph', at, -133)]);
    assert.equal(s.groupPhase, 'common-mode-offset', 'same-phase players at -130 ms agree with each other');
    assert.equal(s.groupSpreadMs, 5); assert.equal(s.commonModeMs, -130); assert.equal(s.speakerPhase, 'not-measured');
    s = snap(at => [peer('h', at, -10), peer('tv', at, 190)]);
    assert.equal(s.groupPhase, 'players-disagree'); assert.equal(s.groupSpreadMs, 200);
    s = snap(at => [peer('h', at, 190), peer('tv', at, -10)]);
    assert.equal(s.groupPhase, 'players-disagree', 'reversed drift is still disagreement');
    s = snap(at => [peer('h', at, -130), peer('tv', at - 5000, 400)]);
    assert.equal(s.groupPhase, 'unmeasured-single-player', 'a stale peer is never a phase witness');
    s = snap(at => [peer('h', at, -130), peer('tv', at, -1680, {buffering: true, playing: false})]);
    assert.equal(s.groupPhase, 'unmeasured-single-player', 'a buffering transient is excluded');
    s = snap(at => [peer('h', at, -130)]);
    assert.equal(s.groupPhase, 'unmeasured-single-player'); assert.equal(s.groupSpreadMs, null);
    s = snap(at => [peer('h', at, -8), peer('tv', at, 12)]);
    assert.equal(s.groupPhase, 'aligned');
    s = snap(at => [peer('h', at, -130), peer('tv', at, -130, {audible: false, sensor: {audibleOutput: 'none'}})]);
    assert.equal(s.groupPhase, 'unmeasured-single-player', 'a silent player cannot vouch for audible alignment');
  });

  await check('WF06JB-01:explicit room volume survives stale source mirrors and consecutive tracks', async () => {
    const request=await routes(),r=await room(request,'jb01');
    const {handleLiveRoute}=await import(pathToFileURL(path.join(ROOT,'src/server/live-streams.js')).href);
    const live=async(parts,body)=>{
      const req=Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]),{method:'POST',headers:{'x-member-id':r.host.memberId}});
      const res={writeHead(code){this.status=code;},end(text){this.body=JSON.parse(text);}};
      await handleLiveRoute(req,res,parts);assert.ok(res.status<300,JSON.stringify(res.body));return res.body;
    };
    const link=await live(['api','live'],{}),proof={id:link.id,token:link.publisherToken};let didStop=false;
    try {
      await live(['api','live',link.id,'room'],{publisherToken:link.publisherToken,roomId:r.id,mode:'linked-tab'});
      const mirror=extra=>r.cmd({type:'mirror',linkedSource:proof,position:40,paused:false,rate:1,...extra});
      const intent=(volume,at,muted=volume===0)=>r.cmd({type:'volume',linkedSource:proof,volume,muted,audioIntentAt:at});
      const first=(await mirror({volume:16})).body.state;
      assert.equal(first.playback.volume,16);
      const pinned=(await intent(73,100)).body.state;
      assert.equal(pinned.playback.volume,73);assert.equal(pinned.roomAudioPinned,true);
      assert.equal(pinned.playback.updatedAt,first.playback.updatedAt);assert.equal(pinned.playoutSegment,first.playoutSegment);
      for(const [video,reset] of [['AAAAAAAAAAA',20],['BBBBBBBBBBB',19],['CCCCCCCCCCC',17]]){
        assert.equal((await r.cmd({type:'source',input:video,linkedSource:proof})).body.state.playback.volume,73);
        const next=(await mirror({sourceKey:video,volume:reset,muted:true})).body.state;
        assert.equal(next.playback.volume,73);assert.equal(next.playback.muted,false);assert.equal(next.roomAudioPinned,true);
      }
      assert.equal((await intent(51,102)).body.state.playback.volume,51);
      assert.equal((await intent(73,101)).body.state.playback.volume,51,'late host request must not win');
      assert.equal((await r.cmd({type:'volume',volume:17,muted:false})).body.state.playback.volume,51,'passive old client must not win');
      assert.equal((await intent(0,103)).body.state.playback.muted,true);
      const muted=(await mirror({volume:99,muted:false})).body.state;assert.equal(muted.playback.volume,0);assert.equal(muted.playback.muted,true);
      const restored=(await intent(42,104)).body.state;assert.equal(restored.playback.volume,42);assert.equal(restored.playback.muted,false);
      assert.equal((await r.cmd({type:'volume',volume:99,audioIntentAt:105,linkedSource:proof},r.tv)).status,403);
      const stopped=await live(['api','live',link.id,'stop'],{publisherToken:link.publisherToken});didStop=true;assert.equal(stopped.state.roomAudioPinned,false);
      assert.equal((await r.cmd({type:'mirror',position:40,paused:false,rate:1,volume:22})).body.state.playback.volume,22);
    } finally {if(!didStop)await live(['api','live',link.id,'stop'],{publisherToken:link.publisherToken});}
  });
  await check('WF06JB-02:linked room slider and source restore use the authoritative audio, not decoder defaults', async () => {
    let now=1000000,peer,commands=[],sent=[],nodes=new Map();
    const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',hidden:false,addEventListener(){},setAttribute(){},querySelectorAll(){return[];}});return nodes.get(id);};
    const ctx={Date:{now:()=>now},performance:{now:()=>now},URL,Math,Number,Map,Set,Promise,console,
      location:{origin:'http://localhost'},document:{hidden:false,activeElement:null,querySelector:()=>null,addEventListener(){}},$:node,
      roomId:'ROOM',session:{memberId:'host'},state:{hostId:'host',linkedSourceActive:true,playback:{volume:16,muted:false},source:{videoId:'AAAAAAAAAAA'}},
      playerAudioPrefs:{volume:16},isHost:()=>true,apiUrl:x=>x,setStatus(){},render(){},setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,addEventListener(){},
      applyIncomingRoomState(s){ctx.state=s;return true;},followsRoomPlayback:()=>true,
      fetch:async url=>({ok:true,json:async()=>url==='/api/live'?{id:'link1',publisherToken:'secret'}:{state:ctx.state}}),
      WatchFusionLivePeer:class{constructor(o){peer=o;this.socket={readyState:1};this.viewerId='v';}control(a,v){sent.push([a,v]);return true;}stop(){}},
      command:async(type,body,receipt)=>{commands.push([type,{...body}]);if(type==='volume'){ctx.state.roomAudioPinned=true;ctx.state.playback.volume=body.volume;ctx.state.playback.muted=body.muted;}else if(receipt)receipt.status=200;return true;}};
    ctx.window=ctx.globalThis=ctx;ctx.watchFusionMediaResolver={resolveAndLoad:async url=>{ctx.state.source={videoId:url.slice(-11)};return true;}};
    vm.createContext(ctx);vm.runInContext(read('public/client/linked-playback-sync.js'),ctx);vm.runInContext(read('public/client/linked-tab.js'),ctx);
    await ctx.watchFusionLinkedTab.start();
    const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
    const sample=async(video,volume)=>{now+=300;peer.onMetadata({pageUrl:'https://youtube.com/watch?v='+video,volume,muted:false,currentTime:40,duration:200,rate:1,paused:false,sampledAt:now});await flush();};
    await sample('AAAAAAAAAAA',.16);ctx.watchFusionLinkedTab.queueVolume(.73,true);await flush();await sample('AAAAAAAAAAA',.73);
    assert.equal(ctx.state.playback.volume,73);assert.equal(Number(node('liveVolume').value),.73);
    const prior=sent.filter(([a])=>a==='volume').length;await sample('BBBBBBBBBBB',.20);assert.equal(Number(node('liveVolume').value),.73);assert.equal(sent.filter(([a])=>a==='volume').length,prior+1);assert.deepEqual(sent.filter(([a])=>a==='volume').at(-1),['volume',.73]);
    assert.equal(commands.filter(([a])=>a==='mirror').at(-1)[1].volume,73);
    assert.equal(ctx.watchFusionLinkedTab.metadata().volume,.20,'raw source disagreement remains visible');
    await sample('BBBBBBBBBBB',.73);ctx.watchFusionLinkedTab.queueVolume(.51,true);await flush();await sample('BBBBBBBBBBB',.51);
    await sample('CCCCCCCCCCC',.19);assert.equal(Number(node('liveVolume').value),.51);assert.equal(commands.filter(([a])=>a==='mirror').at(-1)[1].volume,51);
    const before=sent.length;ctx.watchFusionLinkedTab.control('volume',.19);assert.equal(sent.length,before,'passive decoder echo cannot steal room intent');
    ctx.watchFusionLinkedTab.queueVolume(0,true);await flush();await sample('DDDDDDDDDDD',.17);assert.equal(Number(node('liveVolume').value),0);assert.equal(ctx.state.playback.muted,true);
  });
  await check('WF06JB-03:pinned host output restores a decoder reset without sending transport or source commands',()=>{
    let now=1000,writes=0,echoes=0;const player={volume:73,muted:false,getVolume(){return this.volume;},isMuted(){return this.muted;},setVolume(v){writes++;this.volume=v;},mute(){this.muted=true;},unMute(){this.muted=false;}};
    const ctx={URL,URLSearchParams,location:{hostname:'localhost',search:''},performance:{now:()=>now},document:{getElementById:()=>null},setTimeout:()=>1,clearTimeout(){},player,console,watchFusionLinkedTab:{active:()=>true,control(){echoes++;},pendingControl:()=>false}};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(read('public/client/core.js'),ctx);
    vm.runInContext("roomId='ROOM';session={publicId:'HOST'};ytPlayer=player;ytPlayerReady=true;state={hostId:'HOST',presentationEpoch:1,playoutSegment:7,linkedSourceActive:true,roomAudioPinned:true,source:{videoId:'AAAAAAAAAAA'},playback:{volume:73,muted:false,rate:1,paused:false}};applyRoomAudioState();",ctx);
    player.volume=20;now+=1000;vm.runInContext('observeYouTubeAudio();',ctx);assert.equal(player.volume,73);assert.equal(echoes,0);
    vm.runInContext('state.playback.volume=51;applyRoomAudioState();',ctx);assert.equal(player.volume,51);
    player.volume=19;now+=1000;vm.runInContext('observeYouTubeAudio();',ctx);assert.equal(player.volume,51);
    vm.runInContext('state.playback.volume=0;state.playback.muted=true;applyRoomAudioState();',ctx);assert.equal(player.volume,0);assert.equal(player.muted,true);
    player.volume=17;player.muted=false;now+=1000;vm.runInContext('observeYouTubeAudio();',ctx);assert.equal(player.volume,0);assert.equal(player.muted,true);assert.equal(echoes,0);assert.equal(writes,5);
    assert.equal(vm.runInContext('state.playoutSegment',ctx),7);assert.equal(vm.runInContext('state.playback.rate',ctx),1);
  });
  await check('V13108E-05:volume-only-source-change-keeps-the-mirror-anchor-timeline', () => {
    const ctx = {window: {}, Math, Number, Date, performance: {now: () => 0}, console};
    ctx.globalThis = ctx; vm.runInNewContext(read('public/client/linked-playback-sync.js'), ctx);
    const sync = ctx.window.WatchFusionLinkedPlaybackSync || ctx.WatchFusionLinkedPlaybackSync;
    const t0 = 1000000, meta = (at, current, extra = {}) => ({sampledAt: at, currentTime: current, paused: false, rate: 1, volume: .31, ...extra});
    let plan = sync.mirrorPlan(meta(t0, 80), null, {now: t0});
    const anchor = plan.anchor;
    // Drift's 05:04:42 burst: 31 -> 40 -> 33 with a source sample that reads 120 ms behind its own clock.
    plan = sync.mirrorPlan(meta(t0 + 80, 79.96, {volume: .40}), anchor, {now: t0 + 80});
    assert.equal(plan.reason, 'volume'); assert.equal(plan.volumeOnly, true);
    assert.ok(Math.abs(plan.anchor.position - 80.08) < 1e-6, 'the anchor timeline is projected, not replaced by the sample');
    assert.equal(plan.anchor.volume, .40);
    plan = sync.mirrorPlan(meta(t0 + 400, 80.4, {volume: .40, paused: true}), plan.anchor, {now: t0 + 400});
    assert.equal(plan.reason, 'state', 'pause stays a transport change'); assert.notEqual(plan.volumeOnly, true);
    plan = sync.mirrorPlan(meta(t0 + 400, 83.5, {volume: .33}), anchor, {now: t0 + 400});
    assert.notEqual(plan.volumeOnly, true, 'a real source seek with a volume change still moves the timeline');
  });

  await check('V13108E-06:server-volume-only-mirror-changes-audio-not-the-anchor-or-segment', async () => {
    const request = await routes(), r = await room(request, 'e06');
    assert.equal((await r.cmd({type: 'play', position: 80})).status, 200);
    const before = (await r.cmd({type: 'mirror', position: 80.5, paused: false, rate: 1, volume: 31})).body.state;
    const after = (await r.cmd({type: 'mirror', position: 81.7, paused: false, rate: 1, volume: 40, volumeOnly: true})).body.state;
    assert.equal(after.playback.volume, 40);
    assert.equal(after.playback.updatedAt, before.playback.updatedAt, 'volume-only must not republish the anchor');
    assert.ok(Math.abs(after.playback.position - before.playback.position) < .05, 'the stale 81.7 s sample must not move the room');
    assert.equal(after.playoutSegment, before.playoutSegment);
    const paused = (await r.cmd({type: 'mirror', position: 82, paused: true, rate: 1, volume: 40, volumeOnly: true})).body.state;
    assert.equal(paused.playback.paused, true, 'a volume-only flag cannot hide a transport change');
  });

  await check('V13108E-07:sensor-provenance-reports-held-reads-cadence-and-which-output-is-audible', () => {
    assert.ok(exists('public/client/sensor-provenance.js'), 'sensor-provenance.js missing');
    const ctx = {Math, Number, performance: {now: () => 0}};
    ctx.globalThis = ctx; vm.runInNewContext(read('public/client/sensor-provenance.js'), ctx);
    const s = ctx.WatchFusionSensorProvenance, player = {getVolume: () => 60, isMuted: () => false};
    for (let t = 0; t <= 2000; t += 50) s.track(player, t, Math.floor(t / 250) * .25, true);
    const d = s.describe({media: player, now: 2120, clock: {boundMs: 5, spreadMs: 2, ageMs: 1000, samples: 5, precise: true}, source: {tabMuted: true, paused: false, volume: .4}});
    assert.equal(d.domain, 'player-timeline'); assert.equal(d.cadenceMs, 250); assert.equal(d.heldMs, 120);
    assert.equal(d.clockBoundMs, 7); assert.equal(d.clockState, 'bounded'); assert.equal(d.audibleOutput, 'player');
    assert.equal(s.audibleOutput({playerAudible: true, source: {tabMuted: false, paused: false, volume: .4}}), 'both');
    assert.equal(s.audibleOutput({playerAudible: false, source: {tabMuted: false, paused: false, volume: .4}}), 'source-tab');
    assert.equal(s.audibleOutput({playerAudible: true, source: {paused: false}}), 'unknown', 'unknown tab mute is not a claim');
    s.track(player, 2200, 2.25, false);
    assert.equal(s.describe({media: player, now: 2300}).heldMs, null, 'no held claim while paused');
  });

  await check('V13108E-08:roster-explains-a-missing-device-instead-of-dropping-it-silently', async () => {
    const request = await routes(), r = await room(request, 'e08');
    assert.equal((await r.post(r.host)).status, 200);
    assert.equal((await r.post(r.tv, {sampledAt: Date.now() + 900})).status, 400);
    assert.equal((await r.post(r.tv, {}, r.state.presentationEpoch + 7)).status, 409);
    const body = (await r.post(r.host)).body;
    assert.ok(body.roster, 'roster missing');
    assert.equal(body.roster.members, 2); assert.equal(body.roster.reporting, 1);
    assert.equal(body.roster.rejections['clock-skew'], 1); assert.equal(body.roster.rejections['epoch-changed'], 1);
    assert.doesNotMatch(JSON.stringify(body.roster), /acct|device-for|TV/);
    const big = {hostRecovery: {outcome: 'source-not-trusted', stage: 'observe', reference: 'linked-tab', attempts: 0, witnesses: 0, peerCount: 0,
      hostErrorMs: -130.12, dwellMs: 0, linkedSource: {outcome: 'solo-source-landing-incomplete', stage: 'retry-wait', attempts: 1, witnesses: 8, errorMs: -937, segment: 6, verifyMs: 12345}},
      sensor: {domain: 'player-timeline', heldMs: 12, cadenceMs: 250, clockBoundMs: 5, clockState: 'bounded', audibleOutput: 'player'}, timingReference: 'Shared cohort ±125 ms',
      recentCorrection: 'fine-drift-awaiting-capability', seekHealth: {reason: 'seek-awaiting-proof', attempts: 3, failures: 0, overshoots: 0, cooldownRemainingMs: 0, recoveryAttempts: 1, lastRecoveryBiasMs: 1955}};
    assert.equal((await r.post(r.host, big)).status, 200, 'a full host diagnostic still fits the 2048-byte route cap');
  });
}
