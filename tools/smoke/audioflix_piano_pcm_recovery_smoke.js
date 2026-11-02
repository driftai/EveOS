'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'js/modules/features/audioflix/audioflix.piano.pcm.js'), 'utf8');

const events = [];
let sendCalls = 0, statusCalls = 0, starts = 0;
const selected = { nativeBridgeEnabled: true, nativeOutputId: 'sd:9', nativeOutputLabel: 'V-Banana-From-OBS' };
const native = {
  async start(detail) { starts += 1; return { ok: true, sessionId: `piano:${starts}`, captureToken: 'token',
    deviceId: detail.endpoint.deviceId, sampleRate: 48000, lane: 'piano-pcm', ownerId: detail.ownerId,
    generation: detail.generation, bridgeBase: 'http://127.0.0.1:8765' }; },
  async send() { sendCalls += 1; if (sendCalls === 1) { const error = new Error('Failed to fetch');
    error.eveCategory = 'bridge-unreachable'; error.eveRetryable = true; throw error; } return { ok: true }; },
  async status() { statusCalls += 1; return { ok: true }; },
  async stop() { return { ok: true }; }
};
const window = {
  EveAudioflixState: { getSnapshot: () => selected }, EveAudioflixNativeProviderCapture: native,
  EveAudioflixAudioBridge: { encodePcm: () => 'AAAA' },
  addEventListener() {}, dispatchEvent(event) { events.push(event); }
};
const context = vm.createContext({ window, console, Float32Array, ArrayBuffer, Date, Math,
  crypto: { randomUUID: () => 'fixture', getRandomValues: bytes => (bytes.fill(7), bytes) },
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
  setInterval: () => 1, clearInterval() {}, setTimeout: fn => (queueMicrotask(fn), 1), clearTimeout() {}, queueMicrotask });
vm.runInContext(source, context, { filename: 'audioflix.piano.pcm.js' });

(async () => {
  const target = { postMessage() {} };
  const route = await window.EveAudioflixPianoPcm.authorize(target, 'http://127.0.0.1:8771');
  assert.equal(route.active, true);
  const message = () => ({ source: target, origin: 'http://127.0.0.1:8771', data: {
    type: 'piano:eveos-pcm', token: route.token, generation: route.generation,
    audio: new Float32Array(1024).buffer, sampleRate: 44100, capturedAtMs: Date.now()
  }});
  assert.equal(window.EveAudioflixPianoPcm.accept(message()), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(statusCalls >= 1, 'temporary send failure checks the existing exact session before reopening');
  assert.equal(events.some(event => event.detail?.status === 'failed'), false, 'temporary failure does not latch the Piano route failed');
  assert.equal(window.EveAudioflixPianoPcm.metrics().recoveries, 1);
  assert.equal(window.EveAudioflixPianoPcm.accept(message()), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sendCalls, 2, 'fresh PCM continues after bounded recovery without replaying the uncertain block');
  console.log('AUDIOFLIX_PIANO_PCM_RECOVERY_OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
