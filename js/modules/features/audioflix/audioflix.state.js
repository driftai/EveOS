window.EveAudioflixState = window.EveAudioflixState || {};
(function () {
    'use strict';

    const ns = window.EveAudioflixState;
    if (ns.ready) return;

    const STORAGE_KEY = 'eveAudioflixFallbackState';
    const SAVE_DELAY_MS = 500;
    const MAX_SOUNDBOARD = 240;
    const MAX_MUSIC = 10000;
    const MAX_SCOPE_BINDINGS = 20000;
    const MAX_RECENT = 60;
    let saveTimer = 0;
    let cachedRoot = null;
    let cachedState = null;
    let fallbackState = null;
    let revision = 0;
    const pendingSaveReasons = new Set();

    function getConfigRoot() {
        if (window.eveState?.config && typeof window.eveState.config === 'object') return window.eveState.config;
        if (typeof config !== 'undefined' && config && typeof config === 'object') return config;
        return null;
    }

    // Delegated to the recovery guard. Reading here used to swallow a parse failure and return {},
    // so damaged data read as an empty library and the next save wrote that emptiness over the only
    // copy. If the guard is somehow absent we refuse to persist at all rather than risk repeating
    // that: not saving is recoverable, overwriting the library is not.
    function fallbackRead() {
        return window.EveAudioflixStateRecovery?.read(STORAGE_KEY)?.state || {};
    }

    function fallbackWrite(state, options) {
        const guard = window.EveAudioflixStateRecovery;
        if (!guard) {
            console.warn('[Audioflix] recovery guard missing — not persisting, to avoid data loss.');
            return { written: false, reason: 'recovery guard not loaded' };
        }
        return guard.write(STORAGE_KEY, state, options);
    }

    const { text, normalizeVolume, id, bool } = window.EveAudioflixStateSchema;

    // Per-item cleaners live in a sibling module (audioflix.state.schema.js) so this store stays
    // under the line cap; they run against the same coerce/clamp/id primitives.
    const { cleanItem, cleanPort, boundedItems, boundedBindings } = window.EveAudioflixStateSchema.create({ text, normalizeVolume, id });

    function normalize(raw) {
        const source = raw && typeof raw === 'object' ? raw : {};
        const legacyMusicFocus = text(source.activeFrontendMusicGroup, '');
        const legacyArtist = legacyMusicFocus.startsWith('smart:artist:') ? legacyMusicFocus : '';
        const legacyClassifier = legacyMusicFocus.startsWith('class:') ? legacyMusicFocus : '';
        return {
            schemaVersion: 2, durabilityRevision: Math.max(0, Number(source.durabilityRevision || 0) || 0), durabilityUpdatedAt: Math.max(0, Number(source.durabilityUpdatedAt || 0) || 0),
            enabled: source.enabled !== false,
            routeMode: ['browser', 'browser-selective', 'vb-cable', 'manual', 'native-bridge'].includes(source.routeMode) ? source.routeMode : 'browser',
            preferredSinkId: text(source.preferredSinkId, ''),
            preferredSinkLabel: text(source.preferredSinkLabel, ''),
            nativeBridgeEnabled: bool(source.nativeBridgeEnabled),
            nativeOutputId: text(source.nativeOutputId, ''),
            nativeOutputLabel: text(source.nativeOutputLabel, ''),
            nativeInputId: text(source.nativeInputId, ''),
            nativeInputLabel: text(source.nativeInputLabel, ''),
            nativeSuppressBrowserPlayback: source.nativeSuppressBrowserPlayback !== false,
            nativeBridgeBase: text(source.nativeBridgeBase, ''),
            geminiVoicePortEnabled: bool(source.geminiVoicePortEnabled),
            geminiVoiceMonitorEnabled: source.geminiVoiceMonitorEnabled !== false,
            geminiVoiceMonitorSinkId: text(source.geminiVoiceMonitorSinkId, ''),
            geminiVoiceMonitorSinkLabel: text(source.geminiVoiceMonitorSinkLabel, ''),
            geminiVoiceMonitorVolume: normalizeVolume(source.geminiVoiceMonitorVolume, 0.75),
            // Mode 2 (Text Brain -> Live Voice) is the DEFAULT conversation mode: the 1M-token
            // text brain does the thinking and holds the relayed EveOS context; the live model
            // just voices its reply. One-time migration: states saved BEFORE this default carried
            // 'direct-live' merely as the old default, so 'direct-live' is only respected once
            // the migration flag exists (i.e. the user re-chose it after the switch).
            geminiConversationMode: source.geminiModeDefaultV2Applied === true
                ? (source.geminiConversationMode === 'direct-live' ? 'direct-live' : 'text-brain-live-voice')
                : 'text-brain-live-voice',
            geminiModeDefaultV2Applied: true,
            soundboard: boundedItems(source.soundboard, 'sound', MAX_SOUNDBOARD),
            music: boundedItems(source.music, 'music', MAX_MUSIC),
            recentPlays: (Array.isArray(source.recentPlays) ? source.recentPlays : []).slice(-MAX_RECENT),
            ports: (Array.isArray(source.ports) ? source.ports : []).map(cleanPort),
            browserFolders: (Array.isArray(source.browserFolders) ? source.browserFolders : [])
                .map((folder) => ({
                    id: text(folder?.id, ''),
                    nickname: text(folder?.nickname, 'Sound folder'),
                    purpose: folder?.purpose === 'music' ? 'music' : 'sound',
                    addedAt: Number(folder?.addedAt || 0) || 0
                }))
                .filter((folder) => !!folder.id),
            portVolumes: source.portVolumes && typeof source.portVolumes === 'object' ? source.portVolumes : {},
            exposedPortedSounds: source.exposedPortedSounds && typeof source.exposedPortedSounds === 'object' ? source.exposedPortedSounds : {},
            portHotkeys: source.portHotkeys && typeof source.portHotkeys === 'object' ? source.portHotkeys : {},
            soundboardViewMode: ['backend', 'frontend'].includes(source.soundboardViewMode) ? source.soundboardViewMode : 'backend',
            soundboardGroups: Array.isArray(source.soundboardGroups)
                ? [...new Set(source.soundboardGroups.map((g) => text(g, '')).filter(Boolean))]
                : [],
            soundGroupMap: source.soundGroupMap && typeof source.soundGroupMap === 'object'
                ? Object.fromEntries(Object.entries(source.soundGroupMap)
                    .map(([k, v]) => [k, Array.isArray(v) ? [...new Set(v.map((g) => text(g, '')).filter(Boolean))] : []])
                    .filter(([, v]) => v.length))
                : {},
            activeFrontendGroup: text(source.activeFrontendGroup, ''),
            musicViewMode: ['backend', 'frontend'].includes(source.musicViewMode) ? source.musicViewMode : 'backend',
            musicPlaylists: (Array.isArray(source.musicPlaylists) ? source.musicPlaylists : [])
                .map((entry) => ({
                    id: text(entry?.id, ''),
                    url: text(entry?.url, ''),
                    playlistId: text(entry?.playlistId, ''),
                    title: text(entry?.title, 'Playlist'),
                    provider: text(entry?.provider, 'youtube'),
                    group: text(entry?.group, ''),
                    folder: text(entry?.folder, ''),
                    owner: text(entry?.owner, ''),
                    description: text(entry?.description, ''),
                    image: text(entry?.image, ''),
                    embedUrl: text(entry?.embedUrl, ''),
                    scrapeSource: text(entry?.scrapeSource, ''),
                    lastSyncedAt: Number(entry?.lastSyncedAt || 0) || 0,
                    trackCount: Number(entry?.trackCount || 0) || 0
                }))
                .filter((entry) => !!entry.id && !!entry.url),
            musicPortConnections: (Array.isArray(source.musicPortConnections) ? source.musicPortConnections : [])
                .map((entry) => ({
                    id: text(entry?.id, ''),
                    path: text(entry?.path, ''),
                    folder: text(entry?.folder, ''),
                    browserFolderId: text(entry?.browserFolderId, ''),
                    browserRootName: text(entry?.browserRootName, ''),
                    lastSyncedAt: Number(entry?.lastSyncedAt || 0) || 0,
                    trackCount: Number(entry?.trackCount || 0) || 0
                }))
                .filter((entry) => !!entry.id && !!entry.path),
            musicFolders: window.EveAudioflixStateRecovery?.folderRegistry?.(source) || [],
            musicGroups: Array.isArray(source.musicGroups)
                ? [...new Set(source.musicGroups.map((g) => text(g, '')).filter(Boolean))]
                : [],
            musicGroupMap: source.musicGroupMap && typeof source.musicGroupMap === 'object'
                ? Object.fromEntries(Object.entries(source.musicGroupMap)
                    .map(([k, v]) => [k, Array.isArray(v) ? [...new Set(v.map((g) => text(g, '')).filter(Boolean))] : []])
                    .filter(([, v]) => v.length))
                : {},
            activeFrontendMusicGroup: (legacyArtist || legacyClassifier) ? '' : legacyMusicFocus,
            activeFrontendMusicArtist: text(source.activeFrontendMusicArtist, legacyArtist),
            activeFrontendMusicClassifier: text(source.activeFrontendMusicClassifier, legacyClassifier),
            activeMusicFolderScope: text(source.activeMusicFolderScope, ''),
            soundLab: window.EveAudioflixSoundLabState?.normalize?.(source.soundLab) || {},
            // "Keep both" duplicate acknowledgements: sorted "idA|idB" pair keys left as separate items.
            dupDismissedPairs: Array.isArray(source.dupDismissedPairs) ? [...new Set(source.dupDismissedPairs.map((p) => text(p, '')).filter(Boolean))].slice(-2000) : [],
            // Manual music classifier definitions (names). Automatic classifiers are derived.
            musicClassifiers: Array.isArray(source.musicClassifiers)
                ? [...new Set(source.musicClassifiers.map((c) => text(c, '')).filter(Boolean))].slice(0, 200)
                : [],
            // Playlist/local-file health markers can independently mirror onto song cards.
            showPlaylistMarkersOnCard: source.showPlaylistMarkersOnCard === true,
            showLocalMissingMarkersOnCard: source.showLocalMissingMarkersOnCard === true,
            localizeDir: text(source.localizeDir, ''), // last folder used to save localized mp3s (reused as the prompt default)
            // Per-scope remembered localization folders; preserve them through normalize().
            localizeScopeDirs: (source.localizeScopeDirs && typeof source.localizeScopeDirs === 'object' && !Array.isArray(source.localizeScopeDirs))
                ? Object.fromEntries(Object.entries(source.localizeScopeDirs).map(([k, v]) => [text(k), text(v)]).filter(([k, v]) => k && v))
                : {},
            scopeBindings: boundedBindings(source.scopeBindings, MAX_SCOPE_BINDINGS),
            hotkeyBypassCombo: text(source.hotkeyBypassCombo, ''),
            counters: {
                plays: Number(source.counters?.plays || 0) || 0,
                routedGeminiEvents: Number(source.counters?.routedGeminiEvents || 0) || 0
            }
        };
    }

    function ensure() {
        const root = getConfigRoot();
        if (!root) {
            if (!fallbackState) {
                fallbackState = normalize(fallbackRead());
                revision += 1;
            }
            return fallbackState;
        }
        if (root === cachedRoot && root.audioflix === cachedState && cachedState) return cachedState;
        const hasDatapackState = Object.prototype.hasOwnProperty.call(root, 'audioflix'), fallback = fallbackState || fallbackRead();
        cachedRoot = root;
        cachedState = normalize(hasDatapackState ? (window.EveAudioflixStateRecovery?.prefer?.(root.audioflix, fallback, STORAGE_KEY) || root.audioflix) : fallback);
        cachedState = window.EveAudioflixStateRecovery?.restoreStructure?.(STORAGE_KEY, cachedState) || cachedState;
        root.audioflix = cachedState;
        revision += 1;
        return cachedState;
    }

    function installState(rawState) {
        const next = normalize(rawState);
        const root = getConfigRoot();
        if (root) {
            root.audioflix = next;
            cachedRoot = root;
            cachedState = next;
        } else {
            fallbackState = next;
        }
        return next;
    }

    function persistNow(reason) {
        // External loads are normalized by ensure/replaceState. Internal mutation paths already
        // preserve the schema, so a save flush must not re-clean all 10k tracks on the UI thread.
        const state = ensure();
        if (saveTimer) window.clearTimeout(saveTimer);
        saveTimer = 0;
        fallbackWrite(state); window.EveAudioflixStateRecovery?.writeStructure?.(STORAGE_KEY, state);
        if (typeof window.saveConfig === 'function') {
            window.saveConfig({
                source: reason || 'audioflix',
                meta: { skipEditHistory: true }
            });
        }
        const reasons = [...pendingSaveReasons]; pendingSaveReasons.clear();
        window.dispatchEvent(new CustomEvent('eve:audioflix-state-changed', { detail: { reason, reasons: reasons.length ? reasons : [reason] } }));
        return state;
    }

    function scheduleSave(reason) {
        const durable = ensure(); durable.durabilityRevision = window.EveAudioflixStateRecovery?.nextRevision?.(STORAGE_KEY, durable) || (Number(durable.durabilityRevision || 0) + 1); durable.durabilityUpdatedAt = Date.now(); revision += 1;
        pendingSaveReasons.add(reason);
        if (saveTimer) window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => persistNow(reason), SAVE_DELAY_MS);
    }

    function syncRootOrFallback(state) {
        const root = getConfigRoot();
        if (root) {
            root.audioflix = state;
            cachedRoot = root;
            cachedState = state;
        } else {
            fallbackState = state;
            fallbackWrite(state);
        }
        return state;
    }

    function update(patch, reason) {
        const state = ensure();
        Object.assign(state, patch || {});
        const next = syncRootOrFallback(state);
        scheduleSave(reason);
        return next;
    }

    function replaceState(rawState, reason, options = {}) {
        const next = installState(rawState), guard = window.EveAudioflixStateRecovery;
        if (options.authoritative === true) { next.durabilityRevision = guard?.nextRevision?.(STORAGE_KEY, next) || (Number(next.durabilityRevision || 0) + 1); next.durabilityUpdatedAt = Date.now(); }
        const root = getConfigRoot();
        if (window.config && typeof window.config === 'object' && window.config !== root) window.config.audioflix = next;
        fallbackWrite(next, options.authoritative === true ? { allowEmpty: true, allowDestructive: true } : undefined);
        if (options.authoritative === true) guard?.writeStructure?.(STORAGE_KEY, next, { allowEmpty: true });
        scheduleSave(reason || 'audioflix-replace');
        return next;
    }

    function replaceDatapackState(rawState, reason) {
        if (rawState && typeof rawState === 'object') return replaceState(rawState, reason, { authoritative: true });
        const current = ensure();
        return replaceState(Object.assign({}, current, {
            soundboard: [],
            music: [],
            recentPlays: [],
            ports: [],
            browserFolders: [],
            portVolumes: {},
            exposedPortedSounds: {},
            portHotkeys: {},
            soundboardGroups: [],
            soundGroupMap: {},
            activeFrontendGroup: '',
            musicGroups: [],
            musicGroupMap: {},
            musicPlaylists: [],
            musicPortConnections: [],
            musicClassifiers: [],
            dupDismissedPairs: [],
            activeFrontendMusicGroup: '',
            activeFrontendMusicArtist: '',
            activeFrontendMusicClassifier: '',
            activeMusicFolderScope: '',
            soundLab: window.EveAudioflixSoundLabState?.normalize?.({}) || {},
            localizeDir: '',
            localizeScopeDirs: {},
            scopeBindings: [],
            counters: Object.assign({}, current.counters, { plays: 0 })
        }), reason, { authoritative: true });
    }

    function addItem(type, item) {
        const state = ensure();
        const key = type === 'music' ? 'music' : 'soundboard';
        const max = type === 'music' ? MAX_MUSIC : MAX_SOUNDBOARD;
        state[key] = boundedItems([...(state[key] || []), item], type === 'music' ? 'music' : 'sound', max);
        if (type === 'music') state.musicFolders = window.EveAudioflixStateRecovery?.folderRegistry?.(state) || state.musicFolders || [];
        window.EveAudioflixStateRecovery?.applyTrackStructure?.(STORAGE_KEY, state, state[key][state[key].length - 1], type === 'music' ? 'music' : 'sound');
        const next = syncRootOrFallback(state);
        scheduleSave(`audioflix-add-${type}`);
        return next[key][next[key].length - 1];
    }

    function removeItem(type, itemId) {
        const state = ensure();
        const isMusic = type === 'music';
        const key = isMusic ? 'music' : 'soundboard';
        state[key] = (state[key] || []).filter((item) => item.id !== itemId);
        const mapKey = isMusic ? 'musicGroupMap' : 'soundGroupMap';
        if (state[mapKey] && typeof state[mapKey] === 'object') delete state[mapKey][itemId];
        state.scopeBindings = (state.scopeBindings || []).filter((binding) => !(
            binding.audioId === itemId && binding.audioType === (isMusic ? 'music' : 'sound')
        ));
        if (state.localizeScopeDirs && typeof state.localizeScopeDirs === 'object') delete state.localizeScopeDirs[`song:${itemId}`];
        state.dupDismissedPairs = (state.dupDismissedPairs || []).filter((pair) => !String(pair).split('|').includes(itemId));
        syncRootOrFallback(state);
        scheduleSave(`audioflix-remove-${type}`);
        return ensure();
    }

    function addPort(port) {
        const state = ensure();
        state.ports = [...(state.ports || []), cleanPort(port)].filter((p) => !!p.path);
        scheduleSave('audioflix-add-port');
        return state.ports[state.ports.length - 1];
    }

    function removePort(portId) {
        const state = ensure();
        state.ports = (state.ports || []).filter((p) => p.id !== portId);
        scheduleSave('audioflix-remove-port');
        return ensure();
    }

    function recordPlay(item) {
        const state = ensure();
        const played = cleanItem(item, item?.type === 'music' ? 'music' : 'sound');
        played.lastPlayedAt = Date.now();
        state.recentPlays = [...(state.recentPlays || []), {
            id: played.id,
            type: played.type,
            title: played.title,
            at: played.lastPlayedAt
        }].slice(-MAX_RECENT);
        state.counters.plays += 1;
        const listKey = played.type === 'music' ? 'music' : 'soundboard';
        state[listKey] = (state[listKey] || []).map((entry) => entry.id === played.id
            ? Object.assign({}, entry, { lastPlayedAt: played.lastPlayedAt })
            : entry);
        scheduleSave('audioflix-play');
    }

    function recordGeminiAudioEvent() {
        const state = ensure();
        state.counters.routedGeminiEvents += 1;
        scheduleSave('audioflix-gemini-audio');
    }

    function clearGeminiAudioEvents() {
        const state = ensure();
        state.counters.routedGeminiEvents = 0;
        scheduleSave('audioflix-clear-gemini-events');
        return ensure();
    }

    function setItemVolume(type, itemId, volume) {
        const state = ensure();
        const key = type === 'music' ? 'music' : 'soundboard';
        const safeVolume = normalizeVolume(volume, 1);
        if (state[key]) {
            state[key] = state[key].map(entry => entry.id === itemId ? Object.assign({}, entry, { volume: safeVolume }) : entry);
        }
        state.portVolumes = state.portVolumes || {};
        state.portVolumes[itemId] = safeVolume;
        scheduleSave('audioflix-volume');
        return ensure();
    }

    function setItemExposed(type, itemId, exposed) {
        const state = ensure();
        const key = type === 'music' ? 'music' : 'soundboard';
        if (state[key]) {
            state[key] = state[key].map(entry => entry.id === itemId ? Object.assign({}, entry, { exposed }) : entry);
        }
        state.exposedPortedSounds = state.exposedPortedSounds || {};
        state.exposedPortedSounds[itemId] = exposed;
        scheduleSave('audioflix-exposed');
        return ensure();
    }

    function setItemHotkey(type, itemId, hotkey) {
        const state = ensure();
        const key = type === 'music' ? 'music' : 'soundboard';
        if (state[key]) {
            state[key] = state[key].map(entry => entry.id === itemId ? Object.assign({}, entry, { hotkey }) : entry);
        }
        state.portHotkeys = state.portHotkeys || {};
        state.portHotkeys[itemId] = hotkey;
        scheduleSave('audioflix-hotkey');
        return ensure();
    }

    // Group + folder organization editors live in a sibling module (audioflix.state.groups.js)
    // so this store stays under the line cap; they run against the same live-state primitives.
    const groupOps = window.EveAudioflixStateGroups.create({ ensure, text, scheduleSave, syncRootOrFallback });

    window.addEventListener('pagehide', () => {
        if (saveTimer) persistNow('audioflix-pagehide');
    });

    Object.assign(ns, {
        ready: true,
        ensure,
        update,
        flush: persistNow,
        replaceState,
        replaceDatapackState,
        addItem,
        removeItem,
        addPort,
        removePort,
        recordPlay,
        recordGeminiAudioEvent,
        clearGeminiAudioEvents,
        normalizeVolume,
        setItemVolume,
        setItemExposed,
        setItemHotkey,
        ...groupOps,
        getSnapshot: function () { return JSON.parse(JSON.stringify(ensure())); },
        getRevision: function () { return revision; },
        isTextBrainMode: function () { return ensure().geminiConversationMode === 'text-brain-live-voice'; }
    });
})();
