/* Audioflix: Spotify volume capability coordinator.
 *
 * Spotify's official cross-origin embed remains the playback source. EveOS never captures or
 * replays tab audio here. If the official controller exposes a volume method, the adapter marks
 * directControl=true and uses it; otherwise volume remains provider-owned.
 */
(function () {
    'use strict';

    const state = {
        spotifyActive: false,
        directControl: false,
        spotifyVolume: 1,
        status: 'off',
        message: ''
    };
    const listeners = new Set();

    const clamp = (value) => Math.max(0, Math.min(1,
        Number.isFinite(Number(value)) ? Number(value) : 1));
    const spotifyTrack = (item) => String(item?.sourceProvider || '').toLowerCase() === 'spotify'
        || !!item?.spotifyUrl
        || /(?:spotify:track:|open\.spotify\.com\/(?:embed\/)?track\/)/i.test(String(item?.url || item?.originalUrl || ''));

    function activeSpotifyPlayback() {
        const playback = window.EveAudioflixAudio?.getPlaybackState?.() || {};
        return playback.provider === 'spotify' || spotifyTrack(playback.item) ? playback : null;
    }

    function snapshot() {
        return {
            supported: state.directControl,
            status: state.status,
            message: state.message,
            active: state.spotifyActive,
            spotifyActive: state.spotifyActive,
            directControl: state.directControl,
            volume: state.spotifyVolume
        };
    }

    function notify() {
        const value = snapshot();
        listeners.forEach((listener) => {
            try { listener(value); } catch { /* A view subscriber must not break audio. */ }
        });
    }

    function setSpotifyVolume(volume, options = {}) {
        state.spotifyActive = true;
        state.directControl = options.direct === true;
        state.spotifyVolume = clamp(volume);
        state.status = state.directControl ? 'direct' : 'provider-owned';
        state.message = state.directControl
            ? ''
            : 'Spotify audio remains inside the official embed because this controller exposes no volume API.';
        notify();
        return state.spotifyVolume;
    }

    function clearSpotify() {
        state.spotifyActive = false;
        state.directControl = false;
        state.status = 'off';
        state.message = '';
        notify();
    }

    function syncSpotifyFromPlayback(explicitItemVolume) {
        const playback = activeSpotifyPlayback();
        if (!playback) return null;
        const itemVolume = explicitItemVolume == null
            ? clamp(playback.item?.volume ?? 1)
            : clamp(explicitItemVolume);
        const effective = window.EveAudioflixOutputPort?.effective?.(itemVolume) ?? itemVolume;
        setSpotifyVolume(effective, { direct: state.directControl });
        return playback;
    }

    // Compatibility no-ops for callers from builds that still referenced the old capture API.
    // They intentionally never request screen/tab permissions or open a helper window.
    function enable() {
        state.status = state.directControl ? 'direct' : 'provider-owned';
        state.message = state.directControl
            ? ''
            : 'Spotify volume is provider-owned on this browser.';
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

    window.EveAudioflixSpotifyVolume = {
        enable,
        disable,
        setSpotifyVolume,
        clearSpotify,
        activeSpotifyPlayback,
        syncSpotifyFromPlayback,
        armFromTrustedGesture,
        mount,
        snapshot,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }
    };
})();
