'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root,
  'js/modules/features/audioflix/audioflix.spotify.edge.js'), 'utf8');
const failureSource = fs.readFileSync(path.join(root,
  'js/modules/features/audioflix/audioflix.spotify.edge.failures.js'), 'utf8');
const uri = `spotify:track:${'R'.repeat(22)}`;
const item = { id: 'recovered', type: 'music', title: 'Recovered card',
  spotifyUri: uri, duration: 180, volume: 0.7 };
const events = [], commands = [];
let interval = null;
let status = { ok: true, running: true, mediaRevision: 4, endedRevision: -1,
  identity: uri, status: 'cable-routed', routeConfirmed: true,
  state: { paused: false, currentTime: 27, duration: 180, ended: false } };
const audio = {
  ready: true,
  async playItem() { return true; }, async layerPlay() { return true; },
  async openInternalView() { return true; }, async pause() { return true; },
  async resume() { return true; }, async seek() { return true; },
  async stopAll() { return true; }, async stopItemLayers() { return true; },
  updateItemVolume() {}, getPlaybackState() { return {}; }, getStatus() { return {}; },
  isInternalViewOpen() { return false; }, hideInternalView() {}, closeInternalView() {}, syncQueueView() {}
};
const window = {
  EveAudioflixSpotifyEdge: {}, EveAudioflixAudio: audio,
  EveAudioflixSpotifyEdgeHandoff: { ready: true, async releaseIdleManagedEngineBeforeEmbed() {} },
  EveAudioflixSpotifyMedia: { ready: true, fromItem: value => value?.spotifyUri
    ? { spotifyUri: value.spotifyUri } : null },
  EveAudioflixPlaybackPolicy: { resolve: () => ({ spotifyMethod: 'embed', outputKind: 'native', outputId: 'sd:2' }) },
  EveAudioflixSpotifyVolume: { effectiveGain: value => value },
  EveAudioflixState: { ensure: () => ({ music: [item] }), recordPlay() {},
    updateItem(_type, _id, patch) { Object.assign(item, patch); } },
  EveAudioflix: { queueConnection: { snapshot: () => ({ isPlaying: true,
    currentIndex: 0, entries: [{ id: item.id, title: item.title }] }) } },
  EveAudioflixNative: { ready: true, async request(url, options = {}) {
    if (url.endsWith('/spotify-edge/status')) return status;
    const body = JSON.parse(options.body || '{}'); commands.push(body);
    if (body.action === 'switch') {
      status = { ...status, mediaRevision: 5, endedRevision: -1,
        state: { paused: false, currentTime: 0, duration: 180, ended: false } };
      return status;
    }
    return { ok: true };
  } },
  dispatchEvent(event) { events.push(event); }, addEventListener() {},
  EveAudioflixVolumeTarget: { allows: () => true }
};
const context = vm.createContext({ window, document: {}, CustomEvent: class {
  constructor(type, options) { this.type = type; this.detail = options.detail; }
}, setInterval(fn) { interval = fn; return 1; }, clearInterval() {}, setTimeout, clearTimeout, Promise, console });
vm.runInContext(failureSource, context, { filename: 'audioflix.spotify.edge.failures.js' });
vm.runInContext(source, context, { filename: 'audioflix.spotify.edge.js' });
const settle = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

(async () => {
  await settle();
  let snapshot = window.EveAudioflixSpotifyEdge.snapshot();
  assert.equal(snapshot.active, true, 'running exact owner must be adopted');
  assert.equal(snapshot.item.id, item.id);
  assert.equal(audio.getPlaybackState().currentTime, 27);
  assert.equal(commands.length, 0, 'read-only adoption cannot issue provider commands');

  status = { ok: true, running: false };
  await interval(); await interval();
  assert.equal(window.EveAudioflixSpotifyEdge.snapshot().active, true,
    'two transient missing statuses must preserve the owner');
  await interval();
  assert.equal(window.EveAudioflixSpotifyEdge.snapshot().active, false,
    'three authoritative missing statuses expose unavailable state');

  status = { ok: true, running: true, mediaRevision: 4, endedRevision: 4,
    identity: uri, status: 'route-pending', routeConfirmed: false,
    state: { paused: true, currentTime: 180, duration: 180, ended: true } };
  await interval();
  snapshot = window.EveAudioflixSpotifyEdge.snapshot();
  assert.equal(snapshot.active, true, 'same owner must reconnect without Queue View');
  assert.equal(events.filter(event => event.detail?.status === 'Ended').length, 1,
    'active exact queue receives one recovered completion');
  await interval();
  assert.equal(events.filter(event => event.detail?.status === 'Ended').length, 1,
    'repeated status cannot duplicate completion');

  assert.equal(await audio.seek(0), true, 'ended seek-to-zero restarts the owner');
  assert.equal(commands.filter(command => command.action === 'switch').length, 1);
  assert.equal(window.EveAudioflixSpotifyEdge.snapshot().playback.ended, false);
  status = { ok: true, running: true, mediaRevision: 6, endedRevision: -1,
    identity: uri, status: 'cable-routed', routeConfirmed: true,
    autoPlayStatus: 'invoked-unconfirmed',
    failure: { revision: 6, kind: 'provider-playback-unavailable',
      reason: 'bounded Play attempts exhausted', terminal: true },
    state: { paused: true, currentTime: 0, duration: 180, ended: false } };
  await interval(); await interval();
  assert.equal(item.spotifyAvailability, 'failed', 'unconfirmed Play is a playback failure, not proof of URL removal');
  assert.equal(events.filter(event => event.detail?.terminal === true).length, 1,
    'one revision may advance the queue only once');
  window.EveAudioflixSpotifyEdgeFailures.begin(item);
  await interval();
  assert.equal(events.filter(event => event.detail?.terminal === true).length, 2,
    'a later explicit retry gets one fresh terminal receipt even when a new host restarts at revision zero');
  status = { ...status, mediaRevision: 7, autoPlayStatus: 'failed-timeout', failure: {
    revision: 7, kind: 'provider-start-timeout', reason: 'bounded startup deadline', terminal: true } };
  window.EveAudioflixSpotifyEdgeFailures.begin(item);
  await interval();
  assert.equal(item.spotifyAvailability, 'failed',
    'ambiguous host startup timeout is visible without permanently marking the Spotify URL unavailable');
  status = { ...status, mediaRevision: 8, failure: {
    revision: 8, kind: 'provider-track-unavailable', reason: 'provider confirmed unavailable', terminal: true } };
  window.EveAudioflixSpotifyEdgeFailures.begin(item);
  await interval();
  assert.equal(item.spotifyAvailability, 'unavailable', 'only explicit provider proof produces URL unavailable marker');
  status = { ...status, autoPlayStatus: 'confirmed', failure: {
    revision: -1, kind: '', reason: '', terminal: false },
    state: { paused: false, currentTime: 3, duration: 180, ended: false } };
  await interval();
  assert.equal(item.spotifyAvailability, '', 'later verified playback clears the unavailable marker');
  console.log('AUDIOFLIX_SPOTIFY_EDGE_RECOVERY_SMOKE_OK adopt=1 grace=2 ended=once restart=switch failure=once recovery=clear');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
