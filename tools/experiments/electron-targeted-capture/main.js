'use strict';
// Targeted-capture main process. Grants ONE capture: the trusted capture page may receive audio from
// the dedicated source webContents, with local echo disabled. Everything else is denied.
const { app, BrowserWindow, session, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config').load();
const policy = require('./policy');
const { createBridge } = require('./bridge');
const { createRuntime } = require('./direct-runtime');

fs.mkdirSync(cfg.dataDir, { recursive: true });
app.setPath('userData', path.join(cfg.dataDir, 'userData'));
app.setPath('sessionData', path.join(cfg.dataDir, 'userData'));

const report = { electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform,
  arch: process.arch, cfg: { source: cfg.source, spotifyUrl: policy.redact(cfg.spotifyUrl),
    bridge: cfg.bridge, deviceId: cfg.deviceId, decoy: cfg.decoy, localEcho: cfg.localEcho,
    persistSpotify: cfg.persistSpotify, showSource: cfg.showSource, runtime: cfg.runtime },
  startedAt: new Date().toISOString(), events: [] };
const note = (type, detail = {}) => { const e = { t: Date.now(), type, ...detail }; report.events.push(e); console.log('[spike]', type, JSON.stringify(detail)); };
const bridge = createBridge({ cfg, note });
report.owner = { ownerId: bridge.ownerId, lane: bridge.lane };

let sourceWin = null, captureWin = null, decoyWin = null, directRuntime = null;
const safePrefs = (partition, extra = {}) => ({ sandbox: true, contextIsolation: true, nodeIntegration: false,
  webSecurity: true, allowRunningInsecureContent: false, partition, ...extra });

function createSource() {
  const partition = cfg.source === 'spotify' && cfg.persistSpotify ? 'persist:eve-spike-spotify' : 'eve-spike-source';
  const ses = session.fromPartition(partition);
  policy.lockSourceSession(ses, cfg, note);
  sourceWin = new BrowserWindow({ width: 420, height: 380, show: cfg.showSource,
    title: cfg.runtime ? 'EveOS Spotify Direct Embed' : 'Experiment E source',
    webPreferences: safePrefs(partition, { autoplayPolicy: 'no-user-gesture-required',
      ...(cfg.runtime ? { preload: path.join(__dirname, 'source-preload.js') } : {}) }) });
  policy.lockNavigation(sourceWin.webContents, cfg, note, partition);
  if (cfg.runtime) sourceWin.webContents.on('will-navigate', (event, url) => {
    if (!policy.isSpotifySourceUrl(url)) { event.preventDefault(); note('source-top-nav-blocked', { url: policy.redact(url) }); }
  });
  const url = cfg.runtime ? policy.SPOTIFY_SOURCE_URL : cfg.source === 'spotify' ? cfg.spotifyUrl
    : `file://${path.join(__dirname, 'pages', 'tone.html')}?hz=440&label=source`;
  sourceWin.webContents.on('did-finish-load', () => note('source-loaded', {
    url: policy.redact(sourceWin?.webContents.getURL() || '') }));
  sourceWin.webContents.on('console-message', (_event, ...args) => {
    const details = args.length === 1 && typeof args[0] === 'object' ? args[0] : null;
    const level = details ? details.level : args[0];
    const message = details ? details.message : String(args[1] || '');
    if (level === 'error' || /blocked|refused|failed|error/i.test(message)) {
      note('source-console', { level, message: message.slice(0, 240) });
    }
  });
  // Keep signed-in cookies/storage but discard stale SDK response bodies. Spotify occasionally
  // serves an intermediary plain-text response that Chromium otherwise reuses indefinitely.
  Promise.resolve(cfg.runtime ? ses.clearCache() : undefined)
    .then(() => sourceWin && !sourceWin.isDestroyed() ? sourceWin.loadURL(url) : null)
    .catch((error) => note('source-load-rejected', {
      message: String(error?.message || error).slice(0, 240), url: policy.redact(url) }));
  sourceWin.webContents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
    if (!isMainFrame) return;
    note('source-load-failed', { code, description: String(description || '').slice(0, 160),
      url: policy.redact(failedUrl) });
  });
  sourceWin.on('closed', () => {
    note('source-closed'); sourceWin = null;
    bridge.end('source-closed');                       // flush now; do not wait for the page to notice
    captureWin?.webContents.send('spike:source-gone');
    if (cfg.runtime) setTimeout(() => app.quit(), 25);
  });
  note('source-created', { partition, url: policy.redact(url), pid: sourceWin.webContents.getOSProcessId() });
}

function createDecoy() {
  decoyWin = new BrowserWindow({ width: 300, height: 200, title: 'Experiment E decoy (880 Hz)',
    webPreferences: safePrefs('eve-spike-decoy', { autoplayPolicy: 'no-user-gesture-required' }) });
  policy.lockNavigation(decoyWin.webContents, cfg, note, 'eve-spike-decoy');
  decoyWin.loadURL(`file://${path.join(__dirname, 'pages', 'tone.html')}?hz=880&label=decoy`);
  note('decoy-created');
}

function createCapture() {
  const ses = session.fromPartition('eve-spike-capture');
  captureWin = new BrowserWindow({ width: 560, height: 520, show: !cfg.runtime,
    title: cfg.runtime ? 'EveOS Spotify Direct Capture' : 'Experiment E capture',
    webPreferences: safePrefs('eve-spike-capture', { preload: path.join(__dirname, 'preload.js') }) });
  policy.lockCaptureDocument(captureWin.webContents, note, (why) => bridge.end(why));
  const onCaptureDoc = (wc) => wc === captureWin?.webContents && policy.isCaptureUrl(wc.getURL());
  ses.setPermissionCheckHandler((wc, perm) => onCaptureDoc(wc) && perm === 'display-capture');
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(onCaptureDoc(wc) && perm === 'display-capture'));
  ses.setDisplayMediaRequestHandler((request, callback) => {
    const trusted = trustedCaptureFrame(request.frame) && request.frame === request.frame.top && request.userGesture === true;
    const target = sourceWin && !sourceWin.isDestroyed() ? sourceWin.webContents.mainFrame : null;
    if (!trusted || !target) {
      note('capture-denied', { trusted: !!trusted, haveSource: !!target, origin: policy.redact(request.securityOrigin), gesture: request.userGesture });
      return callback(null);
    }
    // Targeted webContents capture. NEVER 'loopback'/'loopbackWithMute' (that is system audio).
    note('capture-granted', { localEcho: cfg.localEcho, sourceUrl: policy.redact(target.url) });
    callback({ video: target, audio: target, enableLocalEcho: cfg.localEcho });
  });
  captureWin.loadURL(policy.CAPTURE_URL);
  captureWin.webContents.on('render-process-gone', () => {
    note('capture-renderer-gone'); bridge.end('capture-renderer-gone');
    directRuntime?.captureEvent('capture-renderer-gone');
  });
  // Automated self-test only (sandbox/CI): simulates the Start click as a user gesture, then exits.
  // Never part of GO evidence; physical acceptance uses a real click.
  const selfTestMs = Number(process.env.EVE_SPIKE_SELFTEST_MS || 0);
  if (!cfg.runtime && selfTestMs > 0) {
    captureWin.webContents.once('did-finish-load', () => setTimeout(() => {
      captureWin.webContents.executeJavaScript("document.getElementById('start').click()", true);
      if (process.env.EVE_SPIKE_SELFTEST_GAIN) setTimeout(() => captureWin?.webContents.executeJavaScript(
        `document.querySelector('[data-gain="${Number(process.env.EVE_SPIKE_SELFTEST_GAIN)}"]').click()`, true), selfTestMs / 3);
      if (process.env.EVE_SPIKE_SELFTEST_NAV) setTimeout(() => captureWin?.webContents.executeJavaScript(
        `location.href = ${JSON.stringify(process.env.EVE_SPIKE_SELFTEST_NAV)}`, true), selfTestMs / 2);
      if (process.env.EVE_SPIKE_SELFTEST_DESTROY) setTimeout(() => sourceWin?.destroy(), (2 * selfTestMs) / 3);
      setTimeout(() => captureWin?.close(), selfTestMs);   // closes via the normal bridge teardown
    }, 1500));
  }
  captureWin.on('closed', () => { captureWin = null; bridge.end('capture-closed').finally(() => app.quit()); });
}

// Privilege belongs to the exact trusted document, not merely to the window or frame that once held it.
function trustedCaptureFrame(frame) {
  return !!(captureWin && frame && frame === captureWin.webContents.mainFrame && policy.isCaptureUrl(frame.url));
}
const fromCapture = (e) => !!captureWin && e.sender === captureWin.webContents && trustedCaptureFrame(e.senderFrame);
const fromSource = (sender, frame = sender?.mainFrame) => !!sourceWin && sender === sourceWin.webContents
  && frame === sourceWin.webContents.mainFrame && policy.isSpotifySourceUrl(frame?.url);
ipcMain.handle('spike:config', (e) => fromCapture(e) ? { source: cfg.source, deviceId: cfg.deviceId, localEcho: cfg.localEcho,
  decoy: cfg.decoy, electron: process.versions.electron } : null);
ipcMain.on('spike:pcm', (e, msg) => { if (fromCapture(e)) bridge.push(msg?.captureId, msg); });
ipcMain.on('spike:stats', (e, s) => { if (fromCapture(e)) report.lastStats = s; });
ipcMain.on('spike:event', (e, ev) => {
  if (!fromCapture(e)) return;
  const type = String(ev?.type || 'event').slice(0, 40);
  note(`capture:${type}`, ev);
  // The page's capture lifecycle drives exactly one native session per capture generation.
  if (type === 'capture-started') bridge.begin(ev.captureId).then((result) => directRuntime?.captureEvent(type, ev, result));
  if (type === 'capture-stopped' || type === 'track-ended') {
    bridge.end(type, ev.captureId).finally(() => directRuntime?.captureEvent(type, ev, { ok: true }));
  }
});
ipcMain.handle('spike:source', (e, action) => {
  if (!fromCapture(e)) return false;
  if (action === 'reload' && sourceWin) { sourceWin.webContents.reload(); note('source-reload'); }
  if (action === 'destroy' && sourceWin) sourceWin.destroy();
  if (action === 'recreate' && !sourceWin) createSource();
  return true;
});
ipcMain.handle('spike:bridge', (e) => fromCapture(e) ? bridge.totals() : null);
ipcMain.handle('spike:metrics', (e) => fromCapture(e) ? app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type,
  cpu: m.cpu?.percentCPUUsage, memKB: m.memory?.workingSetSize })) : null);

app.whenReady().then(() => {
  note('ready', { electron: process.versions.electron });
  if (cfg.runtime) {
    directRuntime = createRuntime({ app, cfg, note, bridge, ipcMain,
      getSourceWin: () => sourceWin, getCaptureWin: () => captureWin, fromSource });
    directRuntime.install();
  }
  createSource();
  if (cfg.decoy) createDecoy();
  createCapture();
  captureWin.webContents.once('did-finish-load', () => directRuntime?.hostReady());
});
app.on('will-quit', () => {
  report.endedAt = new Date().toISOString();
  report.bridge = bridge.totals();
  report.metrics = app.getAppMetrics().map((m) => ({ type: m.type, memKB: m.memory?.workingSetSize }));
  const file = path.join(cfg.dataDir, `report-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log('[spike] report', file);
});
