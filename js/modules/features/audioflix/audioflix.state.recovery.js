/**
 * Guarded persistence + structural recovery for the Audioflix library.
 *
 * Full Audioflix state is still stored normally, but a second small structural journal keeps the
 * organization graph (groups, folders, ports, playlist/source connections and per-track labels)
 * without copying playable media URLs or audio bytes. It is intentionally independent from the
 * monolithic EveOS config so a stale/partial config rollback cannot silently erase the topology.
 */
window.EveAudioflixStateRecovery = window.EveAudioflixStateRecovery || {};
(function () {
    'use strict';

    const ns = window.EveAudioflixStateRecovery;
    if (ns.ready) return;

    const QUARANTINE_SUFFIX = '.corrupt';
    const STRUCTURE_SUFFIX = '.structure.v2';
    const STRUCTURE_PREV_SUFFIX = '.structure.prev.v2';

    const text = (value) => String(value ?? '').trim();
    const list = (value) => Array.isArray(value) ? value : [];
    const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const unique = (values) => [...new Set(list(values).map(text).filter(Boolean))];
    const revisionOf = (state) => Math.max(0, Number(state?.durabilityRevision || 0) || 0);

    function countEntries(state) {
        if (!state || typeof state !== 'object') return 0;
        return Object.values(state)
            .reduce((total, value) => total + (Array.isArray(value) ? value.length : 0), 0);
    }

    function mapEdges(map) {
        return Object.values(object(map)).reduce((total, value) => total + list(value).length, 0);
    }

    function folderRegistry(state) {
        const source = object(state);
        return unique([
            ...list(source.musicFolders),
            ...list(source.music).map((item) => item?.folder || item?.card),
            ...list(source.musicPortConnections).map((entry) => entry?.folder),
            ...list(source.musicPlaylists).map((entry) => entry?.folder)
        ]);
    }

    function structuralStats(state) {
        const source = object(state);
        const music = list(source.music).length;
        const sounds = list(source.soundboard).length;
        const musicGroups = unique(source.musicGroups).length;
        const soundGroups = unique(source.soundboardGroups).length;
        const folders = folderRegistry(source).length;
        const ports = list(source.ports).length + list(source.browserFolders).length;
        const sources = list(source.musicPortConnections).length + list(source.musicPlaylists).length;
        const labels = unique(source.musicClassifiers).length
            + mapEdges(source.musicGroupMap) + mapEdges(source.soundGroupMap)
            + Object.keys(object(source.localizeScopeDirs)).length;
        const bindings = list(source.scopeBindings).length;
        const score = music + sounds + musicGroups + soundGroups + folders + ports + sources + labels + bindings;
        return { music, sounds, musicGroups, soundGroups, folders, ports, sources, labels, bindings, score };
    }

    function catastrophicLoss(incoming, existing) {
        const next = structuralStats(incoming);
        const prev = structuralStats(existing);
        if (!prev.score || next.score >= prev.score) return false;
        const lostMusic = prev.music > 0 && next.music === 0;
        const lostSources = prev.sources > 0 && next.sources === 0;
        const lostFolders = prev.folders > 0 && next.folders === 0;
        const lostMusicGroups = prev.musicGroups > 0 && next.musicGroups === 0;
        const largeDrop = next.score + Math.max(5, Math.ceil(prev.score * 0.25)) < prev.score;
        return lostMusic || (largeDrop && (lostSources || lostFolders || lostMusicGroups));
    }

    function safeRecord(entry, fields) {
        const out = {};
        fields.forEach((field) => {
            const value = entry?.[field];
            if (value === undefined || value === null || value === '') return;
            if (Array.isArray(value)) out[field] = value.map((item) => (
                item && typeof item === 'object' ? { ...item } : item
            ));
            else if (value && typeof value === 'object') out[field] = { ...value };
            else out[field] = value;
        });
        return out;
    }

    function trackRef(item, groups, type) {
        const fields = type === 'music'
            ? ['id', 'title', 'artist', 'sourceProvider', 'sourceId', 'playlistId', 'localPath',
                'folder', 'card', 'classifiers', 'isMusicPort', 'musicPortGroup']
            : ['id', 'title', 'category', 'localPath'];
        const ref = safeRecord(item, fields);
        const membership = unique(groups);
        if (membership.length) ref.groups = membership;
        return ref;
    }

    function captureStructure(state) {
        const source = object(state);
        const snapshot = {
            schemaVersion: 2,
            durabilityRevision: revisionOf(source),
            savedAt: Date.now(),
            musicGroups: unique(source.musicGroups),
            soundboardGroups: unique(source.soundboardGroups),
            musicFolders: folderRegistry(source),
            musicClassifiers: unique(source.musicClassifiers),
            ports: list(source.ports).map((entry) => safeRecord(entry, ['id', 'nickname', 'path'])),
            browserFolders: list(source.browserFolders).map((entry) => safeRecord(entry, ['id', 'nickname', 'purpose', 'addedAt'])),
            musicPortConnections: list(source.musicPortConnections).map((entry) => safeRecord(entry,
                ['id', 'path', 'folder', 'browserFolderId', 'browserRootName', 'lastSyncedAt', 'trackCount'])),
            musicPlaylists: list(source.musicPlaylists).map((entry) => safeRecord(entry,
                ['id', 'url', 'playlistId', 'title', 'provider', 'group', 'folder', 'owner',
                    'description', 'image', 'embedUrl', 'scrapeSource', 'lastSyncedAt', 'trackCount'])),
            localizeScopeDirs: { ...object(source.localizeScopeDirs) },
            musicRefs: list(source.music).map((item) => trackRef(item, object(source.musicGroupMap)[item?.id], 'music')),
            soundRefs: list(source.soundboard).map((item) => trackRef(item, object(source.soundGroupMap)[item?.id], 'sound'))
        };
        snapshot.counts = structuralStats(source);
        return snapshot;
    }

    function readJsonSlot(slot) {
        try {
            const raw = localStorage.getItem(slot);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch {
            return null;
        }
    }

    function readStructure(key) {
        const slots = [readJsonSlot(`${key}${STRUCTURE_SUFFIX}`), readJsonSlot(`${key}${STRUCTURE_PREV_SUFFIX}`)]
            .filter(Boolean);
        if (!slots.length) return null;
        slots.sort((a, b) => {
            const rev = revisionOf(b) - revisionOf(a);
            if (rev) return rev;
            return Number(b.savedAt || 0) - Number(a.savedAt || 0);
        });
        return slots[0];
    }

    function structureComparable(snapshot) {
        if (!snapshot) return '';
        // Playback counters advance the full-state durability revision. Do not rewrite this small
        // topology journal unless the topology itself changed.
        const copy = { ...snapshot, durabilityRevision: 0, savedAt: 0, counts: undefined };
        return JSON.stringify(copy);
    }

    function writeStructure(key, state, options = {}) {
        const snapshot = captureStructure(state);
        const currentSlot = `${key}${STRUCTURE_SUFFIX}`;
        const previousSlot = `${key}${STRUCTURE_PREV_SUFFIX}`;
        const current = readJsonSlot(currentSlot);
        if (current && structureComparable(current) === structureComparable(snapshot)) return { written: false, reason: 'unchanged' };
        if (options.allowEmpty !== true && current && Number(current?.counts?.score || 0) > 0 && Number(snapshot?.counts?.score || 0) === 0) {
            return { written: false, reason: 'preserving non-empty structural journal' };
        }
        try {
            const previousRaw = localStorage.getItem(currentSlot);
            if (previousRaw) localStorage.setItem(previousSlot, previousRaw);
            localStorage.setItem(currentSlot, JSON.stringify(snapshot));
            return { written: true, reason: '' };
        } catch (error) {
            console.warn('[Audioflix] structural recovery journal write failed:', error);
            return { written: false, reason: String(error?.message || error) };
        }
    }

    function recordKey(entry, kind) {
        if (!entry || typeof entry !== 'object') return '';
        if (kind === 'port') return text(entry.id) || text(entry.path).toLowerCase();
        if (kind === 'browser') return text(entry.id);
        if (kind === 'playlist') return text(entry.id) || `${text(entry.provider)}|${text(entry.playlistId) || text(entry.url)}`;
        if (kind === 'music-port') return text(entry.id) || `${text(entry.path).toLowerCase()}|${text(entry.folder).toLowerCase()}`;
        return text(entry.id);
    }

    function mergeRecords(current, saved, kind) {
        const out = list(current).map((entry) => ({ ...entry }));
        const keys = new Set(out.map((entry) => recordKey(entry, kind)).filter(Boolean));
        list(saved).forEach((entry) => {
            const key = recordKey(entry, kind);
            if (!key || keys.has(key)) return;
            out.push({ ...entry });
            keys.add(key);
        });
        return out;
    }

    function refForTrack(item, refs) {
        const candidates = list(refs);
        const id = text(item?.id);
        if (id) {
            const hit = candidates.find((ref) => text(ref?.id) === id);
            if (hit) return hit;
        }
        const sourceId = text(item?.sourceId), playlistId = text(item?.playlistId);
        if (sourceId) {
            const hit = candidates.find((ref) => text(ref?.sourceId) === sourceId
                && (!playlistId || !text(ref?.playlistId) || text(ref?.playlistId) === playlistId));
            if (hit) return hit;
        }
        const localPath = text(item?.localPath).toLowerCase();
        if (localPath) {
            const hit = candidates.find((ref) => text(ref?.localPath).toLowerCase() === localPath);
            if (hit) return hit;
        }
        return null;
    }

    function applyTrackStructure(state, snapshot, item, type) {
        if (!state || !item || !snapshot) return false;
        const refs = type === 'music' ? snapshot.musicRefs : snapshot.soundRefs;
        const ref = refForTrack(item, refs);
        if (!ref) return false;
        let changed = false;
        if (type === 'music') {
            if (!text(item.folder || item.card) && text(ref.folder || ref.card)) {
                item.folder = text(ref.folder || ref.card);
                item.card = item.folder;
                changed = true;
            }
            const classifiers = unique([...(item.classifiers || []), ...(ref.classifiers || [])]);
            if (classifiers.join('\\u0001') !== unique(item.classifiers).join('\\u0001')) {
                item.classifiers = classifiers;
                changed = true;
            }
            const groups = unique([...(object(state.musicGroupMap)[item.id] || []), ...(ref.groups || [])]);
            state.musicGroupMap = object(state.musicGroupMap);
            if (groups.length) state.musicGroupMap[item.id] = groups;
            state.musicGroups = unique([...(state.musicGroups || []), ...groups]);
        } else {
            const groups = unique([...(object(state.soundGroupMap)[item.id] || []), ...(ref.groups || [])]);
            state.soundGroupMap = object(state.soundGroupMap);
            if (groups.length) state.soundGroupMap[item.id] = groups;
            state.soundboardGroups = unique([...(state.soundboardGroups || []), ...groups]);
        }
        return changed;
    }

    function applyStructureSnapshot(state, snapshot) {
        if (!state || !snapshot) return state;
        state.musicGroups = unique([...(state.musicGroups || []), ...(snapshot.musicGroups || [])]);
        state.soundboardGroups = unique([...(state.soundboardGroups || []), ...(snapshot.soundboardGroups || [])]);
        state.musicFolders = unique([...(state.musicFolders || []), ...(snapshot.musicFolders || []), ...folderRegistry(state)]);
        state.musicClassifiers = unique([...(state.musicClassifiers || []), ...(snapshot.musicClassifiers || [])]).slice(0, 200);
        state.ports = mergeRecords(state.ports, snapshot.ports, 'port');
        state.browserFolders = mergeRecords(state.browserFolders, snapshot.browserFolders, 'browser');
        state.musicPortConnections = mergeRecords(state.musicPortConnections, snapshot.musicPortConnections, 'music-port');
        state.musicPlaylists = mergeRecords(state.musicPlaylists, snapshot.musicPlaylists, 'playlist');
        state.localizeScopeDirs = { ...object(snapshot.localizeScopeDirs), ...object(state.localizeScopeDirs) };
        list(state.music).forEach((item) => applyTrackStructure(state, snapshot, item, 'music'));
        list(state.soundboard).forEach((item) => applyTrackStructure(state, snapshot, item, 'sound'));
        return state;
    }

    function restoreStructure(key, state) {
        const snapshot = readStructure(key);
        if (!snapshot) {
            state.musicFolders = folderRegistry(state);
            return state;
        }
        const stateRev = revisionOf(state), shadowRev = revisionOf(snapshot);
        const current = structuralStats(state), savedScore = Number(snapshot?.counts?.score || 0);
        const legacyCatastrophe = !stateRev && !shadowRev && savedScore > current.score
            && (current.music === 0 || current.sources === 0 || current.folders === 0);
        if (shadowRev > stateRev || legacyCatastrophe) {
            console.warn('[Audioflix] Recovering structural metadata from the durability journal.');
            applyStructureSnapshot(state, snapshot);
        } else {
            state.musicFolders = folderRegistry(state);
        }
        return state;
    }

    function prefer(primary, fallback, key) {
        const main = object(primary), mirror = object(fallback);
        const mainRev = revisionOf(main), mirrorRev = revisionOf(mirror);
        if (mirrorRev > mainRev) {
            console.warn('[Audioflix] Newer fallback state won over an older config snapshot.');
            return mirror;
        }
        if (mainRev > mirrorRev) return main;
        if (catastrophicLoss(main, mirror)) {
            console.warn('[Audioflix] Fallback state prevented a catastrophic partial Audioflix rollback.');
            return mirror;
        }
        const shadow = readStructure(key);
        if (shadow && revisionOf(shadow) > mainRev && structuralStats(mirror).score > structuralStats(main).score) return mirror;
        return main;
    }

    function nextRevision(key, state) {
        const stored = read(key);
        const shadow = readStructure(key);
        return Math.max(revisionOf(state), revisionOf(stored.state), revisionOf(shadow)) + 1;
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
        try {
            raw = localStorage.getItem(key);
        } catch {
            return { state: {}, damaged: true, quarantinedAt: null };
        }
        if (!raw) return { state: {}, damaged: false, quarantinedAt: null };
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') return { state: parsed, damaged: false, quarantinedAt: null };
        } catch {}
        return { state: {}, damaged: true, quarantinedAt: quarantine(key, raw) };
    }

    function write(key, state, options = {}) {
        const existing = read(key);
        if (existing.damaged && options.allowEmpty !== true) {
            return { written: false, reason: 'stored data is unreadable; refusing to overwrite it' };
        }
        const incomingCount = countEntries(state);
        const existingCount = countEntries(existing.state);
        const destructive = catastrophicLoss(state, existing.state);
        const notNewer = revisionOf(state) <= revisionOf(existing.state);
        if (options.allowEmpty !== true && options.allowDestructive !== true
            && ((incomingCount === 0 && existingCount > 0) || (destructive && notNewer))) {
            console.warn('[Audioflix] Refused a destructive fallback overwrite; the older richer copy was preserved.');
            return { written: false, reason: 'incoming state would destructively replace richer stored data' };
        }
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
        structuralStats,
        catastrophicLoss,
        folderRegistry,
        captureStructure,
        readStructure,
        writeStructure,
        applyStructureSnapshot,
        applyTrackStructure: (key, state, item, type) => applyTrackStructure(state, readStructure(key), item, type),
        restoreStructure,
        prefer,
        nextRevision,
        QUARANTINE_SUFFIX,
        STRUCTURE_SUFFIX,
        STRUCTURE_PREV_SUFFIX
    });
})();