/* Audioflix: Spotify volume capability coordinator.
 *
 * Two legitimate volume paths are supported:
 *  1) a future/native Spotify iframe controller setVolume() method, when present;
 *  2) the EveOS managed Playwright browser, which applies volume to Spotify's detached media
 *     element inside the protected embed frame.
 *
 * An ordinary/unmanaged browser tab never claims managed control. The managed helper injects a
 * per-process session marker before EveOS loads, and every volume write must round-trip with that
 * exact session id. No screen/tab capture is used.
 */
(function () {
    'use strict';

    const managedSessionId = String(window.__EveAudioflixManagedBrowserSession || '');
    const state = {
        spotifyActive: false,
        controllerDirect: false,
        managedControl: Boolean(managedSessionId),
        helperReachable: Boolean(managedSessionId),
        managedSessionId,
        directControl: Boolean(managedSessionId),
        itemVolume: 1,
        spotifyVolume: 1,
        status: managedSessionId ? 'managed-starting' : 'off',
        message: managedSessionId ? 'Checking managed Spotify browser volume control…' : '',
        authState: 'unknown',
        lastAck: 0,
        lastError: ''
    };
    const listeners = new Set();
    let pendingManagedWrite = null;
    let managedWriteActive = false;

    const clamp = (value) => Math.max(0, Math.min(1,
        Number.isFinite(Number(value)) ? Number(value) : 1));
    const spotifyTrack = (item) => String(item?.sourceProvider || '').toLowerCase() === 'spotify'
        || !!item?.spotifyUrl
        || /(?:spotify:track:|open\.spotify\.com\/(?:embed\/)?track\/)/i.test(String(item?.url || item?.originalUrl || ''));
    const spotifyTrackId = (item) => String(item?.spotifyTrackId || item?.spotifyUrl || item?.url || item?.originalUrl || '')
        .match(/(?:spotify:track:|open\.spotify\.com\/(?:embed\/)?track\/)?([A-Za-z0-9]{22})(?:[?/#]|$)?/i)?.[1] || '';

    function activeSpotifyPlayback() {
        const playback = window.EveAudioflixAudio?.getPlaybackState?.() || {};
        return playback.provider === 'spotify' || spotifyTrack(playback.item) ? playback : null;
    }

    function effectiveVolume(itemVolume) {
        const safe = clamp(itemVolume);
        return clamp(window.EveAudioflixOutputPort?.effective?.(safe) ?? safe);
    }

    function refreshCapability() {
        state.directControl = Boolean(state.controllerDirect || state.managedControl);
        if (state.controllerDirect) {
            state.status = 'direct';
            state.message = '';
        } else if (state.managedControl) {
            state.status = state.lastAck ? 'managed' : 'managed-starting';
            state.message = state.lastAck
                ? `Managed Spotify volume is active at ${Math.round(state.spotifyVolume * 100)}%.`
                : 'Managed Spotify browser is connecting to the embedded player…';
        } else if (state.spotifyActive) {
            state.status = state.managedSessionId ? 'managed-unavailable' : 'provider-owned';
            state.message = state.managedSessionId
                ? `Managed Spotify volume is unavailable${state.lastError ? `: ${state.lastError}` : '.'}`
                : 'Spotify volume needs the EveOS managed browser. Start it from the local Audioflix Spotify browser helper.';
        } else {
            state.status = state.managedControl ? 'managed-ready' : 'off';
            state.message = '';
        }
    }

    function snapshot() {
        return {
            supported: state.directControl,
            status: state.status,
            message: state.message,
            active: state.spotifyActive,
            spotifyActive: state.spotifyActive,
            directControl: state.directControl,
            controllerDirect: state.controllerDirect,
            managedControl: state.managedControl,
            helperReachable: state.helperReachable,
            authState: state.authState,
            itemVolume: state.itemVolume,
            volume: state.spotifyVolume,
            lastAck: state.lastAck,
            lastError: state.lastError
        };
    }

    function notify() {
        refreshCapability();
        const value = snapshot();
        listeners.forEach((listener) => {
            try { listener(value); } catch { /* A view subscriber must not break audio. */ }
        });
    }

    async function api(path, options = {}) {
        const response = await fetch(`/api/audioflix/spotify-browser${path}`, {
            cache: 'no-store',
            credentials: 'same-origin',
            ...options,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                ...(options.headers || {})
            }
        });
        let payload = null;
        try { payload = await response.json(); } catch {}
        if (!response.ok) throw new Error(payload?.reason || payload?.message || `HTTP ${response.status}`);
        return payload || {};
    }

    function managedRequestBody(volume, item) {
        return {
            sessionId: state.managedSessionId,
            volume: clamp(volume),
            trackId: spotifyTrackId(item || activeSpotifyPlayback()?.item)
        };
    }

    function queueManagedVolume(volume, item) {
        if (!state.managedSessionId) return false;
        pendingManagedWrite = managedRequestBody(volume, item);
        if (!managedWriteActive) Promise.resolve().then(pumpManagedVolume);
        return true;
    }

    async function pumpManagedVolume() {
        if (managedWriteActive || !state.managedSessionId) return;
        managedWriteActive = true;
        try {
            while (pendingManagedWrite) {
                const body = pendingManagedWrite;
                pendingManagedWrite = null;
                try {
                    const result = await api('/volume', {
                        method: 'POST',
                        body: JSON.stringify(body)
                    });
                    const valid = result?.ok === true && result?.sessionMatch === true;
                    state.helperReachable = valid;
                    state.managedControl = valid;
                    state.lastError = valid ? '' : String(result?.reason || 'Managed browser did not acknowledge this EveOS session.');
                    if (valid) {
                        state.lastAck = Number(result.lastAppliedAt || Date.now());
                        state.spotifyVolume = clamp(result.volume ?? body.volume);
                    }
                } catch (error) {
                    state.helperReachable = false;
                    state.managedControl = false;
                    state.lastError = String(error?.message || error || 'Managed Spotify browser is unreachable.').slice(0, 240);
                }
                notify();
            }
        } finally {
            managedWriteActive = false;
            if (pendingManagedWrite) Promise.resolve().then(pumpManagedVolume);
        }
    }

    function setSpotifyVolume(volume, options = {}) {
        state.spotifyActive = true;
        state.controllerDirect = options.direct === true;
        state.itemVolume = clamp(volume);
        state.spotifyVolume = effectiveVolume(state.itemVolume);
        if (state.managedSessionId) queueManagedVolume(state.spotifyVolume, options.item);
        notify();
        // Return the effective value so a future official controller.setVolume() path observes the
        // same track x master/output gain as the Playwright path instead of bypassing master volume.
        return state.spotifyVolume;
    }

    function clearSpotify() {
        state.spotifyActive = false;
        state.controllerDirect = false;
        state.itemVolume = 1;
        state.spotifyVolume = 1;
        state.lastError = '';
        // A healthy managed browser remains a capability between tracks. Do not disable the next
        // card's slider merely because the previous Spotify controller was destroyed.
        state.managedControl = Boolean(state.managedSessionId && state.helperReachable);
        notify();
    }

    function syncSpotifyFromPlayback(explicitItemVolume) {
        const playback = activeSpotifyPlayback();
        if (!playback) return null;
        const itemVolume = explicitItemVolume == null
            ? clamp(playback.item?.volume ?? 1)
            : clamp(explicitItemVolume);
        setSpotifyVolume(itemVolume, { direct: state.controllerDirect, item: playback.item });
        return playback;
    }

    async function refreshManagedStatus() {
        if (!state.managedSessionId) {
            state.managedControl = false;
            state.helperReachable = false;
            notify();
            return snapshot();
        }
        try {
            const result = await api('/session-status', {
                method: 'POST',
                body: JSON.stringify({ sessionId: state.managedSessionId })
            });
            const match = result?.helperReachable === true && result?.sessionMatch === true;
            state.helperReachable = match;
            state.managedControl = match;
            state.authState = String(result?.authState || 'unknown');
            state.lastError = match ? '' : String(result?.lastError || 'Managed Spotify browser session is unavailable.');
        } catch (error) {
            state.helperReachable = false;
            state.managedControl = false;
            state.lastError = String(error?.message || error).slice(0, 240);
        }
        notify();
        return snapshot();
    }

    async function startManagedBrowser(pageUrl = '') {
        const body = pageUrl ? { pageUrl } : {};
        return api('/start', { method: 'POST', body: JSON.stringify(body) });
    }

    async function stopManagedBrowser() {
        const result = await api('/stop', { method: 'POST', body: '{}' });
        if (state.managedSessionId) {
            state.helperReachable = false;
            state.managedControl = false;
            state.lastError = 'Managed Spotify browser was stopped.';
            notify();
        }
        return result;
    }

    async function probeAuth(openLogin = false) {
        const result = await api('/auth', {
            method: 'POST',
            body: JSON.stringify({ openLogin: openLogin === true })
        });
        state.authState = String(result?.authState || 'unknown');
        notify();
        return result;
    }

    function enable() {
        if (state.managedSessionId) return refreshManagedStatus();
        state.status = state.controllerDirect ? 'direct' : 'provider-owned';
        state.message = state.controllerDirect
            ? ''
            : 'Spotify volume needs the EveOS managed browser.';
        notify();
        return Promise.resolve(snapshot());
    }
    function disable() {
        clearSpotify();
        return snapshot();
    }
    function armFromTrustedGesture() { return false; }

    function mount(host) {
        // Remove markup left behind by a hot-reloaded pre-port build. No replacement controls are
        // mounted: the ordinary Audioflix card/master controls remain the single volume UI.
        try { host?.querySelector?.(':scope > .af-spotify-volume')?.remove?.(); } catch {}
        return null;
    }

    window.addEventListener?.('eve:audioflix-output-volume', () => {
        const playback = activeSpotifyPlayback();
        if (playback?.item) syncSpotifyFromPlayback(playback.item.volume ?? 1);
    });

    window.EveAudioflixSpotifyVolume = {
        enable,
        disable,
        setSpotifyVolume,
        clearSpotify,
        activeSpotifyPlayback,
        syncSpotifyFromPlayback,
        refreshManagedStatus,
        startManagedBrowser,
        stopManagedBrowser,
        probeAuth,
        armFromTrustedGesture,
        mount,
        snapshot,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }
    };

    if (state.managedSessionId) Promise.resolve().then(refreshManagedStatus);
})();
