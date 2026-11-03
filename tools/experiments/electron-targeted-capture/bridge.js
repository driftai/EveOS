'use strict';
// Main-process-only transport to the existing EveOS native renderer, through the authenticated
// provider-capture session API on its own "electron-capture" lane. Renderers never see the bridge
// URL, the session token or the install credential. Gain is applied by the existing renderer.
//
// Ownership: one session per capture generation. Chunks are sent strictly one at a time (ordered),
// at most MAX_PENDING wait behind the one in flight (oldest dropped as stale), and a retired
// generation can never send again: end() closes it, waits for the in-flight chunk, then stops
// exactly that session, so Stop cannot be undone by a late chunk.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LANE = 'electron-capture';
const MAX_PENDING = 4;
const MAX_REJECT_EVENTS = 200;
const FILE_AUTH_PREFIX = 'window.__EveOSProviderFileAuth = ';

function readInstallCredential(eveosRoot) {
  const raw = fs.readFileSync(path.join(eveosRoot, 'data', 'runtime', 'audioflix-provider-file-auth.js'), 'utf8');
  // Python's text-mode writer uses CRLF on Windows and LF elsewhere. Do not weaken
  // the envelope or accept arbitrary JavaScript: this is a single JSON string assignment.
  const match = /^window\.__EveOSProviderFileAuth = (".*");\r?\n$/.exec(raw);
  if (!match) throw new Error('EveOS provider credential is invalid');
  let key;
  try { key = JSON.parse(match[1]); } catch { throw new Error('EveOS provider credential is invalid'); }
  if (typeof key !== 'string' || key.length < 40) throw new Error('EveOS provider credential is invalid');
  return key;
}

function createBridge({ cfg, note, fetchImpl = globalThis.fetch, readKey = readInstallCredential }) {
  const ownerId = `electron-host:${crypto.randomUUID()}`;
  const totals = { sent: 0, failed: 0, stale: 0, retired: 0, sessions: 0, rejectEvents: 0 };
  let generation = 0;
  let current = null;   // { captureId, generation, session, queue, closed, starting, pump }

  async function post(route, body, extraHeaders = {}) {
    const res = await fetchImpl(`${cfg.bridge}/api/audioflix/provider-capture/${route}`, {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body), signal: AbortSignal.timeout(1500) });
    const json = await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` }));
    if (!json || json.ok !== true) throw new Error(String(json?.message || `HTTP ${res.status}`));
    return json;
  }

  const auth = (c) => ({ sessionId: c.session.sessionId, captureToken: c.session.captureToken,
    lane: LANE, ownerId, generation: c.generation });

  function reject(kind, c, err) {
    totals.failed += 1;
    if (totals.rejectEvents >= MAX_REJECT_EVENTS) return;
    totals.rejectEvents += 1;
    note(kind, { generation: c.generation, message: String(err?.message || err).slice(0, 200) });
  }

  async function stopSession(c, reason) {
    if (!c.session || c.stopped) return;
    c.stopped = true;
    try {
      const r = await post('stop', auth(c));
      note('bridge-session-stopped', { generation: c.generation, reason, chunks: r.chunks, nonzeroChunks: r.nonzeroChunks });
    } catch (err) { note('bridge-stop-error', { generation: c.generation, reason, message: String(err.message || err) }); }
  }

  async function pump(c) {
    while (c === current && !c.closed && c.session && c.queue.length) {
      const item = c.queue.shift();
      try {
        const r = await post('chunk', { ...auth(c), audio: item.audio, channels: 1, sampleRate: item.sampleRate,
          gain: item.gain, sentAtMs: item.sentAtMs, maxAgeMs: 1200 });
        totals.sent += 1;
        c.native = { dropped: r.dropped, underruns: r.underruns, backlogFrames: r.backlogFrames };
      } catch (err) { reject('bridge-reject', c, err); }
    }
  }

  function kick(c) {
    if (c.pump) return;
    c.pump = pump(c).finally(() => { c.pump = null; if (c === current && !c.closed && c.queue.length) kick(c); });
  }

  // Synchronous takeover: the new generation is current before any await, so a Stop that races
  // a Start always finds (and retires) the generation it means.
  function begin(captureId) {
    if (!cfg.deviceId) return Promise.resolve();
    const previous = current ? end('superseded') : Promise.resolve();
    generation += 1;
    const c = { captureId: String(captureId), generation, session: null, queue: [], closed: false, pump: null };
    current = c;
    c.starting = previous.then(async () => {
      if (c.closed) return;
      try {
        const session = await post('start', { deviceId: cfg.deviceId, sampleRate: 48000, channels: 1, lane: LANE,
          source: `electron-${cfg.source}`, ownerId, generation: c.generation },
          { 'X-EveOS-Provider-Capture': 'v1', 'X-EveOS-Provider-File-Auth': readKey(cfg.eveosRoot) });
        c.session = session;
        totals.sessions += 1;
        note('bridge-session-started', { generation: c.generation, lane: session.lane, deviceId: session.deviceId });
        if (c.closed || c !== current) return stopSession(c, 'retired-while-starting');
        kick(c);
      } catch (err) {
        c.startError = String(err?.message || err).slice(0, 200);
        reject('bridge-start-failed', c, err);
      }
      return c.session ? { ok: true, lane: LANE, generation: c.generation, deviceId: c.session.deviceId }
        : { ok: false, reason: c.startError || 'Native Electron capture session did not start.' };
    });
    return c.starting;
  }

  function push(captureId, msg) {
    const c = current;
    if (!c || c.closed || c.captureId !== String(captureId)) { totals.retired += 1; return; }
    if (!msg || typeof msg.audio !== 'string' || !msg.audio) return;
    if (c.queue.length >= MAX_PENDING) { c.queue.shift(); totals.stale += 1; }
    c.queue.push({ audio: msg.audio, sampleRate: Number(msg.sampleRate) || 48000,
      gain: Math.max(0, Math.min(1, Number(msg.gain))), sentAtMs: Date.now() });
    if (c.session) kick(c);
  }

  async function end(reason, captureId) {
    const c = current;
    if (!c || (captureId !== undefined && c.captureId !== String(captureId))) return;
    c.closed = true; current = null; totals.stale += c.queue.length; c.queue.length = 0;
    const settle = Promise.all([c.starting, c.pump].filter(Boolean));
    await Promise.race([settle, new Promise((r) => setTimeout(r, 2000))]);
    await stopSession(c, reason);
    note('bridge-totals', { generation: c.generation, reason, ...totals, native: c.native || null });
  }

  return { begin, push, end, ownerId, lane: LANE,
    totals: () => ({ ...totals, generation, active: !!current, ready: !!current?.session,
      lastError: current?.startError || '' }) };
}

module.exports = { createBridge, readInstallCredential, LANE, MAX_PENDING };
