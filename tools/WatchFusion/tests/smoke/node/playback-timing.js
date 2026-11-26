import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { handleRoomRoute } from '../../../src/server/room-routes.js';
import { getRoom } from '../../../src/server/room-store.js';
import { handleLiveRoute } from '../../../src/server/live-streams.js';
import { observeLinkedPlayout } from '../../../src/server/presentation-routes.js';

const CLIENT = fileURLToPath(new URL('../../../public/client/', import.meta.url));
const readClient = name => fs.readFileSync(path.join(CLIENT, name), 'utf8');

export async function runPlaybackTimingChecks(check) {
  const linkedPlayback = readClient('linked-playback-sync.js');
  const timingContext = {}; timingContext.window = timingContext; vm.createContext(timingContext);
  vm.runInContext(linkedPlayback, timingContext);
  const sync = timingContext.WatchFusionLinkedPlaybackSync;
  await check('WF06JE-03:publisher timestamp survives the actual relay and removes a 1s clock-domain mirror error', () => {
    const source = fs.readFileSync(path.join(CLIENT,'../../src/server/live-streams.js'),'utf8');
    const ctx = {Date:{now:()=>20000},text:v=>String(v??'')}; vm.createContext(ctx);
    vm.runInContext(source.slice(source.indexOf('function metadata('),source.indexOf('export function attachLiveStreams')),ctx);
    const raw={sampledAt:90000,publisherSentAt:90100,serverSampledAt:18900,uncertaintyMs:12,currentTime:10,rate:1};
    const meta=ctx.metadata(raw);assert.equal(meta.serverSampledAt,18900);assert.equal(meta.uncertaintyMs,12);
    const sample=sync.relaySample(meta,40000,20035,5);
    assert.equal(sample.sampledAt,38865);assert.equal(sample.relayAgeGapMs,1000);assert.equal(sample.sampleClock,'server-qualified');
    const isolated={}; isolated.window=isolated; vm.runInNewContext(linkedPlayback,isolated);
    const planner=isolated.WatchFusionLinkedPlaybackSync;
    const anchor={position:11.135,sampledAt:40000,rate:1,paused:false,volume:meta.volume};
    assert.equal(planner.mirrorPlan(sample,anchor,{now:40000}).publish,false);
    const legacy=sync.relaySample(meta,40000,20035);assert.equal(legacy.sampleClock,'relay-bounded');
    assert.equal(planner.mirrorPlan(legacy,anchor,{now:40000}).reason,'drift');
    for(const value of [{...raw,serverSampledAt:15000},{...raw,serverSampledAt:20100},{...raw,uncertaintyMs:76}])assert.equal(ctx.metadata(value).serverSampledAt,undefined);
  });
  await check('WF06JE-04:canonical timestamp cannot bypass clock and age validation',()=>{
    const m={sampledAt:90000,publisherSentAt:90100,relayReceivedAt:20000,currentTime:10,serverSampledAt:18900,uncertaintyMs:12};
    assert.equal(sync.relaySample(m,40000,20035,46).sampleClock,'relay-bounded');
    for(const [meta,serverAt] of [[{...m,serverSampledAt:20040},20035],[{...m,serverSampledAt:19990},20035],[m,21000],[{...m,publisherSentAt:89999},20035]])assert.equal(sync.relaySample(meta,40000,serverAt,5),null);
  });
  await check('TIMING-20:linked sample clock domains and expiry', () => {
    const meta = { sampledAt: 90000, publisherSentAt: 90100, relayReceivedAt: 20000, currentTime: 10 };
    const sample = sync.relaySample(meta, 40000, 20035);
    assert.equal(sample.sampledAt, 39865);
    assert.equal(sync.projectedPosition(sample, 40065), 10.2, 'project once through 200 ms of measured sample age');
    assert.equal(sync.relaySample(meta, 40000, 22000), null);
    assert.equal(sync.relaySample({ ...meta, sampledAt: 90101 }, 40000, 20035), null);
    assert.equal(sync.projectedPosition({ ...sample, ended: true }, 40065), 10);
  });

  await check('TIMING-21:linked source publishes sustained phase error once', () => {
    const anchor = { position: 10, sampledAt: 10000, paused: false, rate: 1 };
    const sample = (now, drift, extra = {}) => sync.mirrorPlan({
      currentTime: 10 + (now - 10000) / 1000 + drift, sampledAt: now, rate: 1, paused: false, ...extra
    }, anchor, { now });
    const noise = [.18, -.08, .19, -.06, .17, -.08, .16].map((drift, i) => sample(10500 + i * 350, drift));
    assert.ok(noise.every(plan => !plan.publish));
    const stable = [.242, .238, .24, .242, .238, .24, .241].map((drift, i) => sample(14000 + 350 * i, drift));
    const correction = stable.find(plan => plan.publish);
    assert.equal(correction.reason, 'sustained-drift');
    const nextAt = correction.anchor.sampledAt + 350;
    assert.equal(sync.mirrorPlan({ currentTime: correction.target + .35, sampledAt: nextAt, rate: 1 },
      correction.anchor, { now: nextAt }).publish, false);
    assert.equal(sample(17000, 0, { paused: true }).reason, 'state');
    assert.equal(sample(17500, 0, { rate: 1.25 }).reason, 'state');
    assert.equal(sample(18000, 8).reason, 'drift');
  });

  await check('TIMING-22:direct media converges without oscillating speed', () => {
    const controller = sync.createMediaConvergence();
    let drift = .24, reversals = 0, peak = 0, settledAt = null;
    for (let tick = 0; tick < 100; tick++) {
      const rate = controller.rate(1, drift + (tick % 2 ? .008 : -.008), tick * 250);
      peak = Math.max(peak, Math.abs(rate - 1));
      if (rate < 1) reversals++;
      drift -= (rate - 1) * .25;
      if (drift < .055 && settledAt == null) settledAt = tick * 250;
    }
    assert.ok(settledAt !== null && settledAt <= 15000, String(settledAt));
    assert.ok(drift < .055 && drift > 0 && peak <= .040001);
    assert.equal(reversals, 0);
    controller.reset();
    for (let tick = 0; tick <= 6; tick++) drift = controller.rate(1, .017, 20000 + tick * 250, .01);
    assert.ok(drift > 1 && drift <= 1.004, 'calibrated direct media can converge at a bounded rate for a small stable error');
    controller.reset();
    assert.equal(controller.rate(1.25, .3, 30000), 1.25, 'buffering or a new source resets correction');
    for (let tick = 1; tick < 12; tick++) {
      assert.equal(controller.rate(1.25, tick % 2 ? .13 : -.12, 30000 + 250 * tick), 1.25);
    }
  });

  await check('TIMING-23:clock and snapshots tolerate skew, queueing and transport reordering', () => {
    const core = readClient('core.js');
    let local = 8200, mono = 200;
    const clock = vm.createContext({ window: {}, Date: {now: () => local}, performance: { now: () => mono } });
    vm.runInContext(core.slice(core.indexOf('let serverClockOffsetMs'), core.indexOf('const isTryCloudflare'))
      + core.slice(core.indexOf('function medianNumber'), core.indexOf('function playbackAuthorityKey')), clock);
    const api = clock.window.watchPartyClock;
    api.update(8630, 8000, 8200, 8510);
    assert.equal(api.offsetMs(), 470);
    assert.equal(api.rttMs(), 80);
    local += 100; mono += 100;
    api.update(8750, 8280, 8300, 8750);
    assert.equal(api.offsetMs(), 460);
    local += 10000; mono += 250;
    assert.equal(api.now(), 9010, 'projection continues on a monotonic clock');
    assert.equal(api.serverAt(local), null, 'wall-clock step cannot stamp commands with the old offset');

    const room = vm.createContext({roomId:'TEST', session:{memberId:'fixture-member'},
      state:{revision:5, roomId:'TEST', serverTime:900}, performance:{now:()=>mono}});
    const connection = readClient('room-connection.js'), realtime = readClient('realtime.js');
    vm.runInContext(connection.slice(0, connection.indexOf('async function join'))
      + connection.slice(connection.indexOf('function applyIncomingRoomState'), connection.indexOf('function startSseEvents'))
      + realtime.slice(realtime.indexOf('let realtimeRevision'), realtime.indexOf('function websocketUrl')), room);
    const receipt = () => vm.runInContext('lastRoomStateReceipt', room);
    assert.equal(receipt(), null);
    assert.equal(room.acceptRealtimeState({revision:4, roomId:'TEST', serverTime:950}), false);
    assert.equal(room.acceptRealtimeState({revision:5, roomId:'TEST', serverTime:850}), false);
    assert.equal(room.acceptRealtimeState({revision:6, roomId:'OTHER', serverTime:950}), false);
    assert.equal(receipt(), null, 'rejected snapshots must not establish focus health');
    assert.equal(room.acceptRealtimeState({revision:6, roomId:'TEST', serverTime:950}), true);
    assert.equal(receipt().room, 'TEST'); assert.equal(receipt().member, 'fixture-member');
    assert.equal(receipt().at, mono);
    const accepted = receipt(); mono += 16000;
    assert.equal(room.acceptRealtimeState({revision:5, roomId:'TEST', serverTime:960}), false);
    assert.equal(room.acceptRealtimeState({revision:6, roomId:'TEST', serverTime:940}), false);
    assert.equal(room.acceptRealtimeState({revision:7, roomId:'OTHER', serverTime:960}), false);
    assert.equal(receipt(), accepted, 'rejected snapshots cannot refresh a stale connection');
    assert.equal(room.acceptRealtimeState({revision:7, roomId:'TEST', serverTime:960}), true);
    assert.equal(receipt().at, mono);
  });

  await check('TIMING-24:room routes preserve authority and zero-position transitions', async () => {
    async function post(pathname, body, memberId = '') {
      const url = new URL(pathname, 'http://fixture.invalid');
      const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
        method:'POST', headers:{'x-member-id':memberId}
      });
      const res = { writeHead(code) { this.code = code; }, end(value) { this.data = JSON.parse(value); } };
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[1] === 'live') await handleLiveRoute(req, res, parts);
      else await handleRoomRoute(req, res, url, parts);
      return res;
    }
    const route = (action, body, memberId) => post('/api/rooms/SYNCFIXTURE/' + action, body, memberId);
    assert.equal((await route('create', {})).code, 201);
    const host = (await route('join', {name:'Host',accountId:'fixture-host'})).data.session.memberId;
    const viewer = (await route('join', {name:'Viewer',accountId:'fixture-viewer'})).data.session.memberId;
    const command = (type, extra, memberId = host) => route('command', {type, ...extra}, memberId);
    assert.equal((await command('source', {input:'M7lc1UVf-VE'})).code, 200);
    assert.equal((await command('seek', {position:5}, viewer)).code, 403);
    assert.equal((await command('play', {position:10})).data.state.playback.paused, false);
    assert.equal((await command('pause', {position:0})).data.state.playback.position, 0);
    const scrub = (await command('seek', {position:25, paused:true})).data.state.playback;
    assert.equal(scrub.paused, true);
    assert.equal(scrub.position, 25);
    assert.equal((await command('rate', {rate:1.5})).data.state.playback.rate, 1.5);
    const stale = await command('mirror', {sourceKey:'previous-video', position:999});
    assert.equal(stale.code, 409, 'an in-flight sample from another video cannot change this room timeline');
    const delayed = {position:422, rate:1, sampledServerAt:Date.now()-1557, sourceKey:'M7lc1UVf-VE'};
    const expired = await command('mirror', delayed);
    assert.equal(expired.code, 408, 'a delayed running position needs a current source witness');
    const room = getRoom('SYNCFIXTURE');
    assert.equal(room.playback.position,25,'expiration leaves the previous transport intact');
    assert.ok(expired.data.sampleAgeMs >= 1557);
    const fresh = await command('mirror', {...delayed, position:424, sampledServerAt:Date.now()});
    assert.equal(fresh.code, 200, 'a fresh source update can recover the room after expiration');
    assert.ok(Math.abs(fresh.data.state.playback.position-424)<.1);
    const paused = await command('mirror', {...delayed, paused:true});
    assert.equal(paused.data.state.playback.position,422,'paused positions never advance in transit');
    const stream = (await post('/api/live', {})).data;
    const linkedSource = {id:stream.id, token:stream.publisherToken};
    const livePath = '/api/live/' + stream.id;
    assert.equal((await post(livePath + '/room', {roomId:room.id, mode:'linked-tab', publisherToken:linkedSource.token}, host)).code,200);
    try {
      const resume = await command('mirror', {...delayed, linkedSource, sampledServerAt:Date.now()-700});
      assert.equal(resume.code,200,'a delayed resume can establish the new running transport');
      assert.equal(room.playback.paused,false);
      const beforeLate = {...room.playback};
      const late = await command('mirror', {...delayed, linkedSource, sampledServerAt:Date.now()-911});
      assert.equal(late.code,408,'the trace’s ~911 ms running mirror needs advancing linked samples');
      assert.deepEqual(room.playback,beforeLate,'rejection preserves the previous transport');
      const sent = Date.now() - 1557;
      Object.assign(room.playback, {position:410, rate:1, paused:false, updatedAt:sent-5000});
      const mirror = {...delayed, linkedSource, sampledServerAt:sent};
      const observe = (delta, extra={}) => observeLinkedPlayout(room, {
        positionMs:422000+delta+15, sampledAt:sent+delta, outputSession:stream.id,
        ready:true, playing:true, uncertaintyMs:25, ...extra
      }, sent+delta+5);
      observe(880);
      observe(1300);
      const confirmed = await command('mirror', mirror);
      assert.equal(confirmed.code,200);
      assert.equal(Math.round(room.playback.position*1000),422015+room.playback.updatedAt-sent,
        'a corroborated delayed seek anchors to the advancing source at receipt');
      const updatedAt = room.playback.updatedAt;
      const audio = await command('mirror',{...mirror,volumeOnly:true,volume:55});
      assert.equal(audio.code,200);
      assert.equal(room.playback.volume,55);
      assert.equal(room.playback.updatedAt,updatedAt,'late volume-only changes preserve transport');
      assert.equal((await command('mirror',{...mirror, position:0})).code,408);
      assert.equal((await command('mirror',{...mirror, sampledServerAt:Date.now()-5000})).code,408);
      observe(1480,{buffering:true});
      assert.equal((await command('mirror',mirror)).code,408);
    } finally {
      await post(livePath + '/stop', {publisherToken:linkedSource.token});
    }
    const ping = (await route('ping', {}, viewer)).data;
    assert.ok(ping.serverReceivedAt > 0 && ping.serverTime >= ping.serverReceivedAt);
  });

  await check('TIMING-25:arbiter-owns-viewer-correction-and-device-timing-never-moves-the-room', () => {
    let elapsed = 0, position = 90, playerState = 1;
    const seeks = [], pauses = [];
    const status = { textContent: '' };
    const elements = new Map([['syncStatus', status]]);
    for (const id of ['devicePlaybackTiming', 'deviceTimingSummary', 'deviceTimingValue',
      'deviceTimingEarlier', 'deviceTimingLater', 'deviceTimingApply', 'deviceTimingReset']) {
      elements.set(id, { addEventListener(_type, fn) { this.click = fn; } });
    }
    const preferences = new Map();
    const playback = { position: 100, paused: false, rate: 1, updatedAt: 10000, projectedAt: 10000 };
    const context = {
      roomId: 'linked-room', state: { source: { videoId: 'fixture' }, playoutSegment:1, playback },
      ytPlayerReady: true, playerInitializing: false, primingPlayer: false,
      ytPlayer: {
        getCurrentTime: () => position, getPlayerState: () => playerState,
        getPlaybackRate: () => 1, getDuration: () => 250, getVideoLoadedFraction: () => 1,
        seekTo: value => { seeks.push(value); }, pauseVideo: () => { pauses.push(elapsed); playerState = 2; }, playVideo() { playerState = 1; }
      },
      window: { YT: { PlayerState: { PLAYING: 1, PAUSED: 2, BUFFERING: 3 } } },
      followsRoomPlayback: () => true, isHost: () => false, isTryCloudflare: false,
      estimatedServerNow: () => 10000 + elapsed, performance: { now: () => elapsed },
      storage: preferences,
      applyRoomAudioState() {}, requestViewerPlayback() {}, render() {},
      syncPlayer: options => context.window.applyAdaptiveViewerSync(options.force),
      $: id => elements.get(id), setStatus: value => { status.textContent = value; },
      setInterval() {}, setTimeout() { return 0; }, clearTimeout() {}, document: { addEventListener() {} }
    };
    context.globalThis = context.window;
    const bundle = fs.readFileSync(path.join(CLIENT, '..', '..', 'src', 'server', 'static-files.js'), 'utf8');
    assert.match(bundle, /'client\/viewer-sync-arbiter\.js',\s*'playback-sync\.js'/, 'the arbiter loads before the viewer path');
    assert.doesNotMatch(bundle, /gentle-catchup|sync-seek-health/, 'retired controllers cannot actuate the player');
    for (const script of ['client/linked-playback-sync.js', 'client/youtube-startup-gate.js', 'client/viewer-release-evidence.js', 'client/viewer-timing-math.js', 'client/viewer-sync-arbiter.js', 'playback-sync.js']) {
      vm.runInNewContext(fs.readFileSync(path.join(CLIENT, '..', script), 'utf8'), context);
    }
    const tickViewer = context.window.applyAdaptiveViewerSync;
    for (; elapsed < 9000; elapsed += 250) {
      if (elapsed === 5000) Object.assign(playback, { position: 105, updatedAt: 15000, projectedAt: 15000 });
      tickViewer();
    }
    // A frozen clock reporting PLAYING is never drift evidence: no seek is computed from it.
    // Past a slow cold start (6.5 s) the arbiter's bounded stall ladder starts with a
    // seekless pause/play kick (Nov 15 real-device traces warmed forever without it).
    assert.equal(seeks.length, 0, 'a frozen clock reporting PLAYING never triggers a seek correction');
    assert.equal(pauses.length, 1, 'the only action on a frozen PLAYING player is one stall kick');
    assert.equal(context.window.watchFusionSyncDiagnostics().arbiter.stallSteps, 1);
    assert.equal(context.window.watchFusionSyncDiagnostics().startup.reason, 'viewer-stalled-while-playing');

    tickViewer(true);
    assert.equal(seeks.length, 1, 'a forced transport alignment of a large lag is one rejoin');
    assert.ok(seeks[0] > 10000 / 1000 + 100 - 1 && pauses.length === 2, 'the rejoin pauses and seeks ahead of the room');
    assert.equal(context.window.watchFusionSyncDiagnostics().arbiter.owned, true, 'the arbiter owns the player until release');
    tickViewer();
    assert.equal(seeks.length, 1, 'no other controller re-seeks a held player');

    context.state.playoutSegment++;
    Object.assign(playback, { position: 60, paused: true, updatedAt: 26001, projectedAt: 26001 });
    tickViewer();
    assert.equal(context.window.watchFusionSyncDiagnostics().arbiter.owned, false, 'a room pause cancels the held rejoin');

    playerState = 1;
    position = 60;
    elapsed = 16000;
    Object.assign(playback, { position: 60, paused: false, rate: 2, updatedAt: 26000, projectedAt: 26000 });
    context.state.playoutSegment++;
    context.render();
    const before = context.window.watchFusionYouTubeTarget(26000, 250);
    elements.get('deviceTimingEarlier').click();
    elements.get('deviceTimingEarlier').click();
    const staged = seeks.length;
    assert.equal(context.window.watchFusionYouTubeTarget(26000, 250), before, 'staging device timing changes nothing');
    elements.get('deviceTimingApply').click();
    assert.ok(Math.abs(context.window.watchFusionYouTubeTarget(26000, 250) - before - .1) < 1e-8, '50 ms earlier is 100 ms of media at 2x');
    assert.equal(seeks.length, staged, 'a small device-timing change is corrected by observation, not a blind seek');
    assert.equal(playback.position, 60, 'device timing never changes the shared timeline');
    assert.equal(preferences.get('watchfusion.youtubePlaybackDelayMs'), '-50');
    elements.get('deviceTimingReset').click();
    assert.equal(context.window.watchFusionYouTubeTarget(26000, 250), before);
    assert.equal(preferences.get('watchfusion.youtubePlaybackDelayMs'), '0');
    assert.equal(context.window.watchFusionSyncDiagnostics().replayLoads, 0);
  });

}
