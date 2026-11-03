'use strict';
// Experiment E main process. Grants ONE capture: the trusted capture page may receive audio from the
// dedicated source webContents, with local echo disabled. Everything else is denied.
const { app, BrowserWindow, session, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config').load();
const policy = require('./policy');
const bridge = require('./bridge');

fs.mkdirSync(cfg.dataDir, { recursive: true });
app.setPath('userData', path.join(cfg.dataDir, 'userData'));
app.setPath('sessionData', path.join(cfg.dataDir, 'userData'));

const report = { electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform,
  arch: process.arch, cfg: { ...cfg }, startedAt: new Date().toISOString(), events: [] };
const note = (type, detail = {}) => { const e = { t: Date.now(), type, ...detail }; report.events.push(e); console.log('[spike]', type, JSON.stringify(detail)); };

let sourceWin = null, captureWin = null, decoyWin = null;
const safePrefs = (partition, extra = {}) => ({ sandbox: true, contextIsolation: true, nodeIntegration: false,
  webSecurity: true, allowRunningInsecureContent: false, partition, ...extra });

function createSource() {
  const partition = cfg.source === 'spotify' && cfg.persistSpotify ? 'persist:eve-spike-spotify' : 'eve-spike-source';
  const ses = session.fromPartition(partition);
  policy.lockSourceSession(ses, cfg, note);
  sourceWin = new BrowserWindow({ width: 420, height: 380, show: cfg.showSource, title: 'Experiment E source',
    webPreferences: safePrefs(partition, { autoplayPolicy: 'no-user-gesture-required' }) });
  policy.lockNavigation(sourceWin.webContents, cfg, note);
  const url = cfg.source === 'spotify' ? cfg.spotifyUrl
    : `file://${path.join(__dirname, 'pages', 'tone.html')}?hz=440&label=source`;
  sourceWin.loadURL(url);
  sourceWin.on('closed', () => { note('source-closed'); sourceWin = null; captureWin?.webContents.send('spike:source-gone'); });
  note('source-created', { partition, url, pid: sourceWin.webContents.getOSProcessId() });
}

function createDecoy() {
  decoyWin = new BrowserWindow({ width: 300, height: 200, title: 'Experiment E decoy (880 Hz)',
    webPreferences: safePrefs('eve-spike-decoy', { autoplayPolicy: 'no-user-gesture-required' }) });
  policy.lockNavigation(decoyWin.webContents, cfg, note);
  decoyWin.loadURL(`file://${path.join(__dirname, 'pages', 'tone.html')}?hz=880&label=decoy`);
  note('decoy-created');
}

function createCapture() {
  const ses = session.fromPartition('eve-spike-capture');
  captureWin = new BrowserWindow({ width: 560, height: 520, title: 'Experiment E capture',
    webPreferences: safePrefs('eve-spike-capture', { preload: path.join(__dirname, 'preload.js') }) });
  policy.lockNavigation(captureWin.webContents, cfg, note);
  ses.setPermissionCheckHandler((wc, perm) => wc === captureWin?.webContents && perm === 'display-capture');
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(wc === captureWin?.webContents && perm === 'display-capture'));
  ses.setDisplayMediaRequestHandler((request, callback) => {
    const trusted = captureWin && request.frame && request.frame === captureWin.webContents.mainFrame
      && request.frame === request.frame.top && request.userGesture === true;
    const target = sourceWin && !sourceWin.isDestroyed() ? sourceWin.webContents.mainFrame : null;
    if (!trusted || !target) {
      note('capture-denied', { trusted: !!trusted, haveSource: !!target, origin: request.securityOrigin, gesture: request.userGesture });
      return callback(null);
    }
    // Targeted webContents capture. NEVER 'loopback'/'loopbackWithMute' (that is system audio).
    note('capture-granted', { localEcho: cfg.localEcho, sourceUrl: target.url });
    callback({ video: target, audio: target, enableLocalEcho: cfg.localEcho });
  });
  captureWin.loadFile(path.join(__dirname, 'pages', 'capture.html'));
  // Automated self-test only (sandbox/CI): simulates the Start click as a user gesture, then exits.
  // Never part of GO evidence; physical acceptance uses a real click.
  const selfTestMs = Number(process.env.EVE_SPIKE_SELFTEST_MS || 0);
  if (selfTestMs > 0) {
    captureWin.webContents.once('did-finish-load', () => setTimeout(() => {
      captureWin.webContents.executeJavaScript("document.getElementById('start').click()", true);
      if (process.env.EVE_SPIKE_SELFTEST_GAIN) setTimeout(() => captureWin?.webContents.executeJavaScript(
        `document.querySelector('[data-gain="${Number(process.env.EVE_SPIKE_SELFTEST_GAIN)}"]').click()`, true), selfTestMs / 3);
      if (process.env.EVE_SPIKE_SELFTEST_DESTROY) setTimeout(() => sourceWin?.destroy(), (2 * selfTestMs) / 3);
      setTimeout(() => app.quit(), selfTestMs);
    }, 1500));
  }
  captureWin.on('closed', () => { captureWin = null; bridge.stop(cfg, note).finally(() => app.quit()); });
}

const fromCapture = (e) => captureWin && e.sender === captureWin.webContents && e.senderFrame === captureWin.webContents.mainFrame;
ipcMain.handle('spike:config', (e) => fromCapture(e) ? { source: cfg.source, deviceId: cfg.deviceId, localEcho: cfg.localEcho,
  decoy: cfg.decoy, electron: process.versions.electron } : null);
ipcMain.on('spike:pcm', (e, msg) => { if (fromCapture(e)) bridge.forward(cfg, msg, note); });
ipcMain.on('spike:stats', (e, s) => { if (fromCapture(e)) report.lastStats = s; });
ipcMain.on('spike:event', (e, ev) => { if (fromCapture(e)) note(`capture:${String(ev?.type || 'event').slice(0, 40)}`, ev); });
ipcMain.handle('spike:source', (e, action) => {
  if (!fromCapture(e)) return false;
  if (action === 'reload' && sourceWin) { sourceWin.webContents.reload(); note('source-reload'); }
  if (action === 'destroy' && sourceWin) sourceWin.destroy();
  if (action === 'recreate' && !sourceWin) createSource();
  return true;
});
ipcMain.handle('spike:metrics', (e) => fromCapture(e) ? app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type,
  cpu: m.cpu?.percentCPUUsage, memKB: m.memory?.workingSetSize })) : null);

app.whenReady().then(() => {
  note('ready', { electron: process.versions.electron });
  createSource();
  if (cfg.decoy) createDecoy();
  createCapture();
});
app.on('will-quit', () => {
  report.endedAt = new Date().toISOString();
  report.metrics = app.getAppMetrics().map((m) => ({ type: m.type, memKB: m.memory?.workingSetSize }));
  const file = path.join(cfg.dataDir, `report-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log('[spike] report', file);
});
