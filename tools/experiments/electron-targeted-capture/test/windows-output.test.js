'use strict';
// Run against the patched repo's direct-runtime.js; no Electron or Windows required.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime } = require('../direct-runtime');

test('Windows output never enters capture path, but remains a distinct Direct policy', async () => {
  let runtime, captures = 0, loaded = null;
  const muted = [];
  const source = { isDestroyed: () => false, show() {}, hide() {}, webContents: {
    mainFrame: { url: 'file:///spotify-source.html' },
    async executeJavaScript(code) {
      const req = JSON.parse(/__eveSpotifyCommand\((.*)\)$/.exec(code)[1]);
      if (req.action === 'load') loaded = req.payload;
      if (req.action === 'play' || req.action === 'resume') {
        runtime.sourceEvent({ type: 'state', identity: loaded, status: 'playing', paused: false,
          currentTime: 0, duration: 212 });
      }
      if (req.action === 'pause') runtime.sourceEvent({ type: 'state', identity: loaded,
        status: 'paused', paused: true, currentTime: 2, duration: 212 });
      return { ok: true };
    }
  } };
  const capture = { isDestroyed: () => false, webContents: { executeJavaScript() {
    captures += 1;
    throw new Error('Capture must never run in Windows mode');
  } } };
  runtime = createRuntime({ app: { quit() {} }, cfg: { deviceId: 'sd:7', outputMode: 'windows', ownerPid: 0 },
    note() {}, bridge: { totals: () => ({ active: false, ready: false }) },
    ipcMain: { on() {} }, getSourceWin: () => source, getCaptureWin: () => capture,
    fromSource: () => true, setSourceMuted: (value) => muted.push(value), output: { write() {} } });
  runtime.sourceEvent({ type: 'ready' });
  const identity = { spotifyUri: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT', itemId: 'test' };
  const started = await runtime.command('play', { ...identity, gain: .7 });
  assert.equal(started.ok, true);
  assert.equal(started.state.status, 'playing');
  assert.equal(started.state.outputMode, 'windows');
  assert.equal(started.state.outputMuted, true, 'provider stays muted until the server verifies routing');
  assert.deepEqual(muted, [true]);
  const ready = await runtime.command('route-ready');
  assert.equal(ready.state.outputMuted, false);
  assert.deepEqual(muted, [true, false]);
  assert.equal(captures, 0);
  await runtime.command('volume', { gain: .4 });
  assert.equal(runtime.publicState().gain, .4);
  assert.equal((await runtime.command('pause')).state.status, 'paused');
  assert.equal((await runtime.command('resume')).state.status, 'playing');
  await runtime.command('stop');
  assert.equal(captures, 0);
});
