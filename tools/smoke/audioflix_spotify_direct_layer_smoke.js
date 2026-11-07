'use strict';
// Regression: the card's action='layer-play' must reach Electron Direct, never the iframe layer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..', '..');
const SOURCE = path.join(ROOT, 'js/modules/features/audioflix/audioflix.spotify.direct.js');
const requests = [], events = [];
let policyMethod = 'electron', baseLayerCalls = 0, baseStopCalls = 0;
let failure = false;
const id = { spotifyUri: 'spotify:track:2WuK1opHQzRo18YXCtY2DF', spotifyId: '2WuK1opHQzRo18YXCtY2DF', mediaType: 'track' };
const track = { id: 'music_647', type: 'music', title: 'Six Forty Seven',
  url: 'https://open.spotify.com/track/2WuK1opHQzRo18YXCtY2DF', volume: 0.6 };
const sound = { id: 'my_sound', type: 'sound', url: 'https://example.test/sound.mp3' };
const audio = {
  ready: true,
  async playItem() { return true; },
  async layerPlay() { baseLayerCalls++; return true; },
  async openInternalView() { return true; },
  async pause() { return true; }, async resume() { return true; }, async seek() { return true; },
  async stopAll() { baseStopCalls++; return true; },
  async stopItemLayers() { return true; },
  updateItemVolume() {}, getPlaybackState() { return { paused: true }; }, getStatus() { return {}; }
};
const window = {
  EveAudioflixAudio: audio,
  EveAudioflix: { queueConnection: { snapshot: () => ({ playbackRunId: 1 }) } },
  EveAudioflixSpotifyMedia: { ready: true, fromItem(item) {
    return item?.url?.startsWith('https://open.spotify.com/track/') ? id : null;
  } },
  EveAudioflixSpotifyVolume: { effectiveGain: value => value },
  EveAudioflixPlaybackPolicy: { resolve() { return { spotifyMethod: policyMethod,
    sourcePreference: 'original', outputKind: 'native', outputId: 'sd:7' }; } },
  EveAudioflixLocalPlayback: { async prepare() { return null; } },
  EveAudioflixNative: { ready: true, async request(route, opts = {}) {
    const action = JSON.parse(opts.body || '{}').action || 'status';
    requests.push(action);
    if (failure && action === 'play') return { ok: false, reason: 'Synthetic host failure' };
    return { ok: true, running: true,
      state: { status: 'playing', paused: false, currentTime: 0, duration: 119, identity: id } };
  } },
  addEventListener() {},
  dispatchEvent(event) { events.push(event); }
};
const context = vm.createContext({ window, console, setInterval: () => 1, clearInterval() {},
  setTimeout, clearTimeout, CustomEvent: class { constructor(type, options) {
    this.type = type; this.detail = options.detail;
  } } });
vm.runInContext(fs.readFileSync(SOURCE, 'utf8'), context, { filename: 'audioflix.spotify.direct.js' });
(async () => {
  assert.equal(window.EveAudioflixSpotifyDirect.ready, true);
  // This is the path called by the AudioFlix UI card's layer-play action.
  assert.equal(await audio.layerPlay(track), true);
  assert.equal(requests.filter(x => x === 'play').length, 1, 'card play must command Direct');
  assert.equal(baseLayerCalls, 0, 'card play must not create an iframe provider layer');
  assert.equal(baseStopCalls, 1, 'Direct must take exclusive provider ownership');
  assert.equal(audio.getPlaybackState().electronDirect, true);

  assert.equal(await audio.layerPlay(sound), true);
  assert.equal(baseLayerCalls, 1, 'ordinary sound layers must remain independent');
  policyMethod = 'managed';
  assert.equal(await audio.layerPlay(track), true);
  assert.equal(baseLayerCalls, 2, 'managed Spotify Layer Play must retain old behavior');
  policyMethod = 'electron';
  failure = true;
  assert.equal(await audio.layerPlay({ ...track, id: 'new_track' }), false,
    'failed Direct launch must fail rather than silently falling back to embed');
  assert.equal(baseLayerCalls, 2, 'failed Direct must never construct a fallback iframe');
  assert(events.some(e => e.type === 'eve:audioflix-playback' && e.detail.error === true),
    'Direct errors should be visible to AudioFlix');
  console.log('SPOTIFY_DIRECT_LAYER_CARD_SMOKE_PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
