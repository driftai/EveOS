/* Audioflix Spotify volume capability coordinator.
 *
 * The shared URL transport passes an ALREADY EFFECTIVE gain to provider adapters. This module must
 * never multiply the master/output gain again. Any-browser managed playback is handled by the
 * authorized relay client; the local official-embed fallback remains provider-owned unless Spotify
 * someday exposes a real controller.setVolume() method.
 */
(function () {
    'use strict';

    const state = {
        spotifyActive: false,
        controllerDirect: false,
        managedControl: false,
        helperReachable: false,
        directControl: false,
        spotifyVolume: 1,
        status: 'off',
        message: '',
        authState: 'unknown',
        lastAck: 0,
        lastError: ''
    };
    const listeners = new Set();
    const clamp = (value) => Math.max(0, Math.min(1,
        Number.isFinite(Number(value)) ? Number(value) : 1));
    const effectiveGain = (raw) => clamp(window.EveAudioflixOutputPort?.effective?.(clamp(raw ?? 1)) ?? clamp(raw ?? 1));
    const spotifyTrack = (item) => String(item?.sourceProvider || '').toLowerCase() === 'spotify'
        || !!item?.spotifyUrl
        || /(?:spotify:track:|open\.spotify\.com\/(?:embed\/)?track\/)/i.test(String(item?.url || item?.originalUrl || ''));

    function activeSpotifyPlayback() {
        const playback = window.EveAudioflixAudio?.getPlaybackState?.() || {};
        return playback.provider === 'spotify' || spotifyTrack(playback.item) ? playback : null;
    }
    function remoteSnapshot() {
        return window.EveAudioflixSpotifyRemote?.snapshot?.() || {};
    }
    function refreshCapability() {
        const remote = remoteSnapshot();
        state.managedControl = remote.connected === true;
        state.helperReachable = remote.connected === true;
        state.directControl = Boolean(state.controllerDirect || state.managedControl);
        if (state.controllerDirect) {
            state.status = 'direct';
            state.message = '';
        } else if (state.managedControl) {
            state.status = 'managed-ready';
            state.message = 'Managed Spotify volume is available through the local engine.';
        } else if (remote.approvalRequired) {
            state.status = 'approval-needed';
            state.message = `Approve this EveOS file tab to control Spotify${remote.code ? ` (code ${remote.code})` : ''}.`;
        } else if (state.spotifyActive) {
            state.status = 'provider-owned';
            state.message = 'This local Spotify embed owns its playback volume. Connect the managed Spotify engine for EveOS gain control.';
        } else {
            state.status = 'off';
            state.message = '';
        }
    }
    function snapshot() {
        refreshCapability();
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
            volume: state.spotifyVolume,
            lastAck: state.lastAck,
            lastError: state.lastError
        };
    }
    function notify() {
        const value = snapshot();
        listeners.forEach((listener) => { try { listener(value); } catch {} });
    }

    // IMPORTANT: `volume` is already trackGain x masterGain when invoked by the URL transport.
    function setSpotifyVolume(volume, options = {}) {
        state.spotifyActive = true;
        state.controllerDirect = options.direct === true;
        state.spotifyVolume = clamp(volume);
        notify();
        return state.spotifyVolume;
    }
    function clearSpotify() {
        state.spotifyActive = false;
        state.controllerDirect = false;
        state.spotifyVolume = 1;
        state.lastError = '';
        notify();
    }
    function syncSpotifyFromPlayback(explicitRawVolume) {
        const playback = activeSpotifyPlayback();
        if (!playback?.item) return null;
        const raw = clamp(explicitRawVolume == null ? playback.item.volume ?? 1 : explicitRawVolume);
        const effective = effectiveGain(raw);
        setSpotifyVolume(effective, { direct: state.controllerDirect });
        return playback;
    }
    async function refreshManagedStatus() {
        const remote = window.EveAudioflixSpotifyRemote;
        if (!remote?.ready) {
            state.managedControl = false;
            state.helperReachable = false;
            notify();
            return snapshot();
        }
        try {
            const result = await remote.status();
            state.managedControl = result?.connected === true || remote.snapshot?.().connected === true;
            state.helperReachable = Boolean(result?.managed?.helperReachable ?? state.managedControl);
            state.authState = String(result?.managed?.authState || 'unknown');
            state.lastError = result?.ok === false ? String(result.reason || '') : '';
            if (result?.ok) state.lastAck = Date.now();
        } catch (error) {
            state.managedControl = false;
            state.helperReachable = false;
            state.lastError = String(error?.message || error).slice(0, 240);
        }
        notify();
        return snapshot();
    }
    async function startManagedBrowser() {
        const remote = window.EveAudioflixSpotifyRemote;
        if (!remote?.ready) return { ok: false, reason: 'Spotify relay client is not loaded.' };
        const connection = await remote.connect();
        notify();
        return { ok: connection?.connected === true, ...connection };
    }
    async function stopManagedBrowser() {
        return {
            ok: false,
            reason: 'Playback clients do not shut down the shared Spotify engine. Use the local managed-browser tool for process shutdown.'
        };
    }
    async function probeAuth(openLogin = false) {
        const remote = window.EveAudioflixSpotifyRemote;
        if (!remote?.ready) return { ok: false, reason: 'Spotify relay client is not loaded.' };
        const connection = await remote.connect();
        if (!connection?.connected) return { ok: false, approvalRequired: connection?.approvalRequired === true, ...connection };
        const result = await remote.send('auth', { openLogin: openLogin === true }, { timeout: 12000 });
        state.authState = String(result?.authState || result?.managed?.authState || 'unknown');
        notify();
        return result;
    }
    function enable() {
        notify();
        return Promise.resolve(snapshot());
    }
    function disable() {
        clearSpotify();
        return snapshot();
    }
    function armFromTrustedGesture() { return false; }
    function mount(host) {
        try { host?.querySelector?.(':scope > .af-spotify-volume')?.remove?.(); } catch {}
        return null;
    }

    // One relay flight plus one replaceable intent. Slider events never allocate waiter queues.
    function createManagedLane({ remote, currentContext, onResult }) {
        let flight = null, pending = null, acknowledged = null;
        const counts = { requested: 0, sent: 0, completed: 0, coalesced: 0, discarded: 0 };
        const key = (context) => context && JSON.stringify([
            context.run, context.itemId, context.spotifyId,
            context.ownerEpoch, context.engineEpoch, context.trackGeneration
        ]);
        function current() {
            const context = currentContext();
            return context?.active && context.isOwner === true && remote()?.snapshot?.().connected
                ? { ...context, key: key(context) } : null;
        }
        function drain() {
            if (flight || !pending) return;
            const intent = pending;
            pending = null;
            if (current()?.key !== intent.context.key) { counts.discarded++; return; }
            if (acknowledged?.context.key === intent.context.key && acknowledged.volume === intent.volume) {
                counts.coalesced++; return;
            }
            flight = intent;
            counts.sent++;
            Promise.resolve().then(() => {
                // A play/stop/owner change can happen before this microtask reaches the relay.
                if (current()?.key !== intent.context.key) return { skipped: true };
                return remote().send('volume', {
                    effectiveVolume: intent.volume, spotifyId: intent.context.spotifyId,
                    ownerEpoch: intent.context.ownerEpoch, engineEpoch: intent.context.engineEpoch,
                    trackGeneration: intent.context.trackGeneration
                }, { timeout: 5000 });
            }).then(result => {
                if (current()?.key !== intent.context.key || result?.skipped) { counts.discarded++; return; }
                if (result?.ok) acknowledged = intent;
                onResult?.(result);
            }, error => {
                if (current()?.key === intent.context.key) onResult?.({ ok: false, reason: String(error?.message || error) });
            }).finally(() => { flight = null; counts.completed++; drain(); });
        }
        function request(volume) {
            counts.requested++;
            const context = current();
            if (!context) { pending = null; counts.discarded++; return false; }
            const value = clamp(volume);
            if (pending?.context.key === context.key && pending.volume === value) { counts.coalesced++; return true; }
            if (!flight && acknowledged?.context.key === context.key && acknowledged.volume === value) {
                pending = null; counts.coalesced++; return true;
            }
            if (pending) counts.coalesced++;
            pending = { context, volume: value };
            drain();
            return true;
        }
        return { request, invalidate() { pending = null; acknowledged = null; },
            diagnostics: () => ({ ...counts, inFlight: flight ? 1 : 0, pending: pending ? 1 : 0 }) };
    }

    function createManagedPlaybackLane(remote, currentPlayback, trackId) {
        let accepted = null;
        const lane = createManagedLane({
            remote,
            currentContext() {
                const playback = currentPlayback();
                const observed = remote()?.snapshot?.().lastState;
                if (!accepted || !playback.active || !playback.item) return null;
                if (observed && Number(observed.ownerEpoch || 0) >= accepted.ownerEpoch
                    && (observed.isOwner === false || Number(observed.ownerEpoch || 0) > accepted.ownerEpoch)) return null;
                return { ...accepted, ...playback,
                    itemId: String(playback.item.id || ''), spotifyId: trackId(playback.item) };
            },
            onResult(result) {
                if (!result?.ok) console.warn('[Audioflix] Managed Spotify volume:', result?.reason || 'failed');
            }
        });
        return { ...lane, observe(result) {
            accepted = { isOwner: result.isOwner === true, ownerEpoch: Number(result.ownerEpoch || 0),
                engineEpoch: Number(result.engineEpoch || 0), trackGeneration: Number(result.engine?.generation || 0) };
        } };
    }

    window.addEventListener?.('eve:audioflix-output-volume', () => {
        const playback = activeSpotifyPlayback();
        if (playback?.item && playback.remoteManaged !== true) syncSpotifyFromPlayback(playback.item.volume ?? 1);
    });
    window.addEventListener?.('eve:audioflix-spotify-capability', notify);

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
        createManagedLane,
        createManagedPlaybackLane,
        effectiveGain,
        snapshot,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }
    };
})();
