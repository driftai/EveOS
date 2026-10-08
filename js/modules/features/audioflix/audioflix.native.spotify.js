window.EveAudioflixNativeSpotify = window.EveAudioflixNativeSpotify || {};
(function () {
    'use strict';

    const ns = window.EveAudioflixNativeSpotify;
    if (ns.ready) return;

    const PLAYBACK_POLICY_REVISION = 'official-embed-v1';
    // Kept as a compatibility export for older diagnostics. It now describes the playback policy,
    // not permission to replace Spotify with an independently matched recording.
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

        // A user-owned localized file remains the strongest source. For every non-local Spotify
        // item, restore the canonical Spotify identity even when an older library snapshot carries
        // a cached YouTube/SoundCloud playback match from the retired automatic resolver.
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
                spotifyPlaybackMode: 'official-embed',
                spotifyPlaybackPolicyRevision: PLAYBACK_POLICY_REVISION,
                // Explicit false values prevent stale saved resolver flags from routing this clone
                // through the generic direct-media/YouTube transport.
                eveOwnedPlaybackSource: false,
                preferEveDirectAudio: false
            },
            status: base?.status || 'Playing through Spotify\'s official embedded player.'
        };
    }

    // Kept for compatibility with old callers. Normal playback no longer decorates LocalPlayback;
    // audioflix.audio.js owns the single explicit preparation boundary.
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

        // This compatibility lookup is intentionally explicit. It may support a future user-chosen
        // alternate-source preview/localization flow, but normal Spotify playback never calls it.
        async function resolveSpotifyPlaybackSource(track) {
            if (!isSpotifyTrack(track)) return { ok: false, reason: 'Not a Spotify track.' };
            return fetchJson('/api/audioflix/spotify-session', {
                method: 'POST',
                body: JSON.stringify({ action: 'resolve-playback-source', track }),
                timeout: 45000,
                probe: true
            });
        }

        ns.resolveSpotifyPlaybackSource = resolveSpotifyPlaybackSource;
        if (window.EveAudioflixNative) {
            window.EveAudioflixNative.resolveSpotifyPlaybackSource = resolveSpotifyPlaybackSource;
        }
        return { listSpotifyPlaylist, openSpotifySession, resolveSpotifyPlaybackSource };
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
