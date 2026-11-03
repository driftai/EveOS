'use strict';
// Main-process-only transport to the existing EveOS PCM renderer (/api/audioflix/play-pcm).
// Renderers never see the bridge URL. Node fetch sends no Origin header, which _can_control allows
// from 127.0.0.1 only. Gain is applied by the existing renderer (payload.gain), not by the spike.
let inFlight = 0, sent = 0, failed = 0, stale = 0, lastFailure = '';
const streamId = `electron-spike-${process.pid}-${Date.now()}`;

async function post(cfg, route, body) {
  const res = await fetch(`${cfg.bridge}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(1500) });
  return res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` }));
}

function forward(cfg, msg, note) {
  if (!cfg.deviceId || !msg || typeof msg.audio !== 'string') return;
  if (inFlight > 4) { stale += 1; return; }  // bounded backlog; never queue unbounded audio
  inFlight += 1;
  const gain = Math.max(0, Math.min(1, Number(msg.gain)));
  post(cfg, '/api/audioflix/play-pcm', { audio: msg.audio, deviceId: cfg.deviceId, sampleRate: msg.sampleRate,
    channels: 1, streamId, gain, strictDevice: true, sentAtMs: Date.now(), maxAgeMs: 1200 })
    .then((r) => { if (r?.ok) sent += 1; else { failed += 1; if (r?.message !== lastFailure) note('bridge-reject', { message: r?.message }); lastFailure = r?.message || ''; } })
    .catch((err) => { failed += 1; if (String(err) !== lastFailure) note('bridge-error', { error: String(err) }); lastFailure = String(err); })
    .finally(() => { inFlight -= 1; });
}

async function stop(cfg, note) {
  note('bridge-totals', { sent, failed, stale });
  if (!cfg.deviceId) return;
  try { note('bridge-stop', await post(cfg, '/api/audioflix/stop-stream', { itemId: streamId, deviceId: cfg.deviceId })); }
  catch (err) { note('bridge-stop-error', { error: String(err) }); }
}

module.exports = { forward, stop, totals: () => ({ sent, failed, stale }) };
