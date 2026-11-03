'use strict';
// Trusted capture page: getDisplayMedia (granted by main to the source webContents only), measure it,
// and stream PCM through the main process to the existing EveOS renderer.
const out = document.getElementById('out');
const log = (line) => { out.textContent = `${new Date().toISOString().slice(11, 23)} ${line}\n` + out.textContent.slice(0, 6000); };
let stream = null, ctx = null, node = null, gain = 1, cfg = {}, captureId = null;
let pending = [], pendingLen = 0, blocks = 0, nonzeroBlocks = 0, startedAt = 0, firstSignalMs = null;
let win = { sumSq: 0, n: 0, peak: 0, g440: 0, g880: 0 };

function goertzel(x, hz, rate) {
  const k = 2 * Math.cos(2 * Math.PI * hz / rate); let s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i += 1) { const s0 = x[i] + k * s1 - s2; s2 = s1; s1 = s0; }
  return (s1 * s1 + s2 * s2 - k * s1 * s2) / (x.length * x.length);
}
const db = (v) => (v > 0 ? (10 * Math.log10(v)).toFixed(1) : '-inf');

function encode(samples) {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) { const s = Math.max(-1, Math.min(1, samples[i])); pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
  const bytes = new Uint8Array(pcm.buffer); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function onBlock(mono) {
  if (!captureId || !ctx) return;   // a retired capture never forwards a late block
  blocks += 1;
  let peak = 0, sq = 0;
  for (const v of mono) { sq += v * v; const a = Math.abs(v); if (a > peak) peak = a; }
  if (peak > 1e-4) { nonzeroBlocks += 1; if (firstSignalMs === null) firstSignalMs = Math.round(performance.now() - startedAt); }
  win.sumSq += sq; win.n += mono.length; win.peak = Math.max(win.peak, peak);
  pending.push(mono); pendingLen += mono.length;
  if (pendingLen >= ctx.sampleRate / 10) {       // ~100 ms per bridge chunk
    const chunk = new Float32Array(pendingLen); let o = 0;
    for (const p of pending) { chunk.set(p, o); o += p.length; }
    pending = []; pendingLen = 0;
    win.g440 += goertzel(chunk, 440, ctx.sampleRate); win.g880 += goertzel(chunk, 880, ctx.sampleRate);
    window.spike.pcm(captureId, encode(chunk), ctx.sampleRate, gain);
  }
}

setInterval(() => {
  if (!ctx || !win.n) return;
  const s = { rate: ctx.sampleRate, rmsDb: db(win.sumSq / win.n), peak: win.peak.toFixed(4), gain, blocks, nonzeroBlocks,
    firstSignalMs, tone440Db: db(win.g440), tone880Db: db(win.g880), track: stream?.getAudioTracks()[0]?.readyState || 'none' };
  window.spike.stats(s);
  log(`rms ${s.rmsDb} dBFS peak ${s.peak} | 440Hz ${s.tone440Db} dB 880Hz(decoy) ${s.tone880Db} dB | gain ${gain} | ${s.track}`);
  win = { sumSq: 0, n: 0, peak: 0, g440: 0, g880: 0 };
}, 1000);

async function start() {
  if (stream) return log('already capturing');
  startedAt = performance.now(); firstSignalMs = null; blocks = 0; nonzeroBlocks = 0;
  try {
    // A picker appearing here is a FAIL: main must grant the source webContents directly.
    // Music must arrive untouched: voice processing (AEC/NS/AGC) defaults ON for captured audio.
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 } });
  } catch (err) { window.spike.event({ type: 'getDisplayMedia-failed', error: String(err) }); return log(`getDisplayMedia FAILED: ${err}`); }
  stream.getVideoTracks().forEach((t) => t.stop());   // audio only is needed
  const track = stream.getAudioTracks()[0];
  if (!track) { window.spike.event({ type: 'no-audio-track' }); return log('FAIL: granted stream has no audio track'); }
  const st = track.getSettings();
  if (st.echoCancellation || st.noiseSuppression || st.autoGainControl) {
    window.spike.event({ type: 'voice-processing-still-on', settings: st }); log('WARN: voice processing still on; levels are not trustworthy');
  }
  captureId = crypto.randomUUID();
  const myId = captureId;
  track.onended = () => { if (captureId !== myId) return; window.spike.event({ type: 'track-ended', captureId: myId }); log('audio track ended: releasing capture'); stop(); };
  ctx = new AudioContext({ sampleRate: 48000 });
  await ctx.audioWorklet.addModule('capture-worklet.js');
  node = new AudioWorkletNode(ctx, 'spike-tap');
  node.port.onmessage = (e) => onBlock(e.data);
  ctx.createMediaStreamSource(stream).connect(node);   // NOT connected to destination: no local monitor
  // Announce before the first block so main opens this generation's native session first.
  window.spike.event({ type: 'capture-started', captureId, label: track.label, settings: track.getSettings() });
  log(`capture started: ${track.label || '(unlabeled)'} @ ${ctx.sampleRate} Hz`);
}

async function stop() {
  if (!stream && !ctx) return;
  const endedId = captureId; captureId = null;
  // Tell main first: it retires the generation and flushes the native lane immediately.
  window.spike.event({ type: 'capture-stopped', captureId: endedId, blocks, nonzeroBlocks });
  stream?.getTracks().forEach((t) => t.stop()); stream = null;
  node?.disconnect(); node = null; await ctx?.close(); ctx = null; pending = []; pendingLen = 0;
  log('capture stopped');
}

async function control(value = {}) {
  const action = String(value.action || '');
  if (action === 'start') { await start(); return { ok: !!stream && !!ctx }; }
  if (action === 'stop') { await stop(); return { ok: true }; }
  if (action === 'gain') { gain = Math.max(0, Math.min(1, Number(value.gain) || 0)); return { ok: true, gain }; }
  return { ok: false, reason: 'Unsupported capture action.' };
}

window.__eveCaptureControl = control;
window.spike.onControl((value) => { control(value).catch((error) => window.spike.event({
  type: 'capture-control-failed', error: String(error?.message || error)
})); });

document.getElementById('start').onclick = start;
document.getElementById('stop').onclick = stop;
document.querySelectorAll('[data-gain]').forEach((b) => (b.onclick = () => { gain = Number(b.dataset.gain); window.spike.event({ type: 'gain', gain }); log(`gain -> ${gain}`); }));
document.querySelectorAll('[data-src]').forEach((b) => (b.onclick = () => window.spike.source(b.dataset.src)));
document.getElementById('metrics').onclick = async () => log(JSON.stringify(await window.spike.metrics()));
window.spike.onSourceGone(() => { log('source destroyed: PCM must stop now'); window.spike.event({ type: 'source-gone-seen', track: stream?.getAudioTracks()[0]?.readyState }); });
window.spike.config().then((c) => { cfg = c || {}; document.getElementById('cfg').textContent =
  `Electron ${cfg.electron} | source=${cfg.source} | device=${cfg.deviceId || '(capture only)'} | localEcho=${cfg.localEcho} | decoy=${cfg.decoy}`; });
