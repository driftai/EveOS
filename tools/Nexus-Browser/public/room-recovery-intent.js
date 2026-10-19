(() => {
  'use strict';
  const PREFIX = /^(?:\/recover\s+|run\s+(?:this\s+)?script\s+with\s+recovery\s*:\s*)/i;
  const SUFFIX = /^run\s+(.+?)\s+with\s+recovery\s*$/i;
  const ALLOWED = /\.(?:js|mjs|cjs|py|ps1|cmd|bat)$/i;

  function cleanPath(value) {
    let path = String(value || '').trim();
    if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) path = path.slice(1, -1).trim();
    if (!path || path.length > 240 || path.includes('\\') || path.startsWith('/')
        || path.split('/').some((part) => !part || part === '.' || part === '..'
          || !/^[A-Za-z0-9_. ()-]+$/.test(part) || /[. ]$/.test(part)) || !ALLOWED.test(path)) return null;
    return path;
  }
  function parse(text) {
    const raw = String(text || '').trim();
    const prefixed = raw.match(PREFIX) ? raw.replace(PREFIX, '') : null;
    const suffixed = prefixed == null ? raw.match(SUFFIX)?.[1] : null;
    const scriptPath = cleanPath(prefixed ?? suffixed);
    return scriptPath ? { schema: 'eveos.dex.room-recovery-intent.v1', scriptPath } : null;
  }
  const api = { parse, cleanPath };
  globalThis.BrowserAiBridgeRoomRecoveryIntent = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
