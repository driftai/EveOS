'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..', '..');

function playbackFixture() {
  const instances = [];
  class Audio {
    constructor() {
      this.listeners = new Map(); this.currentTime = 0; this.duration = 14;
      this.paused = true; this.volume = 1; this.playbackRate = 1;
      this.src = ''; instances.push(this);
    }
    addEventListener(type, callback) {
      const handlers = this.listeners.get(type) || [];
      handlers.push(callback); this.listeners.set(type, handlers);
    }
    emit(type) { for (const handler of this.listeners.get(type) || []) handler(); }
    async play() {
      if (!this.src) throw new Error('Attempted to resume an ended, released media source');
      this.paused = false; this.emit('play');
    }
    pause() { this.paused = true; this.emit('pause'); }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    load() {}
  }
  const events = [];
  const window = {
    EveAudioflixUrlLoaders: { loadScript() {}, loadYouTubeApi() {} },
    EveAudioflixUrlProviders: { providerFor: () => 'direct', youtubeId: () => '', shouldPreferBrowser: () => true },
    EveAudioflixUrlWidgets: { create: () => ({playSoundCloud: async () => {}, playVimeo: async () => {}}) },
    EveAudioflixSpotifyPlayback: { create: () => ({}) },
    EveAudioflixInstagramPlayback: { create: () => ({}) },
    EveAudioflixOutputPort: { effective: value => value },
    EveAudioflixState: { ensure: () => ({}) },
    EveAudioflixNative: { shouldSuppressBrowserPlayback: () => false },
    EveAudioflixVolumeTarget: { allows: () => true },
    EveAudioflixAudio: { getMusicCapture: () => null, resolvePlaybackSink: async () => null },
    EveAudioflixLocalPlayback: {
      setMediaSource: (player, url) => { player.src = url; return true; },
      clearMediaSource: player => { player.src = ''; return true; }
    }
  };
  const ctx = vm.createContext({ window, Audio, console, URL,
    location: { href:'http://127.0.0.1:8765', origin:'http://127.0.0.1:8765',protocol:'http:' },
    setInterval, clearInterval });
  for (const relative of ['audioflix.audio.url.direct.js', 'audioflix.audio.url.js']) {
    const file = path.join(root, 'js/modules/features/audioflix', relative);
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: relative });
  }
  const controller = window.EveAudioflixUrlPlayback.createController({onPlayback: e => events.push(e)});
  return {controller, instances, events};
}

test('localized direct player retires on ended and creates a fresh player when repeating the same track', async () => {
  const {controller, instances, events} = playbackFixture();
  const item = {id:'localized-track-001', title:'Localized Track', url:'blob:authorized-local-track', volume:0.7};
  assert.equal(await controller.play(item), true);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].src, item.url);
  instances[0].currentTime = instances[0].duration;
  instances[0].paused = true;
  instances[0].emit('ended');
  assert.equal(events.filter(e => e.status === 'Ended').length, 1);
  assert.equal(instances[0].src, '', 'ended media must be unloaded');
  assert.equal(controller.isActive(), false, 'unloaded direct session must not be offered for same-key resume');
  assert.equal(await controller.play(item), true);
  assert.equal(instances.length, 2, 'repeat starts a new playable session rather than resuming an empty source');
  assert.equal(instances[1].src, item.url);
  assert.equal(instances[1].paused, false);
  assert.equal(events.filter(e => e.status === 'Ended').length, 1, 'repeat does not emit a duplicate Ended');
});

test('stale ended from a replaced direct session cannot retire a newer playback session', async () => {
  const {controller, instances, events} = playbackFixture();
  const first = {id:'track-one', title:'One', url:'blob:one'};
  const second = {id:'track-two', title:'Two', url:'blob:two'};
  await controller.play(first);
  await controller.play(second);
  assert.equal(instances.length, 2);
  instances[0].emit('ended');
  assert.equal(controller.isActive(), true);
  assert.equal(instances[1].src, 'blob:two');
  assert.equal(events.filter(e => e.status === 'Ended').length, 0);
});
