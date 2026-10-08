window.EveAudioflixNativeSpotify = window.EveAudioflixNativeSpotify || {};
(function () {
    'use strict';

    const ns = window.EveAudioflixNativeSpotify;
    if (ns.ready) return;

    const PLAYBACK_RESOLVER_REVISION = 'strict-v4-embedded-first';
    const pendingPlaybackSources = new Map();
    const text = (value) => String(value ?? '').trim();
    const isSpotifyTrack = (track) => text(track?.sourceProvider).toLowerCase() === 'spotify'
        || /^https?:\/\/open\.spotify\.com\/(?:embed\/)?track\//i.test(text(track?.url));

    function state() {
        return window.EveAudioflixState?.ensure?.() || {};
    }

    function canonicalTrack(track) {
        const id = String(track?.id ?? '');
        return (state().music || []).find((item) => String(item?.id ?? '') === id) || track || {};
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
        const identityUrl = text(canonical.url || playable.spotifyUrl || playable.originalUrl || playable.url);
        let playbackUrl = text(canonical.spotifyPlaybackUrl || playable.spotifyPlaybackUrl);
        let playbackProvider = text(canonical.spotifyPlaybackProvider || playable.spotifyPlaybackProvider);
        let playbackTitle = text(canonical.spotifyPlaybackTitle || playable.spotifyPlaybackTitle);
        let playbackResolver = text(canonical.spotifyPlaybackResolver || playable.spotifyPlaybackResolver);
        let playbackResolverRevision = text(
            canonical.spotifyPlaybackResolverRevision || playable.spotifyPlaybackResolverRevision
        );

        // Library state survives page reloads. A URL selected by an older resolver must not become
        // permanent just because it was once persisted: that was keeping tracks on an old provider
        // even after resolver fixes landed. Only reuse a playback URL whose revision matches the
        // currently shipped resolver contract; legacy/unversioned matches get re-resolved once.
        if (playbackUrl && playbackResolverRevision !== PLAYBACK_RESOLVER_REVISION) {
            playbackUrl = '';
            playbackProvider = '';
            playbackTitle = '';
            playbackResolver = '';
            playbackResolverRevision = '';
        }

        // This helper is deliberately idempotent because older boot paths can still have the local
        // prepare decorator installed. If that path already supplied the verified CURRENT source,
        // keep it instead of resolving twice. Unversioned transformed items are intentionally not
        // trusted so a page reload can escape an old persisted match.
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
            if (typeof resolver !== 'function') return base;
            const key = text(canonical.id || canonical.spotifyTrackId || identityUrl);
            if (!key) return base;
            let pending = pendingPlaybackSources.get(key);
            if (!pending) {
                pending = Promise.resolve(resolver(canonical))
                    .finally(() => pendingPlaybackSources.delete(key));
                pendingPlaybackSources.set(key, pending);
            }
            let resolved = null;
            try { resolved = await pending; } catch { resolved = null; }
            if (!resolved?.ok || !text(resolved.url)) return base;

            // Do not bless a response from a still-running older Python server. Browser reloads do
            // not reload server_modules/audioflix_spotify.py; requiring the revision makes a stale
            // server visible instead of silently persisting another legacy match.
            const resolvedRevision = text(resolved.resolverRevision);
            if (resolvedRevision !== PLAYBACK_RESOLVER_REVISION) return base;

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

        // Keep Spotify as identity/provenance only. The verified recording URL is handed to the
        // ordinary Audioflix transport and marked so provider adapters can prefer an Eve-owned
        // HTMLMediaElement stream before falling back to an embedded provider controller.
        return {
            ...base,
            item: {
                ...playable,
                url: playbackUrl,
                originalUrl: text(playable.originalUrl || identityUrl),
                spotifyUrl: identityUrl,
                sourceProvider: 'spotify',
                spotifyPlaybackUrl: playbackUrl,
                spotifyPlaybackProvider: playbackProvider,
                spotifyPlaybackTitle: playbackTitle,
                spotifyPlaybackResolver: playbackResolver,
                spotifyPlaybackResolverRevision: playbackResolverRevision,
                eveOwnedPlaybackSource: true,
                preferEveDirectAudio: true
            },
            status: base?.status || 'Spotify identity matched to the EveOS playback transport.'
        };
    }

    function installPlaybackSourceDecorator(resolveSpotifyPlaybackSource) {
        const localPlayback = window.EveAudioflixLocalPlayback;
        if (!localPlayback?.prepare || localPlayback.__eveSpotifyPlaybackSourceWrapped) return false;
        const originalPrepare = localPlayback.prepare.bind(localPlayback);

        localPlayback.prepare = async function prepareSpotifyIdentity(item) {
            const prepared = await originalPrepare(item);
            return preparePlaybackSource(item, prepared, resolveSpotifyPlaybackSource);
        };
        localPlayback.__eveSpotifyPlaybackSourceWrapped = true;
        return true;
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
        // native.js calls this factory after window.EveAudioflixNative exists. Publish the resolver
        // there without making the host facade duplicate provider-specific request plumbing.
        if (window.EveAudioflixNative) {
            window.EveAudioflixNative.resolveSpotifyPlaybackSource = resolveSpotifyPlaybackSource;
        }
        // Keep the decorator for older direct LocalPlayback callers, but the authoritative
        // Audioflix play path also invokes preparePlaybackSource explicitly. Correct playback no
        // longer depends on this one-shot install winning a script/DOMContentLoaded timing race.
        const install = () => installPlaybackSourceDecorator(resolveSpotifyPlaybackSource);
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
        else install();

        return { listSpotifyPlaylist, openSpotifySession, resolveSpotifyPlaybackSource };
    }

    Object.assign(ns, {
        ready: true,
        PLAYBACK_RESOLVER_REVISION,
        create,
        isSpotifyTrack,
        preparePlaybackSource,
        installPlaybackSourceDecorator
    });
})();