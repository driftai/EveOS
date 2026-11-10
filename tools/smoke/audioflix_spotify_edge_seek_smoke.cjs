'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(ROOT,
  'js/modules/features/audioflix/audioflix.spotify.edge.js'), 'utf8');
const uri = `spotify:track:${'A'.repeat(22)}`;
const calls = [];
let releaseFirstSeek;
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
  EveAudioflixSpotifyMedia: { ready: true, fromItem: item => item?.spotifyUri ? { spotifyUri: item.spotifyUri } : null },
  EveAudioflixPlaybackPolicy: { resolve: () => ({ spotifyMethod: 'embed', outputKind: 'native', outputId: 'sd:7' }) },
  EveAudioflixSpotifyVolume: { effectiveGain: value => value }, EveAudioflixState: { recordPlay() {} },
  EveAudioflixNative: { ready: true, async request(url, options = {}) {
    if (url.endsWith('/spotify-browser/status')) return { ok: true, browserRunning: false };
    if (url.endsWith('/spotify-edge/status')) return { ok: true, running: true,
      mediaRevision: 7, identity: uri, status: 'cable-routed', routeConfirmed: true,
      state: { paused: false, currentTime: 2, duration: 100 } };
    const body = JSON.parse(options.body || '{}'); calls.push(body);
    if (body.action === 'play') return { ok: true, running: true, mediaRevision: 7,
      identity: uri, status: 'cable-routed', routeConfirmed: true,
      state: { paused: false, currentTime: 1, duration: 100 } };
    if (body.action === 'switch') return { ok: true, running: true, mediaRevision: 8,
      identity: uri, status: 'cable-routed', routeConfirmed: true,
      state: { paused: false, currentTime: 0, duration: 100, ended: false } };
    if (body.action === 'seek' && calls.filter(call => call.action === 'seek').length === 1)
      return new Promise(resolve => { releaseFirstSeek = resolve; });
    return { ok: true };
  } },
  dispatchEvent() {}, addEventListener() {}, EveAudioflixVolumeTarget: { allows: () => true }
};
const context = vm.createContext({ window, document: {}, CustomEvent: class {
  constructor(type, options) { this.type = type; this.detail = options.detail; }
}, setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout, Promise, console });
vm.runInContext(source, context, { filename: 'audioflix.spotify.edge.js' });

(async () => {
  const item = { id: 'song-a', type: 'music', title: 'Song A', spotifyUri: uri, duration: 100, volume: 1 };
  await audio.playItem(item);
  assert.equal(await audio.restartCurrent(item), true);
  assert.equal(calls.filter(call => call.action === 'switch').length, 1);
  await audio.seek(10); await audio.seek(20); await audio.seek(30);
  assert.deepEqual(calls.filter(call => call.action === 'seek').map(call => call.payload.seconds), [10]);
  releaseFirstSeek({ ok: true });
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  const seeks = calls.filter(call => call.action === 'seek');
  assert.deepEqual(seeks.map(call => call.payload.seconds), [10, 30]);
  assert.equal(seeks[1].payload.spotifyUri, uri);
  assert.equal(seeks[1].payload.revision, 8);
  console.log('AUDIOFLIX_SPOTIFY_EDGE_SEEK_SMOKE_OK restart=owned requests=2 intents=3 latest=30');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
