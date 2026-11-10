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

    // Provider media identity. A Spotify playlist row can be a track, a podcast episode, or a
    // local file the playlist owner added from their own disk. Track and episode IDs live in
    // separate namespaces, so identity is always provider:type:id, never a bare ID or a title.
    const MEDIA_TYPES = ['track', 'episode', 'local', 'unknown'];
    const AVAILABILITY = ['playable', 'metadata-only', 'unavailable', 'unknown'];
    const SPOTIFY_REF = /(?:spotify:(track|episode|local):|open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(track|episode)\/)([^?#\s"'<>]+)/i;
    function spotifyRef(value) {
        const match = String(value ?? '').match(SPOTIFY_REF);
        if (!match) return null;
        const type = (match[1] || match[2]).toLowerCase();
        const raw = match[3];
        const mediaId = type === 'local' ? raw : (raw.match(/^[A-Za-z0-9]+/)?.[0] || '');
        if (!mediaId) return null;
        return { type, id: mediaId, uri: `spotify:${type}:${mediaId}` };
    }
    // Official embeds support typed tracks and episodes. Spotify-local rows still require a file.
    const SPOTIFY_PLAYABLE_TYPES = new Set(['track', 'episode']);
    function mediaIdentity(source) {
        const item = source && typeof source === 'object' ? source : {};
        const declaredProvider = text(item.sourceProvider, '').toLowerCase();
        const legacyTrack = text(item.spotifyTrackId, '');
        const ref = spotifyRef(item.sourceUri) || spotifyRef(item.spotifyUri) || spotifyRef(item.url)
            || (legacyTrack ? spotifyRef(`spotify:track:${legacyTrack}`) : null);
        const declaredType = MEDIA_TYPES.includes(item.sourceMediaType) ? item.sourceMediaType : '';
        const isSpotify = declaredProvider === 'spotify' || (!declaredProvider && !!ref);
        const hasLocal = !!text(item.localPath, '');
        const declaredAvailability = AVAILABILITY.includes(item.sourceAvailability) ? item.sourceAvailability : '';
        if (!isSpotify) {
            const type = declaredType;
            return {
                sourceProvider: declaredProvider ? text(item.sourceProvider, '') : '',
                sourceMediaType: type,
                sourceMediaId: text(item.sourceMediaId, ''),
                sourceUri: text(item.sourceUri, ''),
                sourceIsLocal: item.sourceIsLocal === true || type === 'local',
                sourcePlayable: !!(text(item.url, '') || hasLocal) && declaredAvailability !== 'unavailable',
                sourceAvailability: declaredAvailability || (text(item.url, '') || hasLocal ? 'unknown' : '')
            };
        }
        const type = declaredType || ref?.type || (item.sourceIsLocal === true ? 'local' : 'unknown');
        const mediaId = text(item.sourceMediaId, '') || (ref && ref.type === type ? ref.id : '')
            || (type === 'track' ? legacyTrack : '');
        const uri = mediaId && type !== 'unknown' ? `spotify:${type}:${mediaId}` : text(item.sourceUri, '');
        const hasUrl = !!text(item.url, '');
        // A Spotify-imported row that was matched to another stream (no Spotify ref in its URL)
        // still plays through that URL; a Spotify-local reference alone cannot supply audio.
        const otherStream = hasUrl && type === 'unknown' && !spotifyRef(item.url);
        const playable = hasLocal || otherStream
            || (SPOTIFY_PLAYABLE_TYPES.has(type) && !!mediaId && declaredAvailability !== 'unavailable');
        const availability = declaredAvailability === 'unavailable' && !hasLocal ? 'unavailable'
            : playable ? 'playable' : 'metadata-only';
        return {
            sourceProvider: 'spotify', sourceMediaType: type, sourceMediaId: mediaId, sourceUri: uri,
            sourceIsLocal: type === 'local', sourcePlayable: playable, sourceAvailability: availability
        };
    }
    function identityKey(item) {
        const identity = mediaIdentity(item);
        if (!identity.sourceProvider || !identity.sourceMediaId || !identity.sourceMediaType) return '';
        return `${identity.sourceProvider}:${identity.sourceMediaType}:${identity.sourceMediaId}`;
    }
    // A music item survives normalization when it can play (url/localPath) or when it carries a
    // real provider identity (metadata-only podcast/local rows). Titles alone never qualify.
    function isRetained(item) {
        if (!item || typeof item !== 'object') return false;
        if (text(item.url, '') || text(item.localPath, '')) return true;
        return !!text(item.sourceProvider, '') && !!(text(item.sourceMediaId, '') || text(item.sourceUri, '') || text(item.sourceId, ''));
    }
    Object.assign(ns, { text, normalizeVolume, id, bool, spotifyRef, mediaIdentity, identityKey, isRetained });

    ns.create = function create(deps) {
        const text = deps.text;
        const normalizeVolume = deps.normalizeVolume;
        const id = deps.id;

        const POLICY_SOURCE = new Set(['inherit', 'localized', 'original']);
        const POLICY_SPOTIFY = new Set(['inherit', 'managed', 'embed']);
        const POLICY_SCOPE = new Set(['nexus', 'global', 'custom']);
        const POLICY_OUTPUT = new Set(['inherit', 'global', 'custom']);
        const POLICY_OUTPUT_KIND = new Set(['browser', 'native']);

        function cleanPlaybackPolicy(policy, options = {}) {
            const source = policy && typeof policy === 'object' && !Array.isArray(policy) ? policy : {};
            const global = options.global === true;
            const partial = options.partial === true;
            const fallbackSource = global ? 'localized' : 'inherit';
            const fallbackSpotify = global ? 'managed' : 'inherit';
            const fallbackOutput = global ? 'global' : 'inherit';
            const value = {
                sourcePreference: POLICY_SOURCE.has(source.sourcePreference) ? source.sourcePreference : fallbackSource,
                spotifyMethod: source.spotifyMethod === 'electron' ? 'embed'
                    : POLICY_SPOTIFY.has(source.spotifyMethod) ? source.spotifyMethod : fallbackSpotify,
                outputMode: POLICY_OUTPUT.has(source.outputMode) ? source.outputMode : fallbackOutput,
                outputKind: POLICY_OUTPUT_KIND.has(source.outputKind) ? source.outputKind : 'native',
                outputId: text(source.outputId, ''),
                outputLabel: text(source.outputLabel, ''),
                priority: Math.max(-1000, Math.min(1000, Number(source.priority || 0) || 0))
            };
            if (!global) value.scopeMode = POLICY_SCOPE.has(source.scopeMode) ? source.scopeMode : 'nexus';
            if (value.outputMode !== 'custom' || !value.outputId) {
                value.outputId = '';
                value.outputLabel = '';
            }
            if (partial) {
                if (!Object.prototype.hasOwnProperty.call(source, 'sourcePreference')) delete value.sourcePreference;
                if (!Object.prototype.hasOwnProperty.call(source, 'spotifyMethod')) delete value.spotifyMethod;
                if (!Object.prototype.hasOwnProperty.call(source, 'outputMode')) {
                    delete value.outputMode; delete value.outputKind; delete value.outputId; delete value.outputLabel;
                }
                if (!Object.prototype.hasOwnProperty.call(source, 'priority')) delete value.priority;
                delete value.scopeMode;
            }
            return value;
        }

        function cleanScopePolicies(policies) {
            if (!policies || typeof policies !== 'object' || Array.isArray(policies)) return {};
            return Object.fromEntries(Object.entries(policies)
                .map(([key, policy]) => [text(key, '').toLowerCase(), cleanPlaybackPolicy(policy, { partial: true })])
                .filter(([key, policy]) => key && Object.keys(policy).length)
                .slice(0, 512));
        }

        function cleanItem(item, type) {
            const source = item && typeof item === 'object' ? item : {};
            const identity = mediaIdentity(source);
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
                // Generic provider identity (track | episode | local | unknown), derived from legacy
                // Spotify fields on load so old libraries migrate without a rewrite. Idempotent.
                ...identity,
                // Legacy Spotify aliases stay track-only: playback code reads them as track IDs, so
                // an episode or local row must never populate them with a non-track identity.
                spotifyTrackId: identity.sourceMediaType === 'track' ? identity.sourceMediaId : (identity.sourceProvider === 'spotify' ? '' : text(source.spotifyTrackId, '')),
                spotifyUri: identity.sourceMediaType === 'track' ? identity.sourceUri : (identity.sourceProvider === 'spotify' ? '' : text(source.spotifyUri, '')),
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
                ...(source.playbackPolicy && typeof source.playbackPolicy === 'object'
                    && Object.keys(source.playbackPolicy).length
                    ? { playbackPolicy: cleanPlaybackPolicy(source.playbackPolicy) } : {}),
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
            const cleaned = (Array.isArray(list) ? list : [])
                .map((item) => cleanItem(item, type))
                .filter((item) => type === 'music' ? isRetained(item) : (!!item.url || !!item.localPath));
            // Library size is a performance concern, never a data-retention policy. The old music
            // path silently kept only the last MAX_MUSIC records via slice(-max), which could erase
            // songs simply by normalizing/restoring a library above 10k. Keep soundboard's deliberate
            // bounded behavior, but music must remain lossless; scale is handled by the view/runtime.
            if (type === 'music') return cleaned;
            return Number.isFinite(max) && max > 0 ? cleaned.slice(-max) : cleaned;
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

        return {
            cleanItem, cleanPort, cleanScopeBinding, boundedItems, boundedBindings, isRetained,
            cleanPlaybackPolicy, cleanScopePolicies
        };
    };

    ns.ready = true;
})();
