'use strict';
// Production command owner for Electron Direct Embed. Commands arrive only over the server-owned,
// authenticated loopback socket; Spotify web content receives the official player API and nothing else.
const readline = require('node:readline');
const crypto = require('node:crypto');
const net = require('node:net');

const PREFIX = 'EVEOS_SPOTIFY_DIRECT ';
const MEDIA_RE = /^spotify:(track|episode):([A-Za-z0-9]{22})$/;
const SPOTIFY_URL_RE = /^https:\/\/open\.spotify\.com\/(?:embed\/)?(track|episode)\/([A-Za-z0-9]{22})\/?$/;
function normalizeSpotifyInput(payload = {}) {
  const fromUri = MEDIA_RE.exec(String(payload.spotifyUri || ''));
  const fromUrl = SPOTIFY_URL_RE.exec(String(payload.spotifyUrl || ''));
  if (!fromUri && !fromUrl) throw new Error('Electron Direct requires an exact Spotify track or episode URL/URI.');
  if (payload.spotifyUrl && !fromUrl) throw new Error('Untrusted Spotify URL rejected.');
  if (payload.spotifyUri && !fromUri) throw new Error('Untrusted Spotify URI rejected.');
  if (fromUri && fromUrl && (fromUri[1] !== fromUrl[1] || fromUri[2] !== fromUrl[2])) {
    throw new Error('Spotify URL does not match the typed media identity.');
  }
  const [, mediaType, spotifyId] = fromUrl || fromUri;
  if (payload.mediaType && String(payload.mediaType) !== mediaType) throw new Error('Spotify media type mismatch.');
  if (payload.spotifyId && String(payload.spotifyId) !== spotifyId) throw new Error('Spotify media ID mismatch.');
  return { mediaType, spotifyId, spotifyUri: `spotify:${mediaType}:${spotifyId}`,
    spotifyUrl: `https://open.spotify.com/${mediaType}/${spotifyId}` };
}
const MAX_LINE = 32 * 1024;

function createRuntime(deps) {
  const { app, cfg, note, bridge, ipcMain, getSourceWin, getCaptureWin, fromSource } = deps;
  const setSourceMuted = typeof deps.setSourceMuted === 'function' ? deps.setSourceMuted : () => {};
  const output = deps.output || process.stdout;
  const windowsOutput = cfg.outputMode === 'windows';
  let controlSocket = null, controlReady = false;
  const queuedOutput = [];
  const sourceReplies = new Map(), stateWaiters = new Set();
  let handoffResolve, handoffSettled = false;
  const handoffPromise = new Promise((resolve) => { handoffResolve = resolve; });
  let sourceReady = false, captureReady = false, captureRetirement = null, started = false, current = null;
  let outputMuted = windowsOutput;
  let state = { status: 'starting', currentTime: 0, duration: 0, paused: true, generation: 0 };
  let terminalFailure = false, licenseFailures = 0, licenseFailureTime = 0;
  let progressAt = 0, progressPosition = 0, activeSince = 0, advancedBeyondPreview = false;
  function failPlayback(reason) {
    if (terminalFailure || !current) return;
    terminalFailure = true;
    if (windowsOutput) { setSourceMuted(true); outputMuted = true; }
    else void retireCapture().catch(() => null);
    setState({ status: 'error', paused: true, playbackError: reason, outputMuted });
    note('spotify-playback-rejected', { reason });
  }
  function onLicenseResponse(statusCode, now = Date.now()) {
    if (!current || terminalFailure || statusCode < 400) return;
    if (now - licenseFailureTime > 20000) licenseFailures = 0;
    licenseFailureTime = now; licenseFailures += 1;
    if (licenseFailures >= 2) failPlayback(`Spotify Widevine audio license failed (HTTP ${statusCode}). Full track is unavailable in this Electron session.`);
  }
  function observeProgress(now = Date.now()) {
    if (terminalFailure || !current || state.status !== 'playing') return;
    const actual = Number(state.currentTime || 0), expected = Number(current.duration || 0);
    if (expected >= 60 && actual >= 35 && !advancedBeyondPreview) {
      advancedBeyondPreview = true; setState({ advancedBeyondPreview: true });
    }
    if (actual > progressPosition + 0.3 || actual < progressPosition - 1.5) {
      progressPosition = actual; progressAt = now;
    } else if (activeSince && now - activeSince >= 12000 && now - progressAt >= 10000) {
      failPlayback('Spotify Embed playback position stalled. Full-track playback was not established.');
    }
  }
  const progressMonitor = setInterval(() => observeProgress(), 2000);
  progressMonitor.unref?.();

  function emit(value) {
    const line = JSON.stringify(value);
    if (cfg.controlPort > 0) {
      if (controlReady && controlSocket) controlSocket.write(`${line}\n`);
      else queuedOutput.push(line);
    } else output.write(`${PREFIX}${line}\n`);
  }
  function publicState() {
    return { ...state, identity: current, sourceReady, captureReady, bridge: bridge.totals(),
      pid: process.pid, electron: process.versions.electron, deviceId: cfg.deviceId,
      outputMode: windowsOutput ? 'windows' : 'capture', outputMuted };
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
      win.webContents.executeJavaScript(code, action === 'play' || action === 'resume').then((result) => {
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
    const media = normalizeSpotifyInput(payload);
    if (!/^sd:\d+$/.test(String(cfg.deviceId || ''))) throw new Error('Electron Direct Embed requires an exact native sd:* output.');
    return { ...media,
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
      terminalFailure = false; licenseFailures = 0; licenseFailureTime = 0;
      activeSince = Date.now(); progressAt = activeSince; progressPosition = 0; advancedBeyondPreview = false;
      if (windowsOutput) { setSourceMuted(true); outputMuted = true; }
      // New explicit Play owns a new result. Do not carry yesterday's DRM failure
      // into a fresh attempt as a misleading ready+error combination.
      setState({ status: 'starting', currentTime: 0, duration: identity.duration,
        paused: true, playbackError: '', completionId: '',
        advancedBeyondPreview: false, outputMuted });
      await sourceCommand('load', identity, 20000);
      // The official iframe must exist before targeted getDisplayMedia can expose its audio track.
      // Native PCM mode still requires capture. Windows mode routes the application
      // BEFORE Play and never starts protected-source capture.
      if (!windowsOutput) {
        await ensureCapture();
        await captureControl('gain', { gain: Math.max(0, Math.min(1, Number(payload.gain ?? 1))) });
      }
      setState({ status: 'starting', currentTime: 0, duration: identity.duration, paused: true });
      await sourceCommand('play');
      await waitState((value) => value.status === 'playing' || value.status === 'error', 20000,
        'Spotify Direct Embed did not begin playback.');
      if (terminalFailure || state.status === 'error') throw new Error(state.playbackError || 'Spotify Embed playback failed.');
      return { ok: true, state: publicState() };
    }
    if (action === 'route-ready') {
      if (!windowsOutput) throw new Error('Route readiness applies only to Windows output.');
      if (terminalFailure) throw new Error(state.playbackError || 'Spotify full-track playback failed.');
      setSourceMuted(false); outputMuted = false; setState({ outputMuted: false });
    } else if (action === 'pause') { await sourceCommand('pause'); if (!windowsOutput) await retireCapture(); }
    else if (action === 'resume') {
      if (terminalFailure) throw new Error(state.playbackError || 'Spotify preview/DRM failure; select Play to retry.');
      activeSince = Date.now(); progressAt = activeSince; progressPosition = Number(state.currentTime || 0);
      if (windowsOutput) { setSourceMuted(true); outputMuted = true; }
      else await ensureCapture();
      await sourceCommand('resume');
      await waitState((value) => value.status === 'playing', 10000, 'Spotify Direct Embed did not resume playback.');
    }
    else if (action === 'seek') await sourceCommand('seek', { seconds: Math.max(0, Number(payload.seconds || 0)) });
    else if (action === 'volume') {
      const gain = Math.max(0, Math.min(1, Number(payload.gain) || 0));
      if (windowsOutput) setState({ gain });
      else await captureControl('gain', { gain });
    }
    else if (action === 'stop') {
      if (sourceReady) await sourceCommand('stop').catch(() => null);
      if (!windowsOutput) await captureControl('stop').catch(() => null);
      else { setSourceMuted(true); outputMuted = true; }
      captureReady = false; current = null; terminalFailure = false;
      progressAt = 0; activeSince = 0; licenseFailures = 0; advancedBeyondPreview = false;
      setState({ status: 'stopped', currentTime: 0, duration: 0, paused: true, playbackError: '', advancedBeyondPreview: false,
        completionId: '', outputMuted });
    } else throw new Error('Unsupported Electron Direct Embed command.');
    return { ok: true, state: publicState() };
  }
  function sourceEvent(value = {}) {
    const type = String(value.type || '');
    if (type === 'ready') { sourceReady = true; if (!terminalFailure) setState({ status: 'ready' }); return; }
    if (type === 'reply') {
      const pending = sourceReplies.get(String(value.id || ''));
      if (!pending) return;
      sourceReplies.delete(String(value.id)); clearTimeout(pending.timer);
      return value.ok ? pending.resolve(value) : pending.reject(new Error(value.reason || 'Spotify command failed.'));
    }
    if (type === 'state') {
      const identity = value.identity || null;
      if (current && identity?.spotifyUri && identity.spotifyUri !== current.spotifyUri) return;
      if (terminalFailure) return;
      if (identity) current = { ...current, ...identity };
      const patch = { ...(value || {}), type: undefined, identity: undefined };
      // A 30-second preview is not full playback, regardless of the item metadata.
      const expected = Number(current?.duration || 0), reported = Number(value.duration || 0);
      if (current && value.status === 'playing' && expected >= 60 && reported > 0 && reported <= 35
          && expected - reported > 20) {
        failPlayback(`Spotify served a ${reported.toFixed(1)}s preview of a ${expected.toFixed(1)}s track. Full-track license unavailable.`);
        return;
      }
      if (value.status === 'playing' && state.status !== 'playing') {
        activeSince = Date.now(); progressAt = activeSince; progressPosition = Number(value.currentTime || 0);
      }
      if (value.status === 'ended') {
        if (windowsOutput) setState(patch);
        else retireCapture().then(() => setState(patch), (error) => setState({ ...patch,
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
    if (request.type === 'auth-handoff') {
      if (handoffSettled) { note('auth-handoff-rejected', { reason: 'duplicate' }); app.quit(); return; }
      handoffSettled = true;
      handoffResolve(request.envelope);
      return;
    }
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
  function authHandoff(timeoutMs = 8000) {
    let timer;
    return Promise.race([handoffPromise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Authenticated Spotify session handoff timed out.')), timeoutMs);
    })]).finally(() => clearTimeout(timer));
  }
  return { install, hostReady, authHandoff, sourceEvent, captureEvent, command, publicState, onLicenseResponse, observeProgress };
}

module.exports = { createRuntime, PREFIX, MEDIA_RE, normalizeSpotifyInput };
