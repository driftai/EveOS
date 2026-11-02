const WORKLET = String.raw`
class PianoPcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Float32Array(1024); this.used = 0; this.active = false;
    this.port.onmessage = event => { this.active = event.data?.active === true; }; }
  process(inputs) { const input = inputs[0]; if (!this.active || !input?.[0]) return true;
    const left = input[0], right = input[1];
    for (let i = 0; i < left.length; i += 1) { this.buffer[this.used++] = right ? (left[i] + right[i]) * 0.5 : left[i];
      if (this.used === this.buffer.length) { const block = this.buffer; this.buffer = new Float32Array(1024); this.used = 0;
        this.port.postMessage({ audio: block.buffer, capturedAtMs: Date.now() }, [block.buffer]); } }
    return true; }
}
registerProcessor('piano-pcm-capture', PianoPcmCapture);`;
let route = { requested: false, active: false }, router = null;
function apply() { if (!router) return; const now = router.context.currentTime;
  router.browser.gain.cancelScheduledValues(now); router.browser.gain.setTargetAtTime(route.requested ? 0 : 1, now, 0.008);
  router.node?.port?.postMessage({ active: route.active === true }); }
export function configurePianoPcm(next = {}) { route = { requested: next.requested === true, active: next.active === true,
  token: String(next.token || ''), generation: Number(next.generation || 0) }; apply(); }
export function createPianoOutputRouter(context, compressor) { const browser = context.createGain();
  compressor.connect(browser).connect(context.destination); router = { context, compressor, browser, node: null }; apply();
  router.ready = context.audioWorklet.addModule(`data:application/javascript;charset=utf-8,${encodeURIComponent(WORKLET)}`).then(() => {
    if (!router || router.context !== context) return;
    const node = new AudioWorkletNode(context, 'piano-pcm-capture'), silent = context.createGain(); silent.gain.value = 0;
    compressor.connect(node); node.connect(silent).connect(context.destination);
    node.port.onmessage = event => { const audio = event.data?.audio;
      if (route.active && audio instanceof ArrayBuffer) window.PianoEveOS?.postPcm?.({ audio,
        capturedAtMs: event.data.capturedAtMs, sampleRate: context.sampleRate, token: route.token, generation: route.generation }); };
    router.node = node; apply(); return true;
  }).catch(error => window.PianoEveOS?.reportPcmFailure?.(String(error?.message || error)));
  return router; }
export function pianoPcmReady() { return router?.ready || Promise.resolve(false); }
