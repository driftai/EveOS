'use strict';
// Production command owner for Electron Direct Embed. Commands arrive only over the server-owned,
// authenticated loopback socket; Spotify web content receives the official player API and nothing else.
const readline = require('node:readline');
const crypto = require('node:crypto');
const net = require('node:net');

const PREFIX = 'EVEOS_SPOTIFY_DIRECT ';
const MEDIA_RE = /^spotify:(track|episode):([A-Za-z0-9]{22})$/;
const MAX_LINE = 32 * 1024;

function createRuntime(deps) {
  const { app, cfg, note, bridge, ipcMain, getSourceWin, getCaptureWin, fromSource } = deps;
  const output = deps.output || process.stdout;
  let controlSocket = null, controlReady = false;
  const queuedOutput = [];
  const sourceReplies = new Map(), stateWaiters = new Set();
  let sourceReady = false, captureReady = false, captureRetirement = null, started = false, current = null;
  let state = { status: 'starting', currentTime: 0, duration: 0, paused: true, generation: 0 };

  function emit(value) {
    const line = JSON.stringify(value);
    if (cfg.controlPort > 0) {
      if (controlReady && controlSocket) controlSocket.write(`${line}\n`);
      else queuedOutput.push(line);
    } else output.write(`${PREFIX}${line}\n`);
  }
  function publicState() {
    return { ...state, identity: current, sourceReady, captureReady, bridge: bridge.totals(),
      pid: process.pid, electron: process.versions.electron, deviceId: cfg.deviceId };
  }
  function settleWaiters() {
    for (const waiter of [...stateWaiters]) {
      if (!waiter.test(state)) continue;
      stateWaiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(publicState());
    }
  }
  function setState(patch) {
    state = { ...state, ...patch };
    emit({ type: 'state', state: publicState() });
    settleWaiters();
  }
  function waitState(test, timeoutMs, reason) {
    if (test(state)) return Promise.resolve(publicState());
    return new Promise((resolve, reject) => {
      const waiter = { test, resolve, reject, timer: 0 };
      waiter.timer = setTimeout(() => { stateWaiters.delete(waiter); reject(new Error(reason)); }, timeoutMs);
      stateWaiters.add(waiter);
    });
  }
  function trustedSource() {
    const win = getSourceWin();
    if (!win || win.isDestroyed() || !fromSource(win.webContents)) throw new Error('Trusted Spotify source is unavailable.');
    return win;
  }
  function sourceCommand(action, payload = {}, timeoutMs = 8000) {
    const id = crypto.randomUUID(), win = trustedSource();
    const code = `window.__eveSpotifyCommand(${JSON.stringify({ id, action, payload })})`;
    let timer;
    return Promise.race([
      win.webContents.executeJavaScript(code).then((result) => {
        if (!result?.ok) throw new Error(result?.reason || `Spotify ${action} failed.`);
        return result;
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Spotify ${action} timed out.`)), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
  }
  async function captureControl(action, payload = {}, gesture = false) {
    const win = getCaptureWin();
    if (!win || win.isDestroyed()) throw new Error('Trusted capture renderer is unavailable.');
    const code = `window.__eveCaptureControl(${JSON.stringify({ action, ...payload })})`;
    const result = await win.webContents.executeJavaScript(code, gesture);
    if (!result?.ok) throw new Error(result?.reason || `Capture ${action} failed.`);
    return result;
  }
  async function ensureCapture() {
    if (captureReady && bridge.totals().ready) return;
    await captureControl('start', {}, true);
    await waitState(() => captureReady && bridge.totals().ready, 10000,
      bridge.totals().lastError || 'Native Electron capture did not become ready.');
  }
  async function retireCapture() {
    if (captureRetirement) return captureRetirement;
    if (!captureReady && !bridge.totals().active) return;
    captureReady = false;
    captureRetirement = captureControl('stop').finally(() => { captureRetirement = null; });
    return captureRetirement;
  }
  function validatePlay(payload) {
    const identity = String(payload.spotifyUri || '');
    const match = MEDIA_RE.exec(identity);
    if (!match) throw new Error('Electron Direct Embed requires a Spotify track or episode identity.');
    if (!/^sd:\d+$/.test(String(cfg.deviceId || ''))) throw new Error('Electron Direct Embed requires an exact native sd:* output.');
    return { spotifyUri: identity, spotifyId: match[2], mediaType: match[1],
      itemId: String(payload.itemId || ''), title: String(payload.title || ''),
      duration: Math.max(0, Number(payload.duration || 0)) };
  }
  async function command(action, payload = {}) {
    note('runtime-command', { action });
    if (action === 'status') return { ok: true, state: publicState() };
    if (action === 'show') { trustedSource().show(); return { ok: true, state: publicState() }; }
    if (action === 'hide') { trustedSource().hide(); return { ok: true, state: publicState() }; }
    if (action === 'shutdown') { await command('stop'); setTimeout(() => app.quit(), 25); return { ok: true, state: publicState() }; }
    if (action === 'play') {
      const identity = validatePlay(payload);
      await waitState(() => sourceReady, 45000, 'Official Spotify IFrame controller did not become ready.');
      // Every explicit Play is a fresh AudioFlix intent, even for repeated URI/item slots.
      // Resume is separate and must not reload the official controller.
      current = identity;
      await sourceCommand('load', identity, 20000);
      // The official iframe must exist before targeted getDisplayMedia can expose its audio track.
      // Capture still starts before Play, so source audio never escapes the native route.
      await ensureCapture();
      await captureControl('gain', { gain: Math.max(0, Math.min(1, Number(payload.gain ?? 1))) });
      setState({ status: 'starting', currentTime: 0, duration: identity.duration, paused: true });
      await sourceCommand('play');
      await waitState((value) => value.status === 'playing', 20000, 'Spotify Direct Embed did not begin playback.');
      return { ok: true, state: publicState() };
    }
    if (action === 'pause') { await sourceCommand('pause'); await retireCapture(); }
    else if (action === 'resume') {
      await ensureCapture();
      await sourceCommand('resume');
      await waitState((value) => value.status === 'playing', 10000, 'Spotify Direct Embed did not resume playback.');
    }
    else if (action === 'seek') await sourceCommand('seek', { seconds: Math.max(0, Number(payload.seconds || 0)) });
    else if (action === 'volume') await captureControl('gain', { gain: Math.max(0, Math.min(1, Number(payload.gain) || 0)) });
    else if (action === 'stop') {
      if (sourceReady) await sourceCommand('stop').catch(() => null);
      await captureControl('stop').catch(() => null);
      captureReady = false; current = null;
      setState({ status: 'stopped', currentTime: 0, duration: 0, paused: true, completionId: '' });
    } else throw new Error('Unsupported Electron Direct Embed command.');
    return { ok: true, state: publicState() };
  }
  function sourceEvent(value = {}) {
    const type = String(value.type || '');
    if (type === 'ready') { sourceReady = true; setState({ status: 'ready' }); return; }
    if (type === 'reply') {
      const pending = sourceReplies.get(String(value.id || ''));
      if (!pending) return;
      sourceReplies.delete(String(value.id)); clearTimeout(pending.timer);
      return value.ok ? pending.resolve(value) : pending.reject(new Error(value.reason || 'Spotify command failed.'));
    }
    if (type === 'state') {
      const identity = value.identity || null;
      if (current && identity?.spotifyUri && identity.spotifyUri !== current.spotifyUri) return;
      if (identity) current = { ...current, ...identity };
      const patch = { ...(value || {}), type: undefined, identity: undefined };
      if (value.status === 'ended') {
        retireCapture().then(() => setState(patch), (error) => setState({ ...patch,
          captureError: String(error?.message || error) }));
        return;
      }
      setState(patch);
    }
  }
  function captureEvent(type, detail, result) {
    if (type === 'capture-started') {
      captureReady = result?.ok === true;
      setState(captureReady ? { captureError: '' } : { status: 'error', paused: true,
        captureError: result?.reason || 'Native capture failed.' });
    } else if (['capture-stopped', 'track-ended', 'capture-renderer-gone'].includes(type)) {
      captureReady = false;
      if (state.status === 'playing' && !captureRetirement) {
        setState({ status: 'error', paused: true, captureError: `Capture stopped: ${type}` });
      }
    }
  }
  function handleLine(line) {
    if (!line || line.length > MAX_LINE) return emit({ type: 'reply', ok: false, reason: 'Invalid command size.' });
    let request;
    try { request = JSON.parse(line); } catch { return emit({ type: 'reply', ok: false, reason: 'Invalid command JSON.' }); }
    const id = String(request.id || '');
    Promise.resolve().then(() => command(String(request.action || ''), request.payload || {}))
      .then((result) => emit({ type: 'reply', id, ...result }),
        (error) => emit({ type: 'reply', id, ok: false, reason: String(error?.message || error), state: publicState() }));
  }
  function install() {
    if (started) return; started = true;
    ipcMain.on('eve-spotify-direct:event', (event, value) => {
      if (!fromSource(event.sender, event.senderFrame)) return;
      if (value?.type === 'diagnostic' || value?.type === 'controller-created') {
        note('runtime-source', { type: value.type, stage: value.stage || '', action: value.action || '',
          reason: String(value.reason || '').slice(0, 180) });
      }
      sourceEvent(value);
    });
    if (cfg.controlPort > 0) {
      controlSocket = net.createConnection({ host: '127.0.0.1', port: cfg.controlPort }, () => {
        controlSocket.write(`${JSON.stringify({ token: cfg.controlToken })}\n`);
        controlReady = true;
        while (queuedOutput.length) controlSocket.write(`${queuedOutput.shift()}\n`);
      });
      readline.createInterface({ input: controlSocket, crlfDelay: Infinity }).on('line', handleLine);
      controlSocket.on('error', () => app.quit());
      controlSocket.on('close', () => app.quit());
    } else readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', handleLine);
    if (cfg.ownerPid > 0) setInterval(() => {
      try { process.kill(cfg.ownerPid, 0); } catch { app.quit(); }
    }, 2000).unref();
    note('runtime-installed', { deviceId: cfg.deviceId });
  }
  function hostReady() { emit({ type: 'ready', ok: true, state: publicState() }); }
  return { install, hostReady, sourceEvent, captureEvent, command, publicState };
}

module.exports = { createRuntime, PREFIX, MEDIA_RE };
