window.EveAudioflixNativeSpotify = window.EveAudioflixNativeSpotify || {};
(function () {
    'use strict';

    const ns = window.EveAudioflixNativeSpotify;
    if (ns.ready) return;

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

    function installPlaybackSourceDecorator(resolveSpotifyPlaybackSource) {
        const localPlayback = window.EveAudioflixLocalPlayback;
        if (!localPlayback?.prepare || localPlayback.__eveSpotifyPlaybackSourceWrapped) return false;
        const originalPrepare = localPlayback.prepare.bind(localPlayback);

        localPlayback.prepare = async function prepareSpotifyIdentity(item) {
            const prepared = await originalPrepare(item);
            const playable = prepared?.item || (item && typeof item === 'object' ? { ...item } : {});
            // A granted/localized file always wins. Spotify is only provenance once EveOS owns a
            // local source, so never replace a playable local copy with an online match.
            if (prepared?.localPath || !isSpotifyTrack(playable)) return prepared;

            const canonical = canonicalTrack(item);
            const identityUrl = text(canonical.url || playable.url);
            let playbackUrl = text(canonical.spotifyPlaybackUrl || playable.spotifyPlaybackUrl);
            let playbackProvider = text(canonical.spotifyPlaybackProvider || playable.spotifyPlaybackProvider);
            let playbackTitle = text(canonical.spotifyPlaybackTitle || playable.spotifyPlaybackTitle);
            let playbackResolver = text(canonical.spotifyPlaybackResolver || playable.spotifyPlaybackResolver);

            if (!playbackUrl) {
                const key = text(canonical.id || canonical.spotifyTrackId || identityUrl);
                if (!key) return prepared;
                let pending = pendingPlaybackSources.get(key);
                if (!pending) {
                    pending = Promise.resolve(resolveSpotifyPlaybackSource(canonical))
                        .finally(() => pendingPlaybackSources.delete(key));
                    pendingPlaybackSources.set(key, pending);
                }
                let resolved = null;
                try { resolved = await pending; } catch { resolved = null; }
                if (!resolved?.ok || !text(resolved.url)) return prepared;

                playbackUrl = text(resolved.url);
                playbackProvider = text(resolved.provider);
                playbackTitle = text(resolved.title);
                playbackResolver = text(resolved.resolver);
                if (canonical.id !== undefined && canonical.id !== null) {
                    window.EveAudioflixState?.updateItem?.('music', canonical.id, {
                        spotifyPlaybackUrl: playbackUrl,
                        spotifyPlaybackProvider: playbackProvider,
                        spotifyPlaybackTitle: playbackTitle,
                        spotifyPlaybackResolver: playbackResolver
                    });
                }
            }

            // Keep the Spotify URL as identity/provenance, but hand the normal Audioflix transport
            // the matched recording URL. From this point volume, seek, pause/resume, queue advance,
            // output routing and WatchFusion controls all go through the same EveOS path used by
            // every other Audioflix item instead of depending on Spotify's iframe transport.
            return {
                ...prepared,
                item: {
                    ...playable,
                    url: playbackUrl,
                    originalUrl: text(playable.originalUrl || identityUrl),
                    spotifyUrl: identityUrl,
                    sourceProvider: 'spotify',
                    spotifyPlaybackUrl: playbackUrl,
                    spotifyPlaybackProvider: playbackProvider,
                    spotifyPlaybackTitle: playbackTitle,
                    spotifyPlaybackResolver: playbackResolver
                },
                status: prepared?.status || 'Spotify identity matched to the EveOS playback transport.'
            };
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

        // native.js calls this factory after window.EveAudioflixNative exists. Publish the resolver
        // there without making the host facade duplicate provider-specific request plumbing.
        if (window.EveAudioflixNative) {
            window.EveAudioflixNative.resolveSpotifyPlaybackSource = resolveSpotifyPlaybackSource;
        }
        const install = () => installPlaybackSourceDecorator(resolveSpotifyPlaybackSource);
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
        else install();

        return { listSpotifyPlaylist, openSpotifySession, resolveSpotifyPlaybackSource };
    }

    Object.assign(ns, { ready: true, create, isSpotifyTrack, installPlaybackSourceDecorator });
})();
