window.EveAudioflixNativeSpotify = window.EveAudioflixNativeSpotify || {};
(function () {
    'use strict';

    const ns = window.EveAudioflixNativeSpotify;
    if (ns.ready) return;

    const PLAYBACK_POLICY_REVISION = 'official-embed-v3';
    const PLAYBACK_RESOLVER_REVISION = PLAYBACK_POLICY_REVISION;
    const text = (value) => String(value ?? '').trim();
    const trackId = (value) => text(value)
        .match(/(?:spotify:track:|open\.spotify\.com\/(?:embed\/)?track\/)([A-Za-z0-9]+)/i)?.[1] || '';
    const spotifyUrl = (id) => id ? `https://open.spotify.com/track/${id}` : '';

    function state() {
        return window.EveAudioflixState?.ensure?.() || {};
    }

    function canonicalTrack(track) {
        const id = String(track?.id ?? '');
        return (state().music || []).find((item) => String(item?.id ?? '') === id) || track || {};
    }

    function isSpotifyTrack(track) {
        return text(track?.sourceProvider).toLowerCase() === 'spotify'
            || !!trackId(track?.spotifyUrl)
            || !!trackId(track?.url)
            || !!trackId(track?.originalUrl)
            || !!text(track?.spotifyTrackId);
    }

    function identityUrl(...tracks) {
        for (const track of tracks) {
            if (!track || typeof track !== 'object') continue;
            for (const value of [track.spotifyUrl, track.originalUrl, track.url]) {
                const id = trackId(value);
                if (id) return spotifyUrl(id);
            }
            const storedId = text(track.spotifyTrackId);
            if (storedId) return spotifyUrl(storedId);
        }
        return '';
    }

    function stripAlternatePlaybackFields(track) {
        const clean = { ...(track || {}) };
        [
            'spotifyPlaybackUrl', 'rawAudioUrl', 'audioUrl', 'resolvedAudioUrl', 'resolvedUrl',
            'youtubeUrl', 'youtubeId', 'matchedUrl', 'matchUrl', 'resolverUrl', 'resolverProvider'
        ].forEach((key) => { delete clean[key]; });
        return clean;
    }

    async function preparePlaybackSource(item, prepared) {
        const base = prepared || {
            item: item && typeof item === 'object' ? { ...item } : item,
            localPath: '',
            status: ''
        };
        const playable = base?.item || (item && typeof item === 'object' ? { ...item } : {});
        if (base?.localPath || !isSpotifyTrack(playable)) return base;
        const canonical = canonicalTrack(item);
        const officialUrl = identityUrl(canonical, playable, item);
        if (!officialUrl) return base;
        const cleanPlayable = stripAlternatePlaybackFields(playable);

        return {
            ...base,
            item: {
                ...cleanPlayable,
                url: officialUrl,
                originalUrl: officialUrl,
                spotifyUrl: officialUrl,
                sourceProvider: 'spotify',
                spotifyPlaybackMode: 'official-embed',
                spotifyPlaybackPolicyRevision: PLAYBACK_POLICY_REVISION,
                eveOwnedPlaybackSource: false,
                preferEveDirectAudio: false
            },
            status: base?.status || 'Playing Spotify through the official embed.'
        };
    }

    function installPlaybackSourceDecorator() {
        return false;
    }

    function create({ fetchJson }) {
        async function managedRelay() {
            const R = window.EveAudioflixSpotifyRemote;
            if (!R?.ready) return null;
            try {
                const connection = await R.connect();
                return connection?.connected ? R : null;
            } catch { return null; }
        }

        async function listSpotifyPlaylist(playlistUrl, force = false) {
            if (!playlistUrl) return { ok: false, reason: 'Missing Spotify playlist URL' };
            const relay = await managedRelay();
            if (relay) {
                const result = await relay.send('import', { url: playlistUrl, force: force === true }, { timeout: 190000 });
                if (result?.ok) {
                    return { ...result, provider: 'spotify', cached: false, managedBrowserImport: true };
                }
                if (location.protocol === 'file:' || !result?.unavailable) return result;
            } else if (location.protocol === 'file:' && window.EveAudioflixSpotifyRemote?.snapshot?.().approvalRequired) {
                const pending = window.EveAudioflixSpotifyRemote.snapshot();
                return {
                    ok: false,
                    approvalRequired: true,
                    reason: `Approve this EveOS file tab to import Spotify playlists. Pairing code ${pending.code || '------'}.`
                };
            }
            const refresh = force ? '&refresh=1' : '';
            return fetchJson(`/api/audioflix/spotify-playlist?url=${encodeURIComponent(playlistUrl)}${refresh}`, {
                method: 'GET',
                timeout: 180000,
                probe: force === true
            });
        }

        async function openSpotifySession(playlistUrl) {
            if (!playlistUrl) return { ok: false, reason: 'Missing Spotify playlist URL' };
            const relay = await managedRelay();
            if (relay) {
                return relay.send('auth', { openLogin: true, url: playlistUrl }, { timeout: 12000 });
            }
            return fetchJson('/api/audioflix/spotify-session', {
                method: 'POST',
                body: JSON.stringify({ url: playlistUrl }),
                timeout: 8000,
                probe: true
            });
        }

        return { listSpotifyPlaylist, openSpotifySession };
    }

    Object.assign(ns, {
        ready: true,
        PLAYBACK_POLICY_REVISION,
        PLAYBACK_RESOLVER_REVISION,
        create,
        isSpotifyTrack,
        preparePlaybackSource,
        installPlaybackSourceDecorator
    });
})();