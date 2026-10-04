// Per-item cleaners for the Audioflix store (music tracks, soundboard clips, and path ports).
// Split out of audioflix.state.js to keep that store under the project line cap. These normalize an
// untrusted item/port into the exact shape the app relies on; unknown fields are dropped, so any new
// field must be declared here or it is lost on the next normalize(). The host store passes its own
// primitives from this module (text coerce, volume clamp, id generator), keeping one source of truth.
window.EveAudioflixStateSchema = window.EveAudioflixStateSchema || {};

(function () {
    'use strict';

    const ns = window.EveAudioflixStateSchema;
    if (ns.ready) return;

    function text(value, fallback) {
        const normalized = String(value ?? '').trim();
        return normalized || String(fallback ?? '').trim();
    }
    function normalizeVolume(value, fallback = 1) {
        if (value === '' || value == null) return fallback;
        const numeric = Number(value);
        return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : fallback;
    }

    function id(prefix) {
        return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }
    const bool = value => value === true;
    Object.assign(ns, { text, normalizeVolume, id, bool });

    ns.create = function create(deps) {
        const text = deps.text;
        const normalizeVolume = deps.normalizeVolume;
        const id = deps.id;

        function cleanItem(item, type) {
            const source = item && typeof item === 'object' ? item : {};
            return {
                id: text(source.id, id(type)),
                type,
                title: text(source.title, type === 'music' ? 'Untitled Track' : 'Sound Clip'),
                url: text(source.url, ''),
                // A track can carry both an online stream (`url`) and a local file (`localPath`), so
                // offline/localized play prefers the file while the url stays a fallback.
                localPath: text(source.localPath, ''),
                // Multi-scope localizations of the same track: [{source:"folder:X"|"group:Y", path, kind}].
                // Effective path priority: folder file (1st) > group shortcut (3rd) > group file (2nd/dup).
                localizations: Array.isArray(source.localizations)
                    ? source.localizations.map((l) => ({ source: text(l?.source, ''), path: text(l?.path, ''), kind: l?.kind === 'shortcut' ? 'shortcut' : 'file', linkOf: text(l?.linkOf, '') })).filter((l) => l.source && l.path).slice(0, 40)
                    : [],
                // Manual classifier labels attached to this track (automatic classifiers are
                // derived, never stored). Registry of valid names lives in state.musicClassifiers.
                classifiers: Array.isArray(source.classifiers)
                    ? [...new Set(source.classifiers.map((c) => text(c, '')).filter(Boolean))].slice(0, 40)
                    : [],
                artist: text(source.artist, ''),
                album: text(source.album, ''),
                image: text(source.image, ''),
                explicit: source.explicit === true,
                sourceProvider: text(source.sourceProvider, ''),
                // Keep provider-native identity separate from the mutable playback URL. Spotify
                // recovery can still identify a removed track after its live page stops resolving.
                spotifyTrackId: text(source.spotifyTrackId, ''),
                spotifyUri: text(source.spotifyUri, ''),
                isrc: text(source.isrc, ''),
                playlistPosition: Math.max(0, Number(source.playlistPosition || 0) || 0),
                card: text(source.card, ''),
                folder: text(source.folder, ''),
                category: text(source.category, ''),
                creator: text(source.creator, ''),
                creatorDisplayName: text(source.creatorDisplayName, ''),
                collaborators: Array.isArray(source.collaborators) ? source.collaborators.map((c) => text(c, '')).filter(Boolean) : [],
                audioTitle: text(source.audioTitle, ''),
                audioArtist: text(source.audioArtist, ''),
                audioKind: text(source.audioKind, ''),
                caption: text(source.caption, ''),
                permalink: text(source.permalink, ''),
                volume: normalizeVolume(source.volume, 1),
                // Track length in seconds (0 = not yet known). Persisted so duration facets/smart
                // folders work without replaying every track to re-measure it.
                duration: Number(source.duration) > 0 ? Number(source.duration) : 0,
                exposed: source.exposed === true,
                // Provider playback may need a mounted iframe, but its compact panel is opt-in.
                showProviderTransport: source.showProviderTransport === true,
                hotkey: text(source.hotkey, ''),
                // Live-playlist link: which imported connection a track came from, its upstream id, and
                // whether it has since disappeared upstream (greyed, never auto-deleted). Must survive
                // normalize() or a re-sync loses every track's identity.
                playlistId: text(source.playlistId, ''),
                sourceId: text(source.sourceId, ''),
                upstreamMissing: source.upstreamMissing === true,
                missingLocal: source.missingLocal === true,
                isPorted: source.isPorted === true,
                isMusicPort: source.isMusicPort === true,
                musicPortGroup: text(source.musicPortGroup, ''),
                createdAt: Number(source.createdAt || 0) || Date.now(),
                updatedAt: Number(source.updatedAt || 0) || 0,
                lastPlayedAt: Number(source.lastPlayedAt || 0) || 0
            };
        }

        function cleanPort(port) {
            const src = port && typeof port === 'object' ? port : {};
            return {
                id: text(src.id, id('port')),
                nickname: text(src.nickname, 'Unnamed Port'),
                path: text(src.path, '')
            };
        }

        function cleanScopeBinding(binding) {
            const source = binding && typeof binding === 'object' ? binding : {};
            const audioType = source.audioType === 'sound' ? 'sound' : 'music';
            const scopeType = ['workspace', 'card', 'folder', 'bookmark'].includes(source.scopeType)
                ? source.scopeType
                : 'workspace';
            return {
                id: text(source.id, id('audio-link')),
                audioId: text(source.audioId, ''),
                audioType,
                scopeType,
                workspaceId: text(source.workspaceId, 'main'),
                categoryName: text(source.categoryName, ''),
                folderId: text(source.folderId, ''),
                bookmarkId: text(source.bookmarkId, ''),
                label: text(source.label, ''),
                createdAt: Number(source.createdAt || 0) || Date.now()
            };
        }

        function boundedItems(list, type, max) {
            return (Array.isArray(list) ? list : [])
                .map((item) => cleanItem(item, type))
                .filter((item) => !!item.url || !!item.localPath)
                .slice(-max);
        }

        function boundedBindings(list, max) {
            const seen = new Set();
            return (Array.isArray(list) ? list : [])
                .map(cleanScopeBinding)
                .filter((entry) => {
                    if (!entry.audioId) return false;
                    const key = [
                        entry.audioType,
                        entry.audioId,
                        entry.scopeType,
                        entry.workspaceId.toLowerCase(),
                        entry.categoryName.toLowerCase(),
                        entry.folderId,
                        entry.bookmarkId
                    ].join('::');
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                })
                .slice(-max);
        }

        return { cleanItem, cleanPort, cleanScopeBinding, boundedItems, boundedBindings };
    };

    ns.ready = true;
})();