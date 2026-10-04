// Scoped backup adapter for canonical Audioflix references. Full datapack backups continue to
// carry the complete Audioflix store; scoped backups carry only linked items and bindings.
window.EveAudioflixLinks = window.EveAudioflixLinks || {};

(function (ns) {
    'use strict';

    const text = (value) => String(value ?? '').trim();
    const clone = (value) => JSON.parse(JSON.stringify(value));

    function valuesForIds(map, ids) {
        const source = map && typeof map === 'object' ? map : {};
        return Object.fromEntries(Array.from(ids).flatMap((id) => (
            Array.isArray(source[id]) && source[id].length
                ? [[id, [...new Set(source[id].map(text).filter(Boolean))]]]
                : []
        )));
    }

    function uniqueMapValues(map) {
        return [...new Set(Object.values(map || {}).flat().map(text).filter(Boolean))];
    }

    function groupClosure(groups, parents) {
        const found = new Set(groups || []);
        [...found].forEach((name) => {
            let current = name, guard = 0;
            while (parents?.[current] && guard++ < 100) {
                current = parents[current];
                found.add(current);
            }
        });
        return [...found];
    }

    function parentSubset(groups, parents) {
        const wanted = new Set(groups || []);
        return Object.fromEntries(Object.entries(parents || {}).filter(([child, parent]) => wanted.has(child) && wanted.has(parent)));
    }

    function objectForIds(source, ids) {
        return Object.fromEntries(Object.entries(source || {}).filter(([id]) => ids.has(text(id))));
    }

    function mergeObject(existing, incoming) {
        return Object.assign({}, existing || {}, incoming || {});
    }

    function mergeRecords(existing, incoming) {
        const byId = new Map((Array.isArray(existing) ? existing : []).map((entry) => [text(entry?.id), entry]));
        (Array.isArray(incoming) ? incoming : []).forEach((entry) => {
            const id = text(entry?.id);
            if (id) byId.set(id, Object.assign({}, byId.get(id) || {}, clone(entry)));
        });
        return Array.from(byId.values());
    }

    function itemUsesPort(item, port) {
        const portId = text(port?.id);
        if (portId && text(item?.id).startsWith(`ported_${portId}_`)) return true;
        const root = text(port?.path);
        if (!root) return false;
        const paths = window.EveAudioflixPaths;
        const candidates = [...(paths?.localCandidates?.(item) || []), item?.url];
        return candidates.some((candidate) => paths?.relativeTo?.(candidate, root) != null);
    }

    function localizationScopeKeys(items) {
        const keys = new Set();
        (Array.isArray(items) ? items : []).forEach((item) => {
            keys.add(`song:${text(item?.id)}`.toLowerCase());
            const folder = text(item?.folder || item?.card);
            if (folder) keys.add(`folder:${folder}`.toLowerCase());
            (item?.localizations || []).forEach((entry) => {
                const source = text(entry?.source).toLowerCase();
                if (source) keys.add(source);
            });
        });
        return keys;
    }

    function captureScopedBackup(scopeInput, context) {
        const store = window.EveAudioflixState?.ensure?.() || {};
        const scope = ns.normalizeScope?.(scopeInput) || scopeInput || {};
        const captured = ns.captureForScope?.(scope, context) || { bindings: [] };
        let bindings = Array.isArray(captured.bindings) ? captured.bindings : [];
        if (scope.scopeType === 'card') {
            bindings = bindings.filter((binding) => binding.scopeType !== 'workspace');
        } else if (scope.scopeType === 'folder') {
            bindings = bindings.filter((binding) => (
                binding.scopeType === 'folder' || binding.scopeType === 'bookmark'
            ));
        } else if (scope.scopeType === 'bookmark') {
            bindings = bindings.filter((binding) => (
                binding.scopeType === 'bookmark'
                && text(binding.bookmarkId) === text(scope.bookmarkId)
            ));
        }

        const musicIds = new Set(bindings
            .filter((binding) => binding.audioType !== 'sound')
            .map((binding) => text(binding.audioId))
            .filter(Boolean));
        const soundIds = new Set(bindings
            .filter((binding) => binding.audioType === 'sound')
            .map((binding) => text(binding.audioId))
            .filter(Boolean));
        const music = (store.music || []).filter((item) => musicIds.has(text(item?.id)));
        const soundboard = (store.soundboard || []).filter((item) => soundIds.has(text(item?.id)));
        const musicGroupMap = valuesForIds(store.musicGroupMap, musicIds);
        const soundGroupMap = valuesForIds(store.soundGroupMap, soundIds);
        const musicGroups = groupClosure(uniqueMapValues(musicGroupMap), store.musicGroupParents);
        const soundboardGroups = groupClosure(uniqueMapValues(soundGroupMap), store.soundGroupParents);
        const classifierNames = new Set(music.flatMap((item) => (
            Array.isArray(item?.classifiers) ? item.classifiers.map(text) : []
        )));
        const playlistIds = new Set(music.map((item) => text(item?.playlistId)).filter(Boolean));
        const musicFolders = new Set(music.map((item) => text(item?.folder || item?.card)).filter(Boolean));
        const musicFolderKeys = new Set(Array.from(musicFolders, (name) => name.toLowerCase()));
        const scopeDirKeys = localizationScopeKeys(music);
        musicGroups.forEach((name) => scopeDirKeys.add(`group:${name}`.toLowerCase()));
        const localizeScopeDirs = Object.fromEntries(Object.entries(store.localizeScopeDirs || {})
            .filter(([scopeKey]) => scopeDirKeys.has(text(scopeKey).toLowerCase())));
        const musicPortConnections = (store.musicPortConnections || []).filter((entry) => (
            musicFolderKeys.has(text(entry?.folder).toLowerCase())
            || music.some((item) => itemUsesPort(item, entry))
        ));
        const ports = (store.ports || []).filter((port) => soundboard.some((item) => itemUsesPort(item, port)));
        const browserFolders = (store.browserFolders || []).filter((folder) => (
            soundboard.some((item) => text(item?.id).startsWith(`ported_${text(folder?.id)}_`))
        ));
        const capturedIds = new Set([...musicIds, ...soundIds]);
        const dupDismissedPairs = (store.dupDismissedPairs || []).filter((pair) => {
            const [left, right] = text(pair).split('|');
            return capturedIds.has(left) && capturedIds.has(right);
        });

        return {
            schemaVersion: 3,
            scoped: true,
            scope: clone(scope),
            music: clone(music),
            soundboard: clone(soundboard),
            scopeBindings: clone(bindings),
            musicGroups,
            musicGroupParents: parentSubset(musicGroups, store.musicGroupParents),
            musicGroupMap,
            soundboardGroups,
            soundGroupParents: parentSubset(soundboardGroups, store.soundGroupParents),
            soundGroupMap,
            musicClassifiers: (store.musicClassifiers || []).filter((name) => classifierNames.has(text(name))),
            musicPlaylists: clone((store.musicPlaylists || []).filter((entry) => playlistIds.has(text(entry?.id)))),
            musicPortConnections: clone(musicPortConnections),
            localizeScopeDirs: clone(localizeScopeDirs),
            localizeDir: text(Object.values(localizeScopeDirs)[0]),
            dupDismissedPairs: clone(dupDismissedPairs),
            ports: clone(ports),
            browserFolders: clone(browserFolders),
            portVolumes: clone(objectForIds(store.portVolumes, soundIds)),
            exposedPortedSounds: clone(objectForIds(store.exposedPortedSounds, soundIds)),
            portHotkeys: clone(objectForIds(store.portHotkeys, soundIds))
        };
    }

    function mergeItems(existing, incoming) {
        const byId = new Map((Array.isArray(existing) ? existing : []).map((item) => [text(item?.id), item]));
        (Array.isArray(incoming) ? incoming : []).forEach((item) => {
            const id = text(item?.id);
            if (id) byId.set(id, Object.assign({}, byId.get(id) || {}, clone(item)));
        });
        return Array.from(byId.values());
    }

    function mergeNamedMap(existing, incoming) {
        const next = Object.fromEntries(Object.entries(existing || {}).map(([id, values]) => [
            id,
            Array.isArray(values) ? values.slice() : []
        ]));
        Object.entries(incoming || {}).forEach(([id, values]) => {
            next[id] = [...new Set((next[id] || []).concat(Array.isArray(values) ? values : []).map(text).filter(Boolean))];
        });
        return next;
    }

    function bindingIsInTarget(binding, target) {
        if (text(binding?.workspaceId).toLowerCase() !== text(target.workspaceId).toLowerCase()) return false;
        if (target.scopeType === 'workspace') return true;
        if (text(binding?.categoryName).toLowerCase() !== text(target.categoryName).toLowerCase()) return false;
        if (target.scopeType === 'card') return binding.scopeType !== 'workspace';
        if (target.scopeType === 'folder') {
            const folderIds = new Set((target.folderIds || [target.folderId]).map(text).filter(Boolean));
            const bookmarkIds = new Set((target.bookmarkIds || []).map(text).filter(Boolean));
            if (binding.scopeType === 'folder') return folderIds.has(text(binding.folderId));
            return binding.scopeType === 'bookmark' && bookmarkIds.has(text(binding.bookmarkId));
        }
        return binding.scopeType === 'bookmark' && text(binding.bookmarkId) === text(target.bookmarkId);
    }

    function remapBinding(binding, source, target) {
        const next = clone(binding);
        next.workspaceId = target.workspaceId;
        if (target.scopeType !== 'workspace') next.categoryName = target.categoryName;
        if (target.scopeType === 'folder' && source.folderId === binding.folderId) {
            next.folderId = target.folderId;
        }
        if (target.scopeType === 'bookmark' && source.bookmarkId === binding.bookmarkId) {
            next.bookmarkId = target.bookmarkId;
        }
        return next;
    }

    function mergeScopedBackup(rawBackup, targetScopeInput) {
        const backup = rawBackup && typeof rawBackup === 'object' ? rawBackup : {};
        if (backup.scoped !== true) return { ok: false, reason: 'Not a scoped Audioflix backup.' };
        const source = ns.normalizeScope?.(backup.scope) || backup.scope || {};
        const targetSource = targetScopeInput || source;
        const target = ns.normalizeScope?.(targetSource) || targetSource;
        target.folderIds = Array.isArray(targetSource?.folderIds) ? targetSource.folderIds : [];
        target.bookmarkIds = Array.isArray(targetSource?.bookmarkIds) ? targetSource.bookmarkIds : [];
        const storeApi = window.EveAudioflixState;
        const current = storeApi?.ensure?.();
        if (!current || typeof storeApi?.replaceState !== 'function') {
            return { ok: false, reason: 'Audioflix state is unavailable.' };
        }

        const retainedBindings = (current.scopeBindings || []).filter((binding) => !bindingIsInTarget(binding, target));
        const incomingBindings = (backup.scopeBindings || []).map((binding) => remapBinding(binding, source, target));
        const next = Object.assign({}, current, {
            music: mergeItems(current.music, backup.music),
            soundboard: mergeItems(current.soundboard, backup.soundboard),
            scopeBindings: retainedBindings.concat(incomingBindings),
            musicGroups: [...new Set((current.musicGroups || []).concat(backup.musicGroups || []).map(text).filter(Boolean))],
            musicGroupParents: mergeObject(current.musicGroupParents, backup.musicGroupParents),
            musicGroupMap: mergeNamedMap(current.musicGroupMap, backup.musicGroupMap),
            soundboardGroups: [...new Set((current.soundboardGroups || []).concat(backup.soundboardGroups || []).map(text).filter(Boolean))],
            soundGroupParents: mergeObject(current.soundGroupParents, backup.soundGroupParents),
            soundGroupMap: mergeNamedMap(current.soundGroupMap, backup.soundGroupMap),
            musicClassifiers: [...new Set((current.musicClassifiers || []).concat(backup.musicClassifiers || []).map(text).filter(Boolean))],
            musicPlaylists: mergeItems(current.musicPlaylists, backup.musicPlaylists),
            musicPortConnections: mergeRecords(current.musicPortConnections, backup.musicPortConnections),
            localizeScopeDirs: mergeObject(current.localizeScopeDirs, backup.localizeScopeDirs),
            localizeDir: text(backup.localizeDir) || text(current.localizeDir),
            dupDismissedPairs: [...new Set((current.dupDismissedPairs || [])
                .concat(backup.dupDismissedPairs || []).map(text).filter(Boolean))],
            ports: mergeRecords(current.ports, backup.ports),
            browserFolders: mergeRecords(current.browserFolders, backup.browserFolders),
            portVolumes: mergeObject(current.portVolumes, backup.portVolumes),
            exposedPortedSounds: mergeObject(current.exposedPortedSounds, backup.exposedPortedSounds),
            portHotkeys: mergeObject(current.portHotkeys, backup.portHotkeys)
        });
        storeApi.replaceState(next, 'audioflix-scoped-restore');
        return {
            ok: true,
            music: (backup.music || []).length,
            sounds: (backup.soundboard || []).length,
            bindings: incomingBindings.length
        };
    }

    Object.assign(ns, {
        captureScopedBackup,
        mergeScopedBackup
    });
})(window.EveAudioflixLinks);
