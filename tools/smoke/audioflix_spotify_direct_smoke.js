'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..', '..');
const listeners = new Map(), requests = [], events = [];
let statusEnded = false, basePlay = 0, baseStop = 0, queueRunId = 1;
const spotifyItem = { id: 'spotify-a', title: 'Direct A', type: 'music', volume: 0.5,
  url: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT', sourceProvider: 'spotify' };
const identity = { spotifyUri: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT', spotifyId: '4cOdK2wGLETKBW3PvgPWqT', mediaType: 'track' };
const audio = {
  ready: true,
  async playItem() { basePlay += 1; return true; }, async openInternalView(item) { return this.playItem(item); },
  async pause() { return true; }, async resume() { return true; }, async seek() { return true; },
  async stopAll() { baseStop += 1; return true; }, async stopItemLayers() { return true; },
  updateItemVolume() {}, getPlaybackState() { return { item: null, paused: true }; }, getStatus() { return {}; }
};
function response(action) {
  const status = statusEnded ? 'ended' : action === 'pause' ? 'paused' : action === 'stop' ? 'stopped' : 'playing';
  return { ok: true, running: true, state: { status, paused: status !== 'playing', currentTime: statusEnded ? 30 : 2,
    duration: 30, completionId: statusEnded ? 'done-1' : '', identity } };
}
const context = vm.createContext({ console, setTimeout, clearTimeout, setInterval, clearInterval,
  CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  window: {
    EveAudioflixAudio: audio,
    EveAudioflix: { queueConnection: { snapshot: () => ({ playbackRunId: queueRunId }) } },
    EveAudioflixNative: { ready: true, async request(route, options = {}) {
      const body = options.body ? JSON.parse(options.body) : { action: 'status' };
      requests.push({ route, body }); return response(body.action);
    } },
    EveAudioflixSpotifyMedia: { ready: true, fromItem(item) { return /open\.spotify\.com/.test(item?.url || '') ? identity : null; } },
    EveAudioflixSpotifyVolume: { effectiveGain(value) { return Number(value) * 0.8; } },
    EveAudioflixPlaybackPolicy: { resolve() { return { spotifyMethod: 'electron', sourcePreference: 'original',
      outputKind: 'native', outputId: 'sd:7' }; } },
    EveAudioflixLocalPlayback: { async prepare() { return null; } },
    dispatchEvent(event) { events.push(event); (listeners.get(event.type) || []).forEach((fn) => fn(event)); },
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); }
  }
});
context.window.window = context.window;
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/modules/features/audioflix/audioflix.spotify.direct.js'), 'utf8'), context,
  { filename: 'audioflix.spotify.direct.js' });

(async () => {
  assert.equal(await audio.playItem(spotifyItem), true);
  assert.equal(baseStop, 1, 'direct route takes exclusive ownership through the existing Stop owner');
  assert.equal(requests.find((entry) => entry.body.action === 'play').body.payload.deviceId, 'sd:7');
  assert.equal(requests.find((entry) => entry.body.action === 'play').body.payload.gain, 0.4);
  assert.equal(audio.getPlaybackState().electronDirect, true);
  const before = requests.filter(entry => entry.body.action === 'play').length;
  await audio.playItem({ ...spotifyItem, id: 'spotify-b' });
  assert.equal(requests.filter(entry => entry.body.action === 'play').length, before + 1);
  assert.equal(audio.getPlaybackState().item.id, 'spotify-b');
  queueRunId += 1;
  await audio.playItem({ ...spotifyItem, id: 'spotify-b' });
  assert.equal(requests.filter(entry => entry.body.action === 'play').length, before + 2,
    'new queue run of same item needs a new play');
  await audio.pause(); await audio.resume(); audio.updateItemVolume('spotify-b', 0.25);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(requests.some((entry) => entry.body.action === 'pause'));
  assert(requests.some((entry) => entry.body.action === 'resume'));
  assert(requests.some((entry) => entry.body.action === 'volume' && entry.body.payload.gain === 0.2));
  statusEnded = true;
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert(events.some((event) => event.type === 'eve:audioflix-playback' && event.detail.status === 'Ended'),
    'official completion reaches the existing queue event owner');
  await audio.stopAll();
  assert(requests.some((entry) => entry.body.action === 'stop'));
  assert(baseStop >= 2, 'base transport and layers remain under the shared Stop owner');
  console.log('audioflix Spotify Direct Embed smoke passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
