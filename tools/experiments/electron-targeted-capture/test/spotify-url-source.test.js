'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'pages', 'spotify-source.js'), 'utf8');
const A = '4cOdK2wGLETKBW3PvgPWqT', B = '2WuK1opHQzRo18YXCtY2DF';
function harness() {
  const options = [], loaded = [], events = [];
  const document = { getElementById(id) { return { id, textContent: '' }; }, querySelector() { return null; } };
  const controller = { addListener() {}, loadEntity(url) { loaded.push(url); }, play() {}, pause() {}, resume() {}, seek() {} };
  const window = { eveSpotifyDirect: { event(e) { events.push(e); }, onCommand() {} } };
  vm.runInNewContext(src, { window, document, console, setTimeout() {}, URL }, { filename: 'spotify-source.js' });
  window.onSpotifyIframeApiReady({ createController(_el, opts, callback) {
    options.push(opts); callback(controller);
  } });
  return { window, options, loaded, events };
}
test('Spotify song URL directly owns first iframe controller and later loadEntity', async () => {
  const h = harness();
  assert.equal((await h.window.__eveSpotifyCommand({ id: 'a', action: 'load', payload: {
    spotifyUri: `spotify:track:${A}`, spotifyUrl: `https://open.spotify.com/track/${A}`
  } })).ok, true);
  assert.equal(h.options.length, 1);
  assert.equal(h.options[0].url, `https://open.spotify.com/track/${A}`);
  assert.equal(h.options[0].uri, undefined);
  assert.equal((await h.window.__eveSpotifyCommand({ id: 'b', action: 'load', payload: {
    spotifyUri: `spotify:track:${B}`, spotifyUrl: `https://open.spotify.com/track/${B}`
  } })).ok, true);
  assert.deepEqual(h.loaded, [`https://open.spotify.com/track/${B}`]);
});
test('URL/URI mismatch or noncanonical URL never reaches Spotify iframe', async () => {
  const h = harness();
  const wrong = await h.window.__eveSpotifyCommand({ id: 'x', action: 'load', payload: {
    spotifyUri: `spotify:track:${A}`, spotifyUrl: `https://open.spotify.com/track/${B}`
  } });
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason, /URL\/URI mismatch/);
  assert.equal(h.options.length, 0);
  assert.equal(h.loaded.length, 0);
});
