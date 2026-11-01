const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '../..');

class Track {
  constructor(settings = {}) { this.settings = settings; this.stopped = false; this.handlers = {}; }
  addEventListener(name, fn) { this.handlers[name] = fn; }
  getSettings() { return this.settings; }
  async applyConstraints() {}
  stop() { this.stopped = true; }
}
class Stream {
  constructor(tracks) { this.tracks = tracks; }
  getAudioTracks() { return this.tracks.slice(0, 1); }
  getTracks() { return this.tracks; }
}
class Node {
  constructor() { this.port = { onmessage: null, postMessage() {} }; Node.instances.push(this); }
  connect() { return this; }
  disconnect() {}
}
Node.instances = [];
class Context {
  constructor() { this.sampleRate = 48000; this.destination = {}; this.audioWorklet = { addModule: async () => true }; }
  async resume() {}
  createMediaStreamSource() { return new Node(); }
  createGain() { const node = new Node(); node.gain = { value: 1 }; return node; }
  async close() {}
}

const sent = [];
const window = {
  AudioContext: Context,
  EveAudioflixCaptureProcessorSrc: 'registerProcessor("audioflix-capture-processor",class{});',
  EveAudioflixState: { ensure: () => ({ outputVolume: 0.5 }) },
  EveAudioflixAudioBridge: { encodePcm: () => 'AQI=' },
  EveAudioflixNativeProviderCapture: {
    start: async () => ({ ok: true, sessionId: 'p:1', captureToken: 'secret', deviceId: 'sd:7', endpointLabel: 'CABLE', rendererRunning: true, sampleRate: 48000 }),
    send: async (_session, _audio, detail) => { sent.push(detail); return { ok: true, deviceId: 'sd:7', rendererRunning: true }; },
    stop: async () => ({ ok: true })
  },
  dispatchEvent() {}, setTimeout, clearTimeout, queueMicrotask
};
const context = { window, navigator: { mediaDevices: {} }, MediaStream: Stream, AudioWorkletNode: Node, CustomEvent: class {}, console, setTimeout, clearTimeout, queueMicrotask };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/modules/features/audioflix/audioflix.provider.capture.js'), 'utf8'), context);

(async () => {
  const track = new Track({ suppressLocalAudioPlayback: true });
  await window.EveAudioflixProviderCapture.startStream(new Stream([track]), { authorization: 'test', suppression: 'confirmed' });
  const runtimeNode = context.window.EveAudioflixProviderCapture;
  const worklet = Node.instances.find(node => typeof node.port.onmessage === 'function');
  assert(worklet, 'capture worklet was not connected');
  // Four 4096-sample blocks exceed the 260ms prebuffer at 48kHz.
  for (let i = 0; i < 4; i++) {
    const block = new Float32Array(4096); block.fill(0.2);
    worklet.port.onmessage({ data: block });
  }
  await new Promise(resolve => setTimeout(resolve, 20));
  const status = runtimeNode.getStatus();
  assert(status.nonzeroPcm && status.transport && status.renderer && sent.length > 0);
  assert.strictEqual(sent[0].gain, 0.5);
  await runtimeNode.stop('test');
  assert(track.stopped && !runtimeNode.getStatus().active);
  console.log('AUDIOFLIX_PROVIDER_CAPTURE_BROWSER_OK worklet=true bounded=true gain=true cleanup=true');
})().catch(error => { console.error(error); process.exitCode = 1; });
