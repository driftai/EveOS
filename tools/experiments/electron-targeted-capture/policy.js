'use strict';
// Privilege boundary for remote and local pages in the spike.
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');

const SPOTIFY_HOSTS = new Set(['open.spotify.com', 'accounts.spotify.com', 'www.spotify.com']);
const PAGES_DIR = path.join(__dirname, 'pages');
// Only these local documents may ever load. capture.html is additionally pinned to its own window.
const LOCAL_PAGES = new Set(['tone.html', 'capture.html', 'spotify-source.html']);
const CAPTURE_URL = pathToFileURL(path.join(PAGES_DIR, 'capture.html')).href;
const SPOTIFY_SOURCE_URL = pathToFileURL(path.join(PAGES_DIR, 'spotify-source.html')).href;

function localPage(u) {
  let file;
  try { file = fileURLToPath(u); } catch { return null; }
  const rel = path.relative(PAGES_DIR, path.resolve(file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) return null;
  return LOCAL_PAGES.has(rel) ? rel : null;
}

function allowedUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol === 'file:') return localPage(u) !== null && !u.host;
    return u.protocol === 'https:' && SPOTIFY_HOSTS.has(u.hostname) && !u.username && !u.password && !u.port;
  } catch { return false; }
}

// The trusted capture document, exactly: same file, no query, no fragment.
function isCaptureUrl(raw) {
  try { const u = new URL(raw); return u.protocol === 'file:' && !u.search && !u.hash && u.href === CAPTURE_URL; }
  catch { return false; }
}

function isSpotifySourceUrl(raw) {
  try { const u = new URL(raw); return u.protocol === 'file:' && !u.search && !u.hash && u.href === SPOTIFY_SOURCE_URL; }
  catch { return false; }
}

// Diagnostics never keep query strings or fragments (Spotify login carries codes/state there).
function redact(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol === 'file:') return `file:.../${path.basename(u.pathname)}`;
    return `${u.protocol}//${u.host}${u.pathname}${u.search || u.hash ? ' [params redacted]' : ''}`;
  } catch { return '[unparseable url]'; }
}

const lockedPrefs = (partition) => ({ sandbox: true, contextIsolation: true, nodeIntegration: false,
  webSecurity: true, allowRunningInsecureContent: false, partition });

function lockNavigation(wc, cfg, note, partition) {
  wc.on('will-navigate', (event, url) => { if (!allowedUrl(url)) { event.preventDefault(); note('nav-blocked', { url: redact(url) }); } });
  wc.on('will-redirect', (event, url) => { if (!allowedUrl(url)) { event.preventDefault(); note('redirect-blocked', { url: redact(url) }); } });
  wc.on('will-frame-navigate', (details) => {
    if (!allowedUrl(details.url) && !String(details.url).startsWith('about:')) {
      details.preventDefault(); note('frame-nav-blocked', { url: redact(details.url) });
    }
  });
  wc.setWindowOpenHandler(({ url }) => {
    // Spotify login popups only (authenticated phase), in the opener's locked session.
    if (cfg.source === 'spotify' && allowedUrl(url) && !url.startsWith('file:')) {
      note('popup-allowed', { url: redact(url) });
      return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: lockedPrefs(partition) } };
    }
    note('popup-denied', { url: redact(url) });
    return { action: 'deny' };
  });
  // Every allowed popup gets the same navigation, popup and webview locks, recursively.
  wc.on('did-create-window', (child) => { note('popup-locked'); lockNavigation(child.webContents, cfg, note, partition); });
  wc.on('will-attach-webview', (event) => { event.preventDefault(); note('webview-denied'); });
}

// The capture window holds the privileged preload: it may show capture.html and nothing else.
function lockCaptureDocument(wc, note, onLeave) {
  const deny = (kind) => (event, url) => {
    if (isCaptureUrl(url)) return;
    event.preventDefault(); note(kind, { url: redact(url) }); onLeave(kind);
  };
  wc.on('will-navigate', deny('capture-nav-blocked'));
  wc.on('will-redirect', deny('capture-redirect-blocked'));
  wc.on('will-frame-navigate', (details) => {
    if (details.isMainFrame && isCaptureUrl(details.url)) return;
    details.preventDefault(); note('capture-frame-nav-blocked', { url: redact(details.url) }); onLeave('capture-frame-nav');
  });
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument && !isCaptureUrl(details.url)) onLeave('capture-left-document');
  });
  wc.setWindowOpenHandler(({ url }) => { note('capture-popup-denied', { url: redact(url) }); return { action: 'deny' }; });
  wc.on('will-attach-webview', (event) => { event.preventDefault(); note('webview-denied'); });
}

function lockSourceSession(ses, cfg, note) {
  // The source never captures anything and gets no device access. mediaKeySystem is allowed for
  // legitimate licensed playback only; stock Electron ships no Widevine CDM, so DRM full tracks may fail.
  const allowed = new Set(['fullscreen', 'mediaKeySystem']);
  ses.setPermissionRequestHandler((wc, perm, cb) => { const ok = allowed.has(perm); if (!ok) note('source-perm-denied', { perm }); cb(ok); });
  ses.setPermissionCheckHandler((wc, perm) => allowed.has(perm));
  ses.setDisplayMediaRequestHandler((req, cb) => { note('source-capture-denied'); cb(null); });
}

module.exports = { allowedUrl, isCaptureUrl, isSpotifySourceUrl, redact, lockNavigation, lockCaptureDocument,
  lockSourceSession, lockedPrefs, CAPTURE_URL, SPOTIFY_SOURCE_URL, PAGES_DIR };
