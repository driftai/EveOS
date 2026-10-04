// Identity check for the Audioflix native bridge.
//
// The bridge finds EveOS by trying a list of likely ports. That list is a GUESS, and those ports
// belong to whatever happens to be listening on this machine: with another project's HUD on 8770
// and a dev server on 3000, "find the bridge" turned into POSTing raw PCM at unrelated local
// services -- which is how foreign CORS failures ended up in the EveOS console.
//
// So a candidate must identify itself before it is allowed to carry any payload. EveOS answers
// /api/status with service: "eveos-local-server"; nothing else does. Split out of
// audioflix.native.js to keep that file under the project line cap.
window.EveAudioflixNativeIdentity = window.EveAudioflixNativeIdentity || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixNativeIdentity;
    if (ns.ready) return;

    const BRIDGE_SERVICE = 'eveos-local-server';
    const PROBE_TIMEOUT_MS = 800;
    const EXPLICIT_PROBE_TIMEOUT_MS = 1800;
    // Rejections expire so a port that only later hosts EveOS is not blacklisted for the session.
    const REJECT_TTL_MS = 30000;

    const verified = new Set();
    const rejectedUntil = new Map();
    let forceFreshUntil = 0;

    // Explicit user actions such as Spotify Fallback should not inherit a transient 30-second
    // rejection from an earlier scan. Give the next bridge discovery a fresh identity read while
    // preserving the fail-closed requirement that /api/status must still identify EveOS.
    function requestFreshProbe(windowMs = 8000) {
        const duration = Math.max(1000, Math.min(15000, Number(windowMs) || 8000));
        forceFreshUntil = Date.now() + duration;
        rejectedUntil.clear();
    }

    async function isEveOsBridge(base) {
        if (!base) return false;
        if (verified.has(base)) return true;
        const forceFresh = Date.now() < forceFreshUntil;
        if (!forceFresh && (rejectedUntil.get(base) || 0) > Date.now()) return false;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), forceFresh ? EXPLICIT_PROBE_TIMEOUT_MS : PROBE_TIMEOUT_MS);
        try {
            const response = await fetch(`${base}/api/status`, {
                cache: 'no-store',
                signal: controller.signal
            });
            const payload = await response.json().catch(() => ({}));
            if (payload && payload.service === BRIDGE_SERVICE) {
                verified.add(base);
                rejectedUntil.delete(base);
                forceFreshUntil = 0;
                return true;
            }
        } catch (error) {
            // Unreachable, or a foreign service that refuses the read. Either way: not ours.
        } finally {
            clearTimeout(timer);
        }
        rejectedUntil.set(base, Date.now() + (forceFresh ? 1500 : REJECT_TTL_MS));
        return false;
    }

    // Drop cached verdicts — used when the bridge is stopped, so a restart is re-checked instead of
    // trusting a base that has since gone away or changed hands.
    function reset() {
        verified.clear();
        rejectedUntil.clear();
        forceFreshUntil = 0;
    }

    function invalidate(base) {
        if (!base) return;
        verified.delete(base);
        rejectedUntil.set(base, Date.now() + 1500);
    }

    // The fallback buttons are explicit, user-triggered server work. Refresh bridge discovery before
    // their normal action handler runs, and give immediate visible feedback instead of making the
    // user wonder whether the click registered while yt-dlp searches several candidates.
    document.addEventListener('click', (event) => {
        const target = event.target?.closest?.('[data-af-action]');
        const action = target?.dataset?.afAction;
        if (action !== 'retry-spotify-fallback' && action !== 'localize-spotify-fallback-scope') return;
        requestFreshProbe();
        target?.setAttribute?.('aria-busy', 'true');
        if (typeof window.showToast === 'function') {
            window.showToast('Spotify Fallback started — refreshing the EveOS bridge and checking alternate matches.', 'info');
        }
    }, true);

    Object.assign(ns, {
        ready: true,
        BRIDGE_SERVICE,
        isEveOsBridge,
        invalidate,
        reset,
        requestFreshProbe,
        isVerified: (base) => verified.has(base)
    });
})();