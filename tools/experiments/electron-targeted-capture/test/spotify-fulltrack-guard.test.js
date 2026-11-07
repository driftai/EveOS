'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, normalizeSpotifyInput } = require('../direct-runtime');

const URI = 'spotify:track:4cOdK2wGLETKBW3PvgPWqT';
const URL = 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT';

function harness() {
  let runtime, last, calls = [], muted = [];
  const source = { isDestroyed: () => false, show() {}, hide() {}, webContents: {
    async executeJavaScript(code, gesture) {
      const request = JSON.parse(/__eveSpotifyCommand\((.*)\)$/.exec(code)[1]);
      calls.push({ action: request.action, payload: request.payload, gesture });
      if (request.action === 'load') last = request.payload;
      if (request.action === 'play') runtime.sourceEvent({ type: 'state', identity: last,
        status: 'playing', currentTime: 2, duration: 181, paused: false });
      if (request.action === 'pause') runtime.sourceEvent({ type: 'state', identity: last,
        status: 'paused', currentTime: 2, duration: 181, paused: true });
      return { ok: true };
    }
  } };
  runtime = createRuntime({
    app: { quit() {} }, cfg: { deviceId: 'sd:7', outputMode: 'windows', ownerPid: 0 },
    note() {}, bridge: { totals() { return {}; } }, ipcMain: { on() {} },
    getSourceWin: () => source, getCaptureWin: () => null, fromSource: () => true,
    setSourceMuted(value) { muted.push(value); }, output: { write() {} }
  });
  runtime.sourceEvent({ type: 'ready' });
  return { runtime, calls, muted };
}

async function playing(duration = 181) {
  const h = harness();
  const response = await h.runtime.command('play', { spotifyUrl: URL, spotifyUri: URI, duration });
  assert.equal(response.ok, true);
  return h;
}

test('only exact typed Spotify URLs from the official origin are eligible', () => {
  assert.deepEqual(normalizeSpotifyInput({ spotifyUrl: URL }), {
    spotifyUri: URI, spotifyUrl: URL, spotifyId: '4cOdK2wGLETKBW3PvgPWqT', mediaType: 'track'
  });
  assert.equal(normalizeSpotifyInput({ spotifyUrl: URL.replace('/track/', '/embed/track/') }).spotifyUrl, URL);
  assert.throws(() => normalizeSpotifyInput({ spotifyUrl: 'https://evil.example/track/4cOdK2wGLETKBW3PvgPWqT' }), /URL\/URI/);
  assert.throws(() => normalizeSpotifyInput({ spotifyUrl: URL + '?si=sensitive' }), /URL\/URI/);
  assert.throws(() => normalizeSpotifyInput({ spotifyUrl: URL.replace('https:', 'http:') }), /URL\/URI/);
  assert.throws(() => normalizeSpotifyInput({ spotifyUrl: URL, spotifyUri: URI.replace('track', 'episode') }), /does not match/);
  assert.throws(() => normalizeSpotifyInput({ spotifyUrl: URL, mediaType: 'episode' }), /media type mismatch/);
});

test('Play sends the canonical URL to the official embed and retains user activation', async () => {
  const h = await playing();
  const load = h.calls.find(c => c.action === 'load');
  assert.equal(load.payload.spotifyUrl, URL);
  assert.equal(load.payload.spotifyUri, URI);
  assert.equal(h.calls.find(c => c.action === 'play').gesture, true);
  assert.equal(h.runtime.publicState().outputMuted, true);
});

test('30-second previews are rejected, remuted, and cannot be resumed as full tracks', async () => {
  const h = await playing();
  h.runtime.sourceEvent({ type: 'state', status: 'playing', identity: { spotifyUri: URI },
    currentTime: 4, duration: 30.432, paused: false });
  const state = h.runtime.publicState();
  assert.equal(state.status, 'error');
  assert.match(state.playbackError, /30\.4s preview.*181\.0s/);
  assert.equal(state.outputMuted, true);
  await assert.rejects(() => h.runtime.command('resume'), /preview|Full-track|failed/);
  await assert.rejects(() => h.runtime.command('route-ready'), /preview|Full-track|failed/);
  h.runtime.sourceEvent({ type: 'state', status: 'playing', currentTime: 11, duration: 30, paused: false });
  assert.equal(h.runtime.publicState().status, 'error', 'a stale Spotify event cannot clear the terminal failure');
  h.runtime.sourceEvent({ type: 'ready' });
  assert.equal(h.runtime.publicState().status, 'error', 'a late ready event cannot clear DRM failure');
});

test('two real Spotify Widevine HTTP failures fail closed, not fake playing', async () => {
  const h = await playing();
  h.runtime.onLicenseResponse(500, 1000);
  assert.equal(h.runtime.publicState().status, 'playing', 'single error may be transient');
  h.runtime.onLicenseResponse(500, 1001);
  assert.equal(h.runtime.publicState().status, 'error');
  assert.match(h.runtime.publicState().playbackError, /Widevine audio license.*HTTP 500/);
  assert.equal(h.runtime.publicState().outputMuted, true);
  assert.equal(h.muted.at(-1), true);
});

test('stalled 10.018s transport fails closed and cannot be marked complete', async () => {
  const h = await playing();
  h.runtime.sourceEvent({ type: 'state', status: 'playing', identity: { spotifyUri: URI },
    currentTime: 10.018, duration: 181, paused: false });
  const now = Date.now();
  h.runtime.observeProgress(now);
  h.runtime.observeProgress(now + 15000);
  assert.equal(h.runtime.publicState().status, 'error');
  assert.match(h.runtime.publicState().playbackError, /position stalled/);
  assert.equal(h.runtime.publicState().outputMuted, true);
  assert.equal(h.runtime.publicState().advancedBeyondPreview, false);
});

test('normal progressing full track does not spuriously fail or claim completion early', async () => {
  const h = await playing();
  const now = Date.now();
  for (const t of [5, 10, 20, 31, 36, 45]) {
    h.runtime.sourceEvent({ type: 'state', identity: { spotifyUri: URI },
      status: 'playing', currentTime: t, duration: 181, paused: false });
    h.runtime.observeProgress(now + t * 1000);
  }
  assert.equal(h.runtime.publicState().status, 'playing');
  assert.equal(h.runtime.publicState().advancedBeyondPreview, true);
  assert.notEqual(h.runtime.publicState().status, 'ended');
});

test('fresh Play clears the previous DRM error before the new URL is loaded', async () => {
  const h = await playing();
  h.runtime.onLicenseResponse(500, 1000);
  h.runtime.onLicenseResponse(500, 1001);
  assert.equal(h.runtime.publicState().status, 'error');
  assert.match(h.runtime.publicState().playbackError, /Widevine/);
  const replay = await h.runtime.command('play', { spotifyUrl: URL, spotifyUri: URI, duration: 181 });
  assert.equal(replay.ok, true);
  assert.equal(h.runtime.publicState().status, 'playing');
  assert.equal(h.runtime.publicState().playbackError, '', 'DRM failure from an earlier intent must not leak');
  assert.equal(h.runtime.publicState().outputMuted, true, 'route remains fail-closed pending readiness');
});
