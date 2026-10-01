/**
 * Guarded persistence + structural recovery for the Audioflix library.
 *
 * The full fallback remains the authoritative emergency copy. A second, deliberately smaller
 * structural shadow records where the library came from and how it was organized without copying
 * media bytes: ports, folders, playlist/port connections, groups/classifiers and membership anchors.
 * This gives Audioflix something useful to rebuild from even if a large state/config write is lost.
 */
window.EveAudioflixStateRecovery = window.EveAudioflixStateRecovery || {};
(function () {
    'use strict';

    const ns = window.EveAudioflixStateRecovery;
    if (ns.ready) return;

    const QUARANTINE_SUFFIX = '.corrupt';
    const STRUCTURE_SUFFIX = '.structure-v2';
    const STRUCTURE_VERSION = 2;
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

    function persistenceTime(state) {
        return Math.max(
            0,
            Number(state?.durabilityUpdatedAt || 0) || 0,
            Number(state?.persistence?.savedAt || 0) || 0
        );
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

    function itemAnchor(item, groups = []) {
        return {
            id: text(item?.id),
            title: text(item?.title),
            localPath: text(item?.localPath),
            playlistId: text(item?.playlistId),
            sourceId: text(item?.sourceId),
            folder: text(item?.folder || item?.card),
            groups: uniq(groups),
            classifiers: uniq(item?.classifiers),
            musicPortGroup: text(item?.musicPortGroup)
        };
    }

    function snapshotStructure(state) {
        const source = state && typeof state === 'object' ? state : {};
        const music = Array.isArray(source.music) ? source.music : [];
        const soundboard = Array.isArray(source.soundboard) ? source.soundboard : [];
        const musicFolders = folderRegistry(source);
        return {
            schemaVersion: STRUCTURE_VERSION,
            savedAt: Date.now(),
            ports: clone(source.ports || [], []),
            browserFolders: clone(source.browserFolders || [], []),
            musicPortConnections: clone(source.musicPortConnections || [], []),
            musicPlaylists: clone(source.musicPlaylists || [], []),
            soundboardGroups: uniq(source.soundboardGroups),
            musicGroups: uniq(source.musicGroups),
            musicFolders,
            musicClassifiers: uniq(source.musicClassifiers),
            localizeScopeDirs: clone(source.localizeScopeDirs || {}, {}),
            soundGroupMap: clone(source.soundGroupMap || {}, {}),
            musicMemberships: music.map((item) => itemAnchor(item, source.musicGroupMap?.[item.id] || []))
                .filter((entry) => entry.id && (entry.folder || entry.groups.length || entry.classifiers.length
                    || entry.musicPortGroup || entry.localPath || entry.sourceId)),
            soundMemberships: soundboard.map((item) => ({
                id: text(item?.id),
                title: text(item?.title),
                groups: uniq(source.soundGroupMap?.[item?.id] || [])
            })).filter((entry) => entry.id && entry.groups.length)
        };
    }

    function writeStructure(key, state) {
        const slot = `${key}${STRUCTURE_SUFFIX}`;
        const structure = snapshotStructure(state);
        try {
            structure.durabilityRevision = Math.max(0, Number(state?.durabilityRevision || 0) || 0);
            structure.durabilityUpdatedAt = Math.max(0, Number(state?.durabilityUpdatedAt || 0) || Date.now());
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
            if (!raw) return { state: null, damaged: false, slot };
            const parsed = JSON.parse(raw);
            return {
                state: parsed && typeof parsed === 'object' ? parsed : null,
                damaged: !(parsed && typeof parsed === 'object'),
                slot
            };
        } catch {
            return { state: null, damaged: true, slot };
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

    function findMusic(items, anchor) {
        const by = (predicate) => items.find((item) => predicate(item)) || null;
        if (anchor.id) {
            const exact = by((item) => text(item?.id) === anchor.id);
            if (exact) return exact;
        }
        if (anchor.localPath) {
            const exact = by((item) => text(item?.localPath).toLowerCase() === anchor.localPath.toLowerCase());
            if (exact) return exact;
        }
        if (anchor.playlistId && anchor.sourceId) {
            const exact = by((item) => text(item?.playlistId) === anchor.playlistId && text(item?.sourceId) === anchor.sourceId);
            if (exact) return exact;
        }
        return null;
    }

    function mergeStructure(rawState, structure) {
        const state = clone(rawState && typeof rawState === 'object' ? rawState : {}, {});
        const shadow = structure && typeof structure === 'object' ? structure : null;
        if (!shadow) return state;

        state.ports = mergeNamed(state.ports, shadow.ports, (entry) => text(entry?.id || entry?.path).toLowerCase());
        state.browserFolders = mergeNamed(state.browserFolders, shadow.browserFolders, (entry) => text(entry?.id).toLowerCase());
        state.musicPortConnections = mergeNamed(state.musicPortConnections, shadow.musicPortConnections,
            (entry) => text(entry?.id || entry?.folder || entry?.path).toLowerCase());
        state.musicPlaylists = mergeNamed(state.musicPlaylists, shadow.musicPlaylists,
            (entry) => text(entry?.id || entry?.url).toLowerCase());
        state.soundboardGroups = uniq([...(state.soundboardGroups || []), ...(shadow.soundboardGroups || [])]);
        state.musicGroups = uniq([...(state.musicGroups || []), ...(shadow.musicGroups || [])]);
        state.musicFolders = uniq([...(state.musicFolders || []), ...(shadow.musicFolders || [])]);
        state.musicClassifiers = uniq([...(state.musicClassifiers || []), ...(shadow.musicClassifiers || [])]);
        state.localizeScopeDirs = { ...(shadow.localizeScopeDirs || {}), ...(state.localizeScopeDirs || {}) };
        state.soundGroupMap = { ...(shadow.soundGroupMap || {}), ...(state.soundGroupMap || {}) };
        state.musicGroupMap = { ...(state.musicGroupMap || {}) };

        const music = Array.isArray(state.music) ? state.music : [];
        (shadow.musicMemberships || []).forEach((anchor) => {
            const match = findMusic(music, anchor);
            if (!match?.id) return;
            const groups = uniq([...(state.musicGroupMap[match.id] || []), ...(anchor.groups || [])]);
            if (groups.length) state.musicGroupMap[match.id] = groups;
            if (!text(match.folder || match.card) && anchor.folder) {
                match.folder = anchor.folder;
                match.card = anchor.folder;
            }
            match.classifiers = uniq([...(match.classifiers || []), ...(anchor.classifiers || [])]);
            if (!text(match.musicPortGroup) && anchor.musicPortGroup) match.musicPortGroup = anchor.musicPortGroup;
        });
        (shadow.soundMemberships || []).forEach((anchor) => {
            if (!anchor?.id) return;
            const groups = uniq([...(state.soundGroupMap[anchor.id] || []), ...(anchor.groups || [])]);
            if (groups.length) state.soundGroupMap[anchor.id] = groups;
        });
        return state;
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

    function chooseInitial(key, datapackState, fallbackState) {
        const root = datapackState && typeof datapackState === 'object' ? datapackState : {};
        const fallback = fallbackState && typeof fallbackState === 'object' ? fallbackState : {};
        const rootTime = persistenceTime(root);
        const fallbackTime = persistenceTime(fallback);
        const rootScore = structuralScore(root);
        const fallbackScore = structuralScore(fallback);
        let state = root;
        let source = 'config';

        if (fallbackTime > rootTime) {
            state = fallback;
            source = 'fallback-newer';
        } else if (!rootTime && !fallbackTime && fallbackScore > 0 && rootScore === 0) {
            state = fallback;
            source = 'fallback-migration';
        } else if (!rootTime && !fallbackTime
            && (root.music || []).length === 0 && (fallback.music || []).length > 0
            && fallbackScore > rootScore) {
            state = fallback;
            source = 'fallback-music-recovery';
        }

        const structural = readStructure(key).state;
        const before = structuralScore(state);
        state = mergeStructure(state, structural);
        const structureRecovered = structuralScore(state) > before;
        if (source !== 'config' || structureRecovered) {
            console.warn('[Audioflix] recovered durable state', { source, structureRecovered });
        }
        return { state, source, structureRecovered };
    }

    function prefer(datapackState, fallbackState, key) {
        const root = datapackState && typeof datapackState === 'object' ? datapackState : {};
        const fallback = fallbackState && typeof fallbackState === 'object' ? fallbackState : {};
        const rootTime = persistenceTime(root);
        const fallbackTime = persistenceTime(fallback);
        const rootScore = structuralScore(root);
        const fallbackScore = structuralScore(fallback);
        if (fallbackTime > rootTime) return fallback;
        if (!rootTime && !fallbackTime && fallbackScore > 0 && rootScore === 0) return fallback;
        if (!rootTime && !fallbackTime
            && (root.music || []).length === 0 && (fallback.music || []).length > 0
            && fallbackScore > rootScore) return fallback;
        return root;
    }

    function restoreStructure(key, state) {
        const shadow = readStructure(key).state;
        if (!shadow) return state;
        const before = structuralScore(state);
        const merged = mergeStructure(state, shadow);
        if (structuralScore(merged) > before) {
            console.warn('[Audioflix] restored library structure from the recovery ledger.');
        }
        return merged;
    }

    function nextRevision(key, state) {
        const fallback = read(key).state || {};
        const structure = readStructure(key).state || {};
        return Math.max(
            0,
            Number(state?.durabilityRevision || 0) || 0,
            Number(fallback?.durabilityRevision || 0) || 0,
            Number(structure?.durabilityRevision || 0) || 0
        ) + 1;
    }

    function applyTrackStructure(key, state, item, type) {
        if (!state || !item?.id) return false;
        const shadow = readStructure(key).state;
        if (!shadow) return false;
        if (type === 'sound') {
            const anchor = (shadow.soundMemberships || []).find((entry) => entry.id === item.id);
            if (!anchor?.groups?.length) return false;
            state.soundGroupMap = state.soundGroupMap || {};
            state.soundGroupMap[item.id] = uniq([...(state.soundGroupMap[item.id] || []), ...anchor.groups]);
            state.soundboardGroups = uniq([...(state.soundboardGroups || []), ...anchor.groups]);
            return true;
        }
        const anchor = (shadow.musicMemberships || []).find((entry) => {
            if (entry.id && entry.id === item.id) return true;
            if (entry.localPath && text(item.localPath).toLowerCase() === entry.localPath.toLowerCase()) return true;
            return entry.playlistId && entry.sourceId
                && text(item.playlistId) === entry.playlistId
                && text(item.sourceId) === entry.sourceId;
        });
        if (!anchor) return false;
        state.musicGroupMap = state.musicGroupMap || {};
        const groups = uniq([...(state.musicGroupMap[item.id] || []), ...(anchor.groups || [])]);
        if (groups.length) state.musicGroupMap[item.id] = groups;
        state.musicGroups = uniq([...(state.musicGroups || []), ...groups]);
        item.classifiers = uniq([...(item.classifiers || []), ...(anchor.classifiers || [])]);
        state.musicClassifiers = uniq([...(state.musicClassifiers || []), ...(anchor.classifiers || [])]);
        if (!text(item.folder || item.card) && anchor.folder) item.folder = item.card = anchor.folder;
        if (!text(item.musicPortGroup) && anchor.musicPortGroup) item.musicPortGroup = anchor.musicPortGroup;
        state.musicFolders = folderRegistry(state);
        return true;
    }

    function write(key, state, options = {}) {
        const incoming = countEntries(state);
        if (incoming === 0 && options.allowEmpty !== true) {
            const existing = read(key);
            if (existing.damaged) return { written: false, reason: 'stored data is unreadable; refusing to overwrite it' };
            if (countEntries(existing.state) > 0) {
                console.warn('[Audioflix] Refused to save an empty library over populated stored data.');
                return { written: false, reason: 'empty state would have replaced stored entries' };
            }
        }
        // Save the smaller structural ledger first. If a large JSON write later hits quota, the
        // source/organization map still has a chance to survive.
        writeStructure(key, state);
        try {
            localStorage.setItem(key, JSON.stringify(state));
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
        snapshotStructure,
        readStructure,
        writeStructure,
        mergeStructure,
        chooseInitial,
        prefer,
        restoreStructure,
        nextRevision,
        folderRegistry,
        applyTrackStructure,
        STRUCTURE_SUFFIX,
        STRUCTURE_VERSION,
        QUARANTINE_SUFFIX
    });
})();