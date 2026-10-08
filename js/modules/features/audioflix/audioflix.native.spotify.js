window.EveAudioflixNativeSpotify = window.EveAudioflixNativeSpotify || {};
(function () {
    'use strict';

    const ns = window.EveAudioflixNativeSpotify;
    if (ns.ready) return;

    const PLAYBACK_POLICY_REVISION = 'localhost-resolver-v1';
    const PLAYBACK_RESOLVER_REVISION = 'strict-v4-embedded-first';
    const pendingPlaybackSources = new Map();
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

    function officialFallback(base, playable, officialUrl, reason = '') {
        const status = text(base?.status) || (reason
            ? `Spotify resolver unavailable (${reason}); using Spotify's official embedded player.`
            : `Playing through Spotify's official embedded player.`);
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
                eveOwnedPlaybackSource: false,
                preferEveDirectAudio: false
            },
            status
        };
    }

    async function preparePlaybackSource(item, prepared, resolver = ns.resolveSpotifyPlaybackSource) {
        const base = prepared || {
            item: item && typeof item === 'object' ? { ...item } : item,
            localPath: '',
            status: ''
        };
        const playable = base?.item || (item && typeof item === 'object' ? { ...item } : {});

        // A granted/localized file always wins. Spotify is only provenance once EveOS owns a
        // local source, so never replace a playable local copy with an online match.
        if (base?.localPath || !isSpotifyTrack(playable)) return base;

        const canonical = canonicalTrack(item);
        const officialUrl = identityUrl(canonical, playable, item);
        if (!officialUrl) return base;

        let playbackUrl = text(canonical.spotifyPlaybackUrl || playable.spotifyPlaybackUrl);
        let playbackProvider = text(canonical.spotifyPlaybackProvider || playable.spotifyPlaybackProvider);
        let playbackTitle = text(canonical.spotifyPlaybackTitle || playable.spotifyPlaybackTitle);
        let playbackResolver = text(canonical.spotifyPlaybackResolver || playable.spotifyPlaybackResolver);
        let playbackResolverRevision = text(
            canonical.spotifyPlaybackResolverRevision || playable.spotifyPlaybackResolverRevision
        );

        // Library state survives page reloads. A URL selected by an older resolver must not become
        // permanent just because it was once persisted. Only reuse a playback URL whose revision
        // matches the backend contract currently shipped by EveOS.
        if (playbackUrl && playbackResolverRevision !== PLAYBACK_RESOLVER_REVISION) {
            playbackUrl = '';
            playbackProvider = '';
            playbackTitle = '';
            playbackResolver = '';
            playbackResolverRevision = '';
        }

        // Explicitly prepared clones can already carry the current verified source. Keep them
        // idempotent so the single Audioflix preparation boundary never resolves the same track twice.
        if (!playbackUrl
            && text(playable.spotifyUrl)
            && text(playable.url) !== text(playable.spotifyUrl)
            && text(playable.spotifyPlaybackResolverRevision) === PLAYBACK_RESOLVER_REVISION) {
            playbackUrl = text(playable.url);
            playbackProvider = playbackProvider || text(playable.spotifyPlaybackProvider);
            playbackTitle = playbackTitle || text(playable.spotifyPlaybackTitle);
            playbackResolver = playbackResolver || text(playable.spotifyPlaybackResolver);
            playbackResolverRevision = PLAYBACK_RESOLVER_REVISION;
        }

        if (!playbackUrl) {
            if (typeof resolver !== 'function') return officialFallback(base, playable, officialUrl, 'localhost bridge not ready');
            const key = text(canonical.id || canonical.spotifyTrackId || officialUrl);
            if (!key) return officialFallback(base, playable, officialUrl);

            let pending = pendingPlaybackSources.get(key);
            if (!pending) {
                const resolverTrack = {
                    ...canonical,
                    url: officialUrl,
                    originalUrl: officialUrl,
                    spotifyUrl: officialUrl,
                    sourceProvider: 'spotify'
                };
                pending = Promise.resolve(resolver(resolverTrack))
                    .finally(() => pendingPlaybackSources.delete(key));
                pendingPlaybackSources.set(key, pending);
            }

            let resolved = null;
            try { resolved = await pending; } catch { resolved = null; }
            if (!resolved?.ok || !text(resolved.url)) {
                return officialFallback(base, playable, officialUrl, text(resolved?.reason || 'no verified match'));
            }

            // Browser reloads do not reload the Python server. Refuse a response from an older
            // server revision instead of persisting a stale provider match into the library.
            const resolvedRevision = text(resolved.resolverRevision);
            if (resolvedRevision !== PLAYBACK_RESOLVER_REVISION) {
                return officialFallback(base, playable, officialUrl, 'resolver server is stale');
            }

            playbackUrl = text(resolved.url);
            playbackProvider = text(resolved.provider);
            playbackTitle = text(resolved.title);
            playbackResolver = text(resolved.resolver);
            playbackResolverRevision = resolvedRevision;
            if (canonical.id !== undefined && canonical.id !== null) {
                window.EveAudioflixState?.updateItem?.('music', canonical.id, {
                    spotifyPlaybackUrl: playbackUrl,
                    spotifyPlaybackProvider: playbackProvider,
                    spotifyPlaybackTitle: playbackTitle,
                    spotifyPlaybackResolver: playbackResolver,
                    spotifyPlaybackResolverRevision: playbackResolverRevision
                });
            }
        }

        // Spotify remains the identity/provenance. The strict matched provider URL is deliberately
        // handed to audioflix.audio.source.js, which resolves its actual media URL and wraps it in
        // EveOS /api/proxy?media=1. The resulting HTMLMediaElement is therefore owned by Audioflix
        // and obeys both per-item volume and the shared EveOS Song Output Port master gain.
        return {
            ...base,
            item: {
                ...playable,
                url: playbackUrl,
                originalUrl: officialUrl,
                spotifyUrl: officialUrl,
                sourceProvider: 'spotify',
                spotifyPlaybackMode: 'localhost-resolved',
                spotifyPlaybackPolicyRevision: PLAYBACK_POLICY_REVISION,
                spotifyPlaybackUrl: playbackUrl,
                spotifyPlaybackProvider: playbackProvider,
                spotifyPlaybackTitle: playbackTitle,
                spotifyPlaybackResolver: playbackResolver,
                spotifyPlaybackResolverRevision: playbackResolverRevision,
                eveOwnedPlaybackSource: true,
                preferEveDirectAudio: true
            },
            status: base?.status || 'Spotify matched; routing audio through the EveOS localhost transport.'
        };
    }

    // Normal playback has one explicit source-preparation boundary in audioflix.audio.js. Keep the
    // compatibility export without wrapping LocalPlayback a second time.
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