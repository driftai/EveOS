'use strict';
// Privilege boundary for remote and local pages in the spike.
const SPOTIFY_HOSTS = new Set(['open.spotify.com', 'accounts.spotify.com', 'www.spotify.com']);

function allowedUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol === 'file:') return u.pathname.includes('/electron-targeted-capture/pages/');
    return u.protocol === 'https:' && SPOTIFY_HOSTS.has(u.hostname);
  } catch { return false; }
}

function lockNavigation(wc, cfg, note) {
  wc.on('will-navigate', (event, url) => { if (!allowedUrl(url)) { event.preventDefault(); note('nav-blocked', { url }); } });
  wc.on('will-redirect', (event, url) => { if (!allowedUrl(url)) { event.preventDefault(); note('redirect-blocked', { url }); } });
  wc.setWindowOpenHandler(({ url }) => {
    // Spotify login popups only (authenticated phase); they inherit the same locked-down preferences.
    if (cfg.source === 'spotify' && allowedUrl(url) && !url.startsWith('file:')) {
      note('popup-allowed', { url });
      return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { sandbox: true, contextIsolation: true,
        nodeIntegration: false, webSecurity: true } } };
    }
    note('popup-denied', { url });
    return { action: 'deny' };
  });
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

module.exports = { allowedUrl, lockNavigation, lockSourceSession };
