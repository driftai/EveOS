'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const file = path.join(__dirname, '../pages/spotify-source.js');
const source = fs.readFileSync(file, 'utf8');

async function createSource({ seekError = null } = {}) {
  const emitted = [], seekCalls = [], listeners = new Map();
  let stopCalls = 0;
  const controller = {
    addListener(type, fn) { listeners.set(type, fn); },
    loadUri() {},
    loadEntity() {},
    play() {},
    pause() { stopCalls += 1; },
    resume() {},
    seek(seconds) {
      seekCalls.push(seconds);
      return seekError ? Promise.reject(new Error(seekError)) : Promise.resolve();
    }
  };
  const window = { eveSpotifyDirect: {
    event(value) { emitted.push(value); },
    onCommand() {}
  }};
  const document = { getElementById: () => ({ textContent: '' }) };
  vm.runInNewContext(source, { window, document, console, Math, Date, Number, String, Error, Promise, setTimeout() {} });
  window.onSpotifyIframeApiReady({ createController(_el, _opts, cb) { cb(controller); } });
  const result = await window.__eveSpotifyCommand({ id: 'load', action: 'load', payload: { spotifyUri: 'spotify:track:2WuK1opHQzRo18YXCtY2DF' } });
  assert.equal(result.ok, true);
  return { window, emitted, seekCalls, listeners, getStopCalls: () => stopCalls };
}

test('unseekable Spotify media is rejected as a command failure, not falsely acknowledged', async () => {
  const model = await createSource({ seekError: 'HarmonyError: Seeking is not allowed with current content.' });
  const result = await model.window.__eveSpotifyCommand({ id: 'seek-1', action: 'seek', payload: { seconds: 9 } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Seeking is not allowed/);
  assert.equal(model.seekCalls.length, 1);
  assert.ok(model.emitted.some(x => x.type === 'diagnostic' && x.stage === 'command-error' && x.action === 'seek'));
});

test('stop never seeks into unseekable Spotify content', async () => {
  const model = await createSource({ seekError: 'HarmonyError: Seeking is not allowed with current content.' });
  const result = await model.window.__eveSpotifyCommand({ id: 'stop-1', action: 'stop' });
  assert.equal(result.ok, true);
  assert.equal(model.getStopCalls(), 1);
  assert.deepEqual(model.seekCalls, []);
  assert.equal(result.state.status, 'stopped');
  assert.equal(result.state.currentTime, 0);
});

test('seekable content still permits seeking', async () => {
  const model = await createSource();
  const result = await model.window.__eveSpotifyCommand({ id: 'seek-2', action: 'seek', payload: { seconds: 18.5 } });
  assert.equal(result.ok, true);
  assert.deepEqual(model.seekCalls, [18.5]);
});
