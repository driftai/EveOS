window.EveAudioflixNativeSpotify = window.EveAudioflixNativeSpotify || {};
(function () {
    'use strict';

    const ns = window.EveAudioflixNativeSpotify;
    if (ns.ready) return;

    const PLAYBACK_POLICY_REVISION = 'official-embed-localhost-volume-v2';
    // Compatibility export for diagnostics: this is a playback policy revision now, not an
    // alternate-recording resolver revision.
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

    async function preparePlaybackSource(item, prepared) {
        const base = prepared || {
            item: item && typeof item === 'object' ? { ...item } : item,
            localPath: '',
            status: ''
        };
        const playable = base?.item || (item && typeof item === 'object' ? { ...item } : {});

        // User-owned/localized files remain stronger than the provider. Every non-local Spotify item
        // is restored to its canonical Spotify identity so old saved YouTube/SoundCloud matches can
        // never silently take ownership of normal playback again.
        if (base?.localPath || !isSpotifyTrack(playable)) return base;
        const canonical = canonicalTrack(item);
        const officialUrl = identityUrl(canonical, playable, item);
        if (!officialUrl) return base;

        return {
            ...base,
            item: {
                ...playable,
                url: officialUrl,
                originalUrl: officialUrl,
                spotifyUrl: officialUrl,
                sourceProvider: 'spotify',
                spotifyPlaybackMode: 'official-embed-localhost-volume',
                spotifyPlaybackPolicyRevision: PLAYBACK_POLICY_REVISION,
                // Explicit false values prevent stale persisted resolver flags from routing this
                // clone through the generic direct-media / yt-dlp transport.
                eveOwnedPlaybackSource: false,
                preferEveDirectAudio: false
            },
            status: base?.status || 'Playing Spotify through the official embed; localhost owns volume control.'
        };
    }

    // Normal playback has one explicit preparation boundary in audioflix.audio.js. Do not decorate
    // LocalPlayback or inject an alternate-source resolver into that path.
    function installPlaybackSourceDecorator() {
        return false;
    }

    function create({ fetchJson }) {
        async function listSpotifyPlaylist(playlistUrl, force = false) {
            if (!playlistUrl) return { ok: false, reason: 'Missing Spotify playlist URL' };
            const refresh = force ? '&refresh=1' : '';
            return fetchJson(`/api/audioflix/spotify-playlist?url=${encodeURIComponent(playlistUrl)}${refresh}`, {
                method: 'GET',
                timeout: 180000,
                probe: force === true
            });
        }

        async function openSpotifySession(playlistUrl) {
            if (!playlistUrl) return { ok: false, reason: 'Missing Spotify playlist URL' };
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