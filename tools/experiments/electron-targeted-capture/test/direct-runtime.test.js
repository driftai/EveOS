'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRuntime, MEDIA_RE } = require('../direct-runtime');

function harness(deviceId = 'sd:7') {
  let runtime, bridgeReady = false, current = null, gain = 1, captureStarts = 0, loads = 0;
  const source = { isDestroyed: () => false, show() {}, hide() {}, webContents: {
    mainFrame: { url: 'file:///spotify-source.html' },
    async executeJavaScript(code) {
      const match = /__eveSpotifyCommand\((.*)\)$/.exec(code), request = JSON.parse(match[1]);
      if (request.action === 'load') { current = { ...request.payload }; loads += 1; }
      if (request.action === 'play' || request.action === 'resume') runtime.sourceEvent({ type: 'state',
        identity: current, status: 'playing', paused: false, currentTime: 1, duration: 30, generation: 1 });
      if (request.action === 'pause') runtime.sourceEvent({ type: 'state', identity: current,
        status: 'paused', paused: true, currentTime: 2, duration: 30, generation: 1 });
      return { ok: true };
    },
    send(_channel, request) {
      queueMicrotask(() => {
        if (request.action === 'load') { current = { ...request.payload }; loads += 1; }
        runtime.sourceEvent({ type: 'reply', id: request.id, ok: true });
        if (request.action === 'play' || request.action === 'resume') runtime.sourceEvent({ type: 'state',
          identity: current, status: 'playing', paused: false, currentTime: 1, duration: 30, generation: 1 });
        if (request.action === 'pause') runtime.sourceEvent({ type: 'state', identity: current,
          status: 'paused', paused: true, currentTime: 2, duration: 30, generation: 1 });
      });
    }
  } };
  const capture = { isDestroyed: () => false, webContents: { async executeJavaScript(code, gesture) {
    const match = /__eveCaptureControl\((.*)\)$/.exec(code), value = JSON.parse(match[1]);
    if (value.action === 'start') {
      assert.equal(gesture, true, 'capture start retains Electron user-gesture authorization');
      captureStarts += 1; bridgeReady = true;
      queueMicrotask(() => runtime.captureEvent('capture-started', {}, { ok: true }));
    }
    if (value.action === 'stop') bridgeReady = false;
    if (value.action === 'gain') gain = value.gain;
    return { ok: true };
  } } };
  const bridge = { totals: () => ({ ready: bridgeReady, active: bridgeReady }) };
  runtime = createRuntime({ app: { quit() {} }, cfg: { deviceId, ownerPid: 0 }, note() {}, bridge,
    ipcMain: { on() {} }, getSourceWin: () => source, getCaptureWin: () => capture, fromSource: () => true,
    output: { write() {} } });
  runtime.sourceEvent({ type: 'ready' });
  return { runtime, diagnostics: () => ({ gain, captureStarts, current, loads }) };
}

test('direct runtime owns play, pause, volume and stop without Playwright', async () => {
  const h = harness();
  const identity = { spotifyUri: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT', itemId: 'song-a', title: 'Test' };
  const played = await h.runtime.command('play', { ...identity, gain: 0.5 });
  assert.equal(played.ok, true);
  assert.equal(played.state.status, 'playing');
  assert.deepEqual(h.diagnostics(), { gain: 0.5, captureStarts: 1, current: { ...identity,
    spotifyId: '4cOdK2wGLETKBW3PvgPWqT', mediaType: 'track',
    spotifyUrl: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT', duration: 0 }, loads: 1 });
  assert.equal((await h.runtime.command('pause')).state.status, 'paused');
  await h.runtime.command('volume', { gain: 0 });
  assert.equal(h.diagnostics().gain, 0);
  assert.equal((await h.runtime.command('resume')).state.status, 'playing');
  assert.equal(h.diagnostics().captureStarts, 2, 'resume opens a fresh bounded native session after pause flushes the old one');
  h.runtime.sourceEvent({ type: 'state', identity, status: 'ended', paused: true,
    currentTime: 30, duration: 30, completionId: 'done-1', generation: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  const ended = h.runtime.publicState();
  assert.equal(ended.status, 'ended');
  assert.equal(ended.bridge.active, false, 'Ended is published only after the exact native lane retires');
  assert.equal((await h.runtime.command('stop')).state.status, 'stopped');
});

test('direct runtime fails closed without an exact native endpoint or typed identity', async () => {
  const badOutput = harness('default');
  await assert.rejects(() => badOutput.runtime.command('play', {
    spotifyUri: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT'
  }), /exact native sd/);
  const normal = harness();
  await assert.rejects(() => normal.runtime.command('play', { spotifyUri: 'https://open.spotify.com/track/x' }),
    /track or episode URL\/URI/);
  assert.equal(MEDIA_RE.test('spotify:episode:4cOdK2wGLETKBW3PvgPWqT'), true);
});

test('trusted Spotify source returns its load receipt to Electron', async () => {
  const events = [];
  const controllerListeners = {};
  const context = vm.createContext({
    console,
    document: {
      getElementById(id) {
        return id === 'status' ? { textContent: '' } : { id };
      }
    },
    window: {
      eveSpotifyDirect: { event(value) { events.push(value); }, onCommand() {} }
    },
    setTimeout() {}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'pages', 'spotify-source.js'), 'utf8'), context,
    { filename: 'spotify-source.js' });
  context.window.onSpotifyIframeApiReady({
    createController(_element, options, callback) {
      assert.equal(options.url, 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT');
      assert.equal(options.uri, undefined, 'Electron uses the official URL, not Spotify URI');
      callback({ addListener(name, fn) { controllerListeners[name] = fn; }, loadEntity() {}, loadUri() {}, play() {}, pause() {}, resume() {}, seek() {} });
    }
  });
  const result = await context.window.__eveSpotifyCommand({ id: 'load-1', action: 'load', payload: {
    spotifyUri: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT', itemId: 'song-a', title: 'Test'
  } });
  assert.equal(result.ok, true);
  assert.equal(result.id, 'load-1');
  assert.equal(result.identity.spotifyUri, 'spotify:track:4cOdK2wGLETKBW3PvgPWqT');
  assert(events.some((value) => value.type === 'reply' && value.id === 'load-1' && value.ok));
  controllerListeners.playback_started();
  controllerListeners.playback_update({ data: { position: 29713, duration: 29713, isPaused: false } });
  const finalState = events.filter((value) => value.type === 'state').at(-1);
  assert.equal(finalState.status, 'ended', 'duration boundary completes even when Spotify leaves isPaused false');
  assert.match(finalState.completionId, /^1:/);
});

test('a fresh Play reloads repeated Spotify slots, while Resume does not', async () => {
  const h = harness();
  const identity = { spotifyUri: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT', itemId: 'song-a' };
  assert.equal((await h.runtime.command('play', identity)).ok, true);
  assert.equal((await h.runtime.command('play', identity)).ok, true);
  assert.equal(h.diagnostics().loads, 2, 'two queue slots reload the provider');
  await h.runtime.command('pause');
  await h.runtime.command('resume');
  assert.equal(h.diagnostics().loads, 2, 'Resume preserves the playing track');
  await h.runtime.command('stop');
});
