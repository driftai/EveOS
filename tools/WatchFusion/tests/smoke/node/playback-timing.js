import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { handleRoomRoute } from '../../../src/server/room-routes.js';

const CLIENT = fileURLToPath(new URL('../../../public/client/', import.meta.url));
const readClient = name => fs.readFileSync(path.join(CLIENT, name), 'utf8');

export async function runPlaybackTimingChecks(check) {
  const linkedPlayback = readClient('linked-playback-sync.js');
  const timingContext = vm.createContext({});
  vm.runInContext(linkedPlayback, timingContext);
  const sync = timingContext.WatchFusionLinkedPlaybackSync;
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

    const room = vm.createContext({roomId:'TEST', state:{revision:5, roomId:'TEST', serverTime:900}});
    const connection = readClient('room-connection.js'), realtime = readClient('realtime.js');
    vm.runInContext(connection.slice(connection.indexOf('function applyIncomingRoomState'), connection.indexOf('function startSseEvents'))
      + realtime.slice(realtime.indexOf('let realtimeRevision'), realtime.indexOf('function websocketUrl')), room);
    assert.equal(room.acceptRealtimeState({revision:4, roomId:'TEST', serverTime:950}), false);
    assert.equal(room.acceptRealtimeState({revision:5, roomId:'TEST', serverTime:850}), false);
    assert.equal(room.acceptRealtimeState({revision:6, roomId:'OTHER', serverTime:950}), false);
    assert.equal(room.acceptRealtimeState({revision:6, roomId:'TEST', serverTime:950}), true);
  });

  await check('TIMING-24:room routes preserve authority and zero-position transitions', async () => {
    async function route(action, body, memberId = '') {
      const url = new URL('http://fixture.invalid/api/rooms/SYNCFIXTURE/' + action);
      const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
        method:'POST', headers:{'x-member-id':memberId}
      });
      const res = { writeHead(code) { this.code = code; }, end(value) { this.data = JSON.parse(value); } };
      await handleRoomRoute(req, res, url, url.pathname.split('/').filter(Boolean));
      return res;
    }
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
    const ping = (await route('ping', {}, viewer)).data;
    assert.ok(ping.serverReceivedAt > 0 && ping.serverTime >= ping.serverReceivedAt);
  });

  await check('TIMING-25:stalled-youtube-viewer-does-not-loop-seeks', () => {
    let elapsed = 0, position = 90, playerState = 1;
    const seeks = [], network = [];
    let roundToKeyframe = false;
    const status = { textContent: '' };
    const elements = new Map([['syncStatus', status]]);
    for (const id of ['devicePlaybackTiming', 'deviceTimingSummary', 'deviceTimingValue',
      'deviceTimingEarlier', 'deviceTimingLater', 'deviceTimingApply', 'deviceTimingReset']) {
      elements.set(id, { addEventListener(_type, fn) { this.click = fn; } });
    }
    const preferences = new Map();
    const playback = { position: 100, paused: false, rate: 1, updatedAt: 10000, projectedAt: 10000 };
    const context = {
      roomId: 'linked-room', state: { source: { videoId: 'fixture' }, playback },
      ytPlayerReady: true, playerInitializing: false, primingPlayer: false,
      ytPlayer: {
        getCurrentTime: () => position, getPlayerState: () => playerState,
        getPlaybackRate: () => 1, getDuration: () => 250, getVideoLoadedFraction: () => 1,
        seekTo: (value, allowNetwork) => { seeks.push(value); network.push(allowNetwork); if (roundToKeyframe) position = Math.floor(value * 2) / 2 - .5; },
        pauseVideo: () => { playerState = 2; }
      },
      window: { YT: { PlayerState: { PLAYING: 1, PAUSED: 2, BUFFERING: 3 } } },
      followsRoomPlayback: () => true, isHost: () => false, isTryCloudflare: false,
      estimatedServerNow: () => 10000 + elapsed, performance: { now: () => elapsed },
      storage: preferences,
      applyRoomAudioState() {}, requestViewerPlayback() {}, render() {},
      syncPlayer: options => context.window.applyAdaptiveViewerSync(options.force),
      $: id => elements.get(id), setStatus: value => { status.textContent = value; },
      setInterval() {}, document: { addEventListener() {} }
    };
    context.globalThis = context.window;
    for (const script of ['client/linked-playback-sync.js', 'playback-sync.js']) {
      vm.runInNewContext(fs.readFileSync(path.join(CLIENT, '..', script), 'utf8'), context);
    }
    const tickViewer = context.window.applyAdaptiveViewerSync;
    for (; elapsed < 9000; elapsed += 250) {
      if (elapsed === 5000) Object.assign(playback, { position: 105, updatedAt: 15000, projectedAt: 15000 });
      tickViewer();
    }
    assert.equal(seeks.length, 1, 'a stalled clock and an equivalent new room anchor cannot restart catch-up');
    assert.match(status.textContent, /Playback is behind/);

    tickViewer(true);
    assert.equal(seeks.length, 2, 'manual Sync me bypasses the seek latch');
    Object.assign(playback, { position: 60, updatedAt: 19000, projectedAt: 19000 });
    tickViewer();
    tickViewer();
    assert.equal(seeks.length, 3, 'a genuine source jump rearms correction');
    elapsed += 3000;
    playerState = 3;
    tickViewer();
    tickViewer();
    assert.equal(seeks.length, 3, 'buffering still owns recovery');
    playerState = 1;
    for (let tick = 0; tick < 8; tick++) {
      elapsed += 250;
      position = 60 + (elapsed - 9000) / 1000;
      tickViewer();
    }
    assert.equal(context.window.watchFusionSyncDiagnostics().autoSync.attempts, 0);
    position -= 3;
    for (let tick = 0; tick < 8; tick++) {
      elapsed += 250;
      position += .25;
      tickViewer();
    }
    assert.equal(seeks.length, 4, 'a viewer that recovered can correct a later independent drift');

    Object.assign(playback, { position: 60, paused: true, updatedAt: 26001, projectedAt: 26001 });
    tickViewer();
    tickViewer();
    assert.equal(seeks.length, 5, 'a paused snapshot issues one seek while the TV position is stale');
    assert.equal(playerState, 2);

    position = 60;
    tickViewer();
    Object.assign(playback, { position: 59, updatedAt: 26002, projectedAt: 26002 });
    tickViewer();
    assert.equal(seeks.length, 6, 'subsequent paused seeks still follow the host');

    Object.assign(playback, { position: 60, paused: false, rate: 2, updatedAt: 26000, projectedAt: 26000 });
    context.render();
    elements.get('deviceTimingEarlier').click();
    elements.get('deviceTimingEarlier').click();
    assert.equal(seeks.length, 6, 'staging device timing never seeks');
    elements.get('deviceTimingApply').click();
    assert.ok(Math.abs(seeks.at(-1) - 60.1) < 1e-8, '50 ms earlier advances 100 ms on the 2x media timeline');
    assert.equal(seeks.length, 7, 'Apply requests one local seek');
    assert.equal(playback.position, 60, 'device timing never changes the shared timeline');
    assert.equal(preferences.get('watchfusion.youtubePlaybackDelayMs'), '-50');
    elements.get('deviceTimingReset').click();
    assert.equal(seeks.at(-1), 60, 'Reset targets the original room position');
    assert.equal(preferences.get('watchfusion.youtubePlaybackDelayMs'), '0');

    context.window.watchFusionPresentation = { adjustmentMs: () => -850 };
    context.syncPlayer({force:true});
    assert.ok(Math.abs(seeks.at(-1) - 61.7) < 1e-8, 'calibration overrides the saved manual setting at 2x');
    assert.equal(preferences.get('watchfusion.youtubePlaybackDelayMs'), '0');
    delete context.window.watchFusionPresentation;

    // A source change re-arms one in-buffer adjustment at a steady 240 ms lag.
    context.state = { ...context.state, source: {videoId:'next-video'} };
    Object.assign(playback, { position: 60, rate: 1, updatedAt: 26000, projectedAt: 26000 });
    playerState = 1;
    // Clearing the exact local preference is distinct from changing room state.
    assert.equal(context.window.watchFusionSyncDiagnostics().deviceDelayMs, 0);
    const before = seeks.length;
    for (let tick = 0; tick < 64; tick++) {
      elapsed = 16000 + tick * 250;
      position = 60 + tick * .25 - .24;
      tickViewer();
    }
    assert.equal(seeks.length - before, 1, JSON.stringify(context.window.watchFusionSyncDiagnostics()));
    assert.equal(network.at(-1), false, 'small YouTube corrections cannot request a fresh stream segment');
    assert.equal(context.window.watchFusionSyncDiagnostics().replayLoads, 0);

    elapsed += 250;
    context.state.source.videoId = 'keyframe-fixture';
    Object.assign(playback, { position: 80.12, updatedAt: 10000 + elapsed, projectedAt: 10000 + elapsed });
    position = 80.12;
    roundToKeyframe = true;
    context.window.watchFusionPresentation = { adjustmentMs: () => 15 };
    const beforeCalibration = seeks.length;
    tickViewer(true, true);
    assert.equal(seeks.length - beforeCalibration, 1);
    assert.equal(network.at(-1), false, 'a small offset only tries an in-buffer seek');
    assert.ok(Math.abs(seeks.at(-1) - 80.105) < 1e-6);
    const simulatedLanding = position;
    playerState = 3;
    for (let tick = 0; tick < 60; tick++) { elapsed += 250; tickViewer(); }
    assert.equal(position, simulatedLanding);
    assert.equal(seeks.length - beforeCalibration, 1, 'keyframe rounding followed by buffering cannot loop');
    assert.equal(context.window.watchFusionSyncDiagnostics().replayLoads, 0);
  });

}
