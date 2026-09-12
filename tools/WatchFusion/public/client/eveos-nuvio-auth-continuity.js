(function () {
  'use strict';

  if (window.__watchFusionNuvioAuthContinuityReady) return;
  const base = window.watchFusionContinuityState;
  if (!base) return;
  window.__watchFusionNuvioAuthContinuityReady = true;

  const AUTH_KEYS = Object.freeze(['access_token', 'refresh_token', 'is_anonymous_session']);
  const NUVIO_RELOAD_TIMEOUT_MS = 8000;

  function readNuvioSession() {
    const session = {};
    for (const key of AUTH_KEYS) {
      try {
        session[key] = localStorage.getItem(key);
      } catch {
        session[key] = null;
      }
    }
    return session;
  }

  function normalizeNuvioSession(session) {
    if (!session || typeof session !== 'object') return null;
    const normalized = {};
    for (const key of AUTH_KEYS) {
      const value = session[key];
      normalized[key] = value == null ? null : String(value);
    }
    return normalized;
  }

  function sameNuvioSession(left, right) {
    return AUTH_KEYS.every(key => (left?.[key] ?? null) === (right?.[key] ?? null));
  }

  function writeStorageEntries(area, entries) {
    if (!Array.isArray(entries)) return;
    for (const pair of entries) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      try { area.setItem(String(pair[0]), String(pair[1])); } catch {}
    }
  }

  function writeNuvioSession(session) {
    const normalized = normalizeNuvioSession(session);
    if (!normalized) return false;
    for (const key of AUTH_KEYS) {
      try {
        const value = normalized[key];
        if (value == null || value === '') localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch {}
    }
    return true;
  }

  function attachNuvioSession(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return snapshot;
    snapshot.nuvioSession = readNuvioSession();
    return snapshot;
  }

  function nuvioFrameNeedsReload(frame) {
    if (!frame) return false;
    try {
      const href = String(frame.contentWindow?.location?.href || frame.src || '');
      if (!href || href === 'about:blank') return false;
      const parsed = new URL(href, location.href);
      return parsed.origin === location.origin && parsed.pathname.startsWith('/nuvio/');
    } catch {
      return false;
    }
  }

  async function reloadNuvioAfterSessionSeed() {
    const frame = document.getElementById('nuvioFrame');
    if (!nuvioFrameNeedsReload(frame)) return false;

    await new Promise(resolve => {
      let settled = false;
      let timer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try { frame.removeEventListener('load', finish); } catch {}
        resolve();
      };

      try { frame.addEventListener('load', finish, { once: true }); } catch {}
      timer = setTimeout(finish, NUVIO_RELOAD_TIMEOUT_MS);
      try {
        frame.contentWindow?.location?.reload?.();
      } catch {
        try { frame.src = frame.src; } catch {}
        setTimeout(finish, 0);
      }
    });
    return true;
  }

  async function captureSnapshot(options) {
    return attachNuvioSession(await base.captureSnapshot(options));
  }

  function captureEmergencySnapshot(...args) {
    return attachNuvioSession(base.captureEmergencySnapshot(...args));
  }

  async function applySnapshot(snapshot, role) {
    const previous = readNuvioSession();
    writeStorageEntries(localStorage, snapshot?.storage?.local);
    writeStorageEntries(sessionStorage, snapshot?.storage?.session);

    const incoming = normalizeNuvioSession(snapshot?.nuvioSession);
    if (incoming) writeNuvioSession(incoming);
    const seeded = readNuvioSession();
    const authChanged = Boolean(incoming) && !sameNuvioSession(previous, seeded);

    // Chromium/Edge partition third-party storage by top-level site. An EveOS-
    // embedded WatchFusion frame and a detached top-level WatchFusion window can
    // therefore expose different localStorage buckets even at the same origin.
    // Seed the transferred storage partition (plus a dedicated auth copy so
    // generic snapshot limits cannot drop the session) before the ordinary
    // state restore, then reboot an already-loaded Nuvio frame once so its
    // public startup path re-runs auth. This stays at the WatchFusion wrapper
    // boundary; no Nuvio source is patched.
    if (authChanged) await reloadNuvioAfterSessionSeed();
    return base.applySnapshot(snapshot, role);
  }

  window.watchFusionContinuityState = Object.freeze({
    ...base,
    captureSnapshot,
    captureEmergencySnapshot,
    applySnapshot
  });
})();
