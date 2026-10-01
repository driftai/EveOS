/**
 * Guarded persistence + structural recovery for Audioflix.
 *
 * Full fallback data remains recoverable, while a separate small structural journal records
 * topology/provenance without copying playable song URLs or media bytes.
 */
window.EveAudioflixStateRecovery = window.EveAudioflixStateRecovery || {};
(function () {
    'use strict';

    const ns = window.EveAudioflixStateRecovery;
    if (ns.ready) return;

    const QUARANTINE_SUFFIX = '.corrupt';
    const STRUCTURE_SUFFIX = '.structure-v2';
    const STRUCTURE_VERSION = 2;
    const revisionFloors = new Map();
    const text = (value) => String(value ?? '').trim();
    const clone = (value, fallback) => {
        try { return JSON.parse(JSON.stringify(value)); } catch { return fallback; }
    };
    const uniq = (values) => [...new Set((values || []).map(text).filter(Boolean))];

    function countEntries(state) {
        if (!state || typeof state !== 'object') return 0;
        return Object.values(state)
            .reduce((total, value) => total + (Array.isArray(value) ? value.length : 0), 0);
    }

    function folderRegistry(state) {
        const source = state && typeof state === 'object' ? state : {};
        return uniq([
            ...(source.musicFolders || []),
            ...(source.music || []).map((item) => item?.folder || item?.card),
            ...(source.musicPortConnections || []).map((entry) => entry?.folder),
            ...(source.musicPlaylists || []).map((entry) => entry?.folder)
        ]);
    }

    function structuralScore(state) {
        if (!state || typeof state !== 'object') return 0;
        const arrays = ['music', 'soundboard', 'ports', 'browserFolders', 'musicPortConnections',
            'musicPlaylists', 'musicGroups', 'musicFolders', 'soundboardGroups', 'musicClassifiers'];
        let score = arrays.reduce((sum, key) => sum + (Array.isArray(state[key]) ? state[key].length : 0), 0);
        score += Object.keys(state.musicGroupMap || {}).length;
        score += Object.keys(state.soundGroupMap || {}).length;
        return score;
    }

    function quarantine(key, raw) {
        if (!raw) return null;
        const slot = `${key}${QUARANTINE_SUFFIX}`;
        try {
            localStorage.setItem(slot, raw);
            console.warn(`[Audioflix] Unreadable library data preserved at "${slot}" — it was NOT deleted.`);
            return slot;
        } catch (error) {
            console.error('[Audioflix] Could not preserve unreadable library data:', error);
            return null;
        }
    }

    function read(key) {
        let raw = null;
        try { raw = localStorage.getItem(key); }
        catch { return { state: {}, damaged: true, quarantinedAt: null }; }
        if (!raw) return { state: {}, damaged: false, quarantinedAt: null };
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') return { state: parsed, damaged: false, quarantinedAt: null };
        } catch {}
        return { state: {}, damaged: true, quarantinedAt: quarantine(key, raw) };
    }

    function musicRef(item, state) {
        const folder = text(item?.folder || item?.card);
        const port = (state?.musicPortConnections || []).find((entry) => (
            folder && text(entry?.folder).toLowerCase() === folder.toLowerCase()
        ));
        return {
            id: text(item?.id),
            title: text(item?.title),
            localPath: text(item?.localPath),
            playlistId: text(item?.playlistId),
            sourceId: text(item?.sourceId),
            portConnectionId: text(port?.id),
            sourceKind: item?.isMusicPort ? 'music-port' : (item?.playlistId ? 'playlist' : 'manual'),
            folder,
            classifiers: uniq(item?.classifiers),
            groups: uniq(state?.musicGroupMap?.[item?.id] || []),
            musicPortGroup: text(item?.musicPortGroup)
        };
    }

    function captureStructure(state) {
        const source = state && typeof state === 'object' ? state : {};
        return {
            schemaVersion: STRUCTURE_VERSION,
            savedAt: Date.now(),
            durabilityRevision: Math.max(0, Number(source.durabilityRevision || 0) || 0),
            durabilityUpdatedAt: Math.max(0, Number(source.durabilityUpdatedAt || 0) || 0),
            ports: clone(source.ports || [], []),
            browserFolders: clone(source.browserFolders || [], []),
            musicPortConnections: clone(source.musicPortConnections || [], []),
            musicPlaylists: clone(source.musicPlaylists || [], []),
            soundboardGroups: uniq(source.soundboardGroups),
            musicGroups: uniq(source.musicGroups),
            musicFolders: folderRegistry(source),
            musicClassifiers: uniq(source.musicClassifiers),
            localizeScopeDirs: clone(source.localizeScopeDirs || {}, {}),
            portVolumes: clone(source.portVolumes || {}, {}),
            portHotkeys: clone(source.portHotkeys || {}, {}),
            exposedPortedSounds: clone(source.exposedPortedSounds || {}, {}),
            scopeBindings: clone(source.scopeBindings || [], []),
            soundGroupMap: clone(source.soundGroupMap || {}, {}),
            musicRefs: (source.music || []).map((item) => musicRef(item, source))
                .filter((ref) => ref.id && (ref.localPath || ref.sourceId || ref.folder
                    || ref.groups.length || ref.classifiers.length || ref.musicPortGroup))
        };
    }

    function writeStructure(key, state) {
        const slot = `${key}${STRUCTURE_SUFFIX}`;
        const structure = captureStructure(state);
        try {
            localStorage.setItem(slot, JSON.stringify(structure));
            return { written: true, slot, structure };
        } catch (error) {
            console.warn('[Audioflix] structural recovery write failed:', error);
            return { written: false, slot, structure, reason: String(error?.message || error) };
        }
    }

    function readStructure(key) {
        const slot = `${key}${STRUCTURE_SUFFIX}`;
        try {
            const raw = localStorage.getItem(slot);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch {
            return null;
        }
    }

    function mergeNamed(base, incoming, identity) {
        const out = Array.isArray(base) ? clone(base, []) : [];
        const seen = new Set(out.map((entry) => identity(entry)));
        (Array.isArray(incoming) ? incoming : []).forEach((entry) => {
            const key = identity(entry);
            if (!key || seen.has(key)) return;
            seen.add(key);
            out.push(clone(entry, entry));
        });
        return out;
    }

    function findMusic(items, ref) {
        if (ref.id) {
            const exact = items.find((item) => text(item?.id) === ref.id);
            if (exact) return exact;
        }
        if (ref.localPath) {
            const path = ref.localPath.toLowerCase();
            const exact = items.find((item) => text(item?.localPath).toLowerCase() === path);
            if (exact) return exact;
        }
        if (ref.playlistId && ref.sourceId) {
            const exact = items.find((item) => (
                text(item?.playlistId) === ref.playlistId && text(item?.sourceId) === ref.sourceId
            ));
            if (exact) return exact;
        }
        return null;
    }

    function applyStructureSnapshot(state, structure) {
        if (!state || typeof state !== 'object' || !structure || typeof structure !== 'object') return state;
        state.ports = mergeNamed(state.ports, structure.ports, (entry) => text(entry?.id || entry?.path).toLowerCase());
        state.browserFolders = mergeNamed(state.browserFolders, structure.browserFolders, (entry) => text(entry?.id).toLowerCase());
        state.musicPortConnections = mergeNamed(state.musicPortConnections, structure.musicPortConnections,
            (entry) => text(entry?.id || entry?.folder || entry?.path).toLowerCase());
        state.musicPlaylists = mergeNamed(state.musicPlaylists, structure.musicPlaylists,
            (entry) => text(entry?.id || entry?.url).toLowerCase());
        state.soundboardGroups = uniq([...(state.soundboardGroups || []), ...(structure.soundboardGroups || [])]);
        state.musicGroups = uniq([...(state.musicGroups || []), ...(structure.musicGroups || [])]);
        state.musicFolders = uniq([...(state.musicFolders || []), ...(structure.musicFolders || [])]);
        state.musicClassifiers = uniq([...(state.musicClassifiers || []), ...(structure.musicClassifiers || [])]);
        state.localizeScopeDirs = { ...(structure.localizeScopeDirs || {}), ...(state.localizeScopeDirs || {}) };
        state.portVolumes = { ...(structure.portVolumes || {}), ...(state.portVolumes || {}) };
        state.portHotkeys = { ...(structure.portHotkeys || {}), ...(state.portHotkeys || {}) };
        state.exposedPortedSounds = { ...(structure.exposedPortedSounds || {}), ...(state.exposedPortedSounds || {}) };
        state.soundGroupMap = { ...(structure.soundGroupMap || {}), ...(state.soundGroupMap || {}) };
        state.musicGroupMap = state.musicGroupMap || {};

        const music = Array.isArray(state.music) ? state.music : [];
        const idRemap = new Map();
        (structure.musicRefs || []).forEach((ref) => {
            const match = findMusic(music, ref);
            if (!match?.id) return;
            if (ref.id) idRemap.set(ref.id, match.id);
            const groups = uniq([...(state.musicGroupMap[match.id] || []), ...(ref.groups || [])]);
            if (groups.length) state.musicGroupMap[match.id] = groups;
            state.musicGroups = uniq([...(state.musicGroups || []), ...groups]);
            match.classifiers = uniq([...(match.classifiers || []), ...(ref.classifiers || [])]);
            state.musicClassifiers = uniq([...(state.musicClassifiers || []), ...(ref.classifiers || [])]);
            if (!text(match.folder || match.card) && ref.folder) match.folder = match.card = ref.folder;
            if (!text(match.musicPortGroup) && ref.musicPortGroup) match.musicPortGroup = ref.musicPortGroup;
        });

        state.scopeBindings = (state.scopeBindings || []).map((binding) => {
            const remapped = idRemap.get(text(binding?.audioId));
            return remapped ? { ...binding, audioId: remapped } : binding;
        });
        const bindings = (structure.scopeBindings || []).map((binding) => {
            const next = clone(binding, binding);
            const remapped = idRemap.get(text(next?.audioId));
            if (remapped) next.audioId = remapped;
            return next;
        });
        state.scopeBindings = mergeNamed(state.scopeBindings, bindings, (entry) => [
            text(entry?.audioType), text(entry?.audioId), text(entry?.scopeType), text(entry?.workspaceId),
            text(entry?.categoryName), text(entry?.folderId), text(entry?.bookmarkId)
        ].join('::').toLowerCase());
        state.musicFolders = folderRegistry(state);
        return state;
    }

    function restoreStructure(key, state) {
        const structure = readStructure(key);
        if (!structure) return state;
        const target = clone(state && typeof state === 'object' ? state : {}, {});
        return applyStructureSnapshot(target, structure);
    }

    function applyTrackStructure(key, state, item, type) {
        if (!state || !item?.id) return false;
        const structure = readStructure(key);
        if (!structure) return false;
        if (type === 'sound') {
            const groups = structure.soundGroupMap?.[item.id] || [];
            if (!groups.length) return false;
            state.soundGroupMap = state.soundGroupMap || {};
            state.soundGroupMap[item.id] = uniq([...(state.soundGroupMap[item.id] || []), ...groups]);
            state.soundboardGroups = uniq([...(state.soundboardGroups || []), ...groups]);
            return true;
        }
        const ref = (structure.musicRefs || []).find((entry) => (
            (entry.id && entry.id === item.id)
            || (entry.localPath && text(item.localPath).toLowerCase() === entry.localPath.toLowerCase())
            || (entry.playlistId && entry.sourceId
                && text(item.playlistId) === entry.playlistId && text(item.sourceId) === entry.sourceId)
        ));
        if (!ref) return false;
        const synthetic = {
            ...structure,
            musicRefs: [ref],
            scopeBindings: (structure.scopeBindings || []).filter((binding) => text(binding?.audioId) === ref.id)
        };
        applyStructureSnapshot(state, synthetic);
        return true;
    }

    function prefer(primary, fallback, key = '') {
        const root = primary && typeof primary === 'object' ? primary : {};
        const mirror = fallback && typeof fallback === 'object' ? fallback : {};
        const rootRev = Math.max(0, Number(root.durabilityRevision || 0) || 0);
        const mirrorRev = Math.max(0, Number(mirror.durabilityRevision || 0) || 0);
        if (key) revisionFloors.set(key, Math.max(Number(revisionFloors.get(key) || 0), rootRev, mirrorRev));
        // A core-config snapshot with no music must never outrank a populated Audioflix
        // mirror merely because an unrelated config save observed a newer revision number. A
        // deliberate full clear writes the fallback immediately too, so a richer fallback here is
        // evidence of an incomplete/partial rollback, not an intentional empty library.
        const rootMusic = Array.isArray(root.music) ? root.music.length : 0;
        const mirrorMusic = Array.isArray(mirror.music) ? mirror.music.length : 0;
        if (rootMusic === 0 && mirrorMusic > 0 && structuralScore(mirror) > structuralScore(root)) return mirror;
        if (mirrorRev > rootRev) return mirror;
        if (rootRev > mirrorRev) return root;
        const rootTime = Math.max(0, Number(root.durabilityUpdatedAt || 0) || 0);
        const mirrorTime = Math.max(0, Number(mirror.durabilityUpdatedAt || 0) || 0);
        if (mirrorTime > rootTime) return mirror;
        if (rootTime > mirrorTime) return root;
        const rootScore = structuralScore(root);
        const mirrorScore = structuralScore(mirror);
        if ((rootRev > 0 || mirrorRev > 0) && mirrorScore > rootScore) return mirror;
        if (!rootRev && !mirrorRev && (root.music || []).length === 0 && (mirror.music || []).length > 0
            && mirrorScore > rootScore) return mirror;
        return root;
    }

    function nextRevision(key, state) {
        let floor = Number(revisionFloors.get(key) || 0);
        if (!revisionFloors.has(key)) {
            const fallback = read(key).state || {};
            const structure = readStructure(key) || {};
            floor = Math.max(
                floor,
                Number(fallback?.durabilityRevision || 0) || 0,
                Number(structure?.durabilityRevision || 0) || 0
            );
        }
        const next = Math.max(floor, Number(state?.durabilityRevision || 0) || 0) + 1;
        revisionFloors.set(key, next);
        return next;
    }

    function write(key, state, options = {}) {
        const incoming = countEntries(state);
        const existing = read(key);
        if (incoming === 0 && options.allowEmpty !== true) {
            if (existing.damaged) return { written: false, reason: 'stored data is unreadable; refusing to overwrite it' };
            if (countEntries(existing.state) > 0) {
                console.warn('[Audioflix] Refused to save an empty library over populated stored data.');
                return { written: false, reason: 'empty state would have replaced stored entries' };
            }
        }

        const existingRev = Math.max(0, Number(existing.state?.durabilityRevision || 0) || 0);
        const incomingRev = Math.max(0, Number(state?.durabilityRevision || 0) || 0);
        if (options.allowDestructive !== true && existingRev > 0 && incomingRev <= existingRev
            && structuralScore(state) < structuralScore(existing.state)
            && (existing.state?.music || []).length > (state?.music || []).length) {
            console.warn('[Audioflix] Refused a stale partial rollback over richer music structure.');
            return { written: false, reason: 'stale state would have rolled back richer music structure' };
        }

        // The small journal is written first so topology can survive even if the large state hits quota.
        writeStructure(key, state);
        try {
            localStorage.setItem(key, JSON.stringify(state));
            revisionFloors.set(key, Math.max(
                Number(revisionFloors.get(key) || 0),
                Number(state?.durabilityRevision || 0) || 0
            ));
            return { written: true, reason: '' };
        } catch (error) {
            console.warn('[Audioflix] library write failed:', error);
            return { written: false, reason: String(error?.message || error) };
        }
    }

    Object.assign(ns, {
        ready: true,
        read,
        write,
        countEntries,
        captureStructure,
        snapshotStructure: captureStructure,
        writeStructure,
        readStructure,
        applyStructureSnapshot,
        restoreStructure,
        applyTrackStructure,
        prefer,
        nextRevision,
        folderRegistry,
        STRUCTURE_SUFFIX,
        STRUCTURE_VERSION,
        QUARANTINE_SUFFIX
    });
})();