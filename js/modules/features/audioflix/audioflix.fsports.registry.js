// Persistent browser folder-handle registry for Audioflix.
// Handles live in IndexedDB; serializable metadata mirrors into the EveOS datapack for restore.
window.EveAudioflixFsPortsRegistry = window.EveAudioflixFsPortsRegistry || {};
(function () {
    'use strict';

    const ns = window.EveAudioflixFsPortsRegistry;
    if (ns.ready) return;

    const DB_NAME = 'eve-audioflix-fsports';
    const STORE = 'folders';

    function supported() {
        return typeof window.showDirectoryPicker === 'function' && !!window.indexedDB;
    }

    function openDb() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(STORE)) {
                    req.result.createObjectStore(STORE, { keyPath: 'id' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    function tx(db, mode, run) {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE, mode);
            const output = run(transaction.objectStore(STORE));
            transaction.oncomplete = () => resolve(output && 'result' in output ? output.result : undefined);
            transaction.onerror = () => reject(transaction.error);
        });
    }

    async function allRecords() {
        const db = await openDb();
        try {
            return (await tx(db, 'readonly', (store) => store.getAll())) || [];
        } finally {
            db.close();
        }
    }

    async function addFolder(overrides) {
        if (!supported()) throw new Error('This browser does not support folder access (needs Edge/Chrome).');
        const handle = await window.showDirectoryPicker({ mode: 'read' });
        const options = overrides && typeof overrides === 'object' ? overrides : {};
        const record = {
            id: String(options.id || '') || `fsp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            nickname: String(options.nickname || '').trim() || handle.name || 'Sound folder',
            purpose: String(options.purpose || 'sound').trim(),
            handle,
            addedAt: Date.now()
        };
        const db = await openDb();
        try {
            await tx(db, 'readwrite', (store) => store.put(record));
        } finally {
            db.close();
        }
        return { id: record.id, nickname: record.nickname, purpose: record.purpose };
    }

    async function removeFolder(id) {
        const db = await openDb();
        try {
            await tx(db, 'readwrite', (store) => store.delete(id));
        } finally {
            db.close();
        }
        // Remove the backup mirror too, or reconcile() immediately recreates a reconnect stub.
        const api = window.EveAudioflixState;
        const current = api?.ensure?.();
        if (current) {
            const previous = current.browserFolders || [];
            const browserFolders = previous.filter((folder) => folder.id !== id);
            if (browserFolders.length !== previous.length) {
                api.update({ browserFolders }, 'audioflix-browser-folder-remove');
            }
        }
        return true;
    }

    async function permissionOf(handle) {
        if (!handle) return 'prompt';
        try {
            return await handle.queryPermission({ mode: 'read' });
        } catch {
            return 'error';
        }
    }

    async function reconcile() {
        const api = window.EveAudioflixState;
        if (!supported() || !api?.ensure) return;
        const state = api.ensure();
        const current = Array.isArray(state.browserFolders) ? state.browserFolders : [];
        const portIds = new Set((state.ports || []).map((port) => port.id));
        const musicFolders = new Set([
            ...(state.musicPortConnections || []).map((connection) => String(connection.folder || '').toLowerCase()),
            ...(state.music || []).map((track) => String(track.folder || track.card || '').toLowerCase())
        ]);
        const mirror = current.filter((folder) => folder?.id && !portIds.has(folder.id));
        const db = await openDb();
        try {
            const records = (await tx(db, 'readonly', (store) => store.getAll())) || [];
            const byId = new Map(records.map((record) => [record.id, record]));
            for (const folder of mirror) {
                if (byId.has(folder.id)) continue;
                const isMusic = musicFolders.has(String(folder.nickname || '').toLowerCase())
                    || folder.purpose === 'music';
                const stub = {
                    id: folder.id,
                    nickname: folder.nickname || 'Sound folder',
                    purpose: isMusic ? 'music' : (folder.purpose || 'sound'),
                    handle: null,
                    addedAt: folder.addedAt || Date.now()
                };
                await tx(db, 'readwrite', (store) => store.put(stub));
                byId.set(stub.id, stub);
            }
            for (const record of records) {
                const isMusic = musicFolders.has(String(record.nickname || '').toLowerCase());
                if (isMusic && record.purpose !== 'music') {
                    record.purpose = 'music';
                    await tx(db, 'readwrite', (store) => store.put(record));
                }
            }
            const registry = [...byId.values()]
                .filter((record) => !portIds.has(record.id))
                .map((record) => ({
                    id: record.id,
                    nickname: record.nickname,
                    purpose: record.purpose || 'sound',
                    addedAt: record.addedAt || 0
                }));
            const inSync = registry.length === current.length
                && registry.every((record) => current.some((folder) => (
                    folder.id === record.id
                    && folder.nickname === record.nickname
                    && (folder.purpose || 'sound') === record.purpose
                )));
            const musicRecords = [...byId.values()].filter((record) => record.purpose === 'music');
            const connections = Array.isArray(state.musicPortConnections) ? state.musicPortConnections.slice() : [];
            const knownBrowserIds = new Set(connections.map((entry) => String(entry.browserFolderId || '')).filter(Boolean));
            const recoveredConnections = musicRecords
                .filter((record) => record.id && !knownBrowserIds.has(String(record.id)))
                .map((record) => ({
                    id: `port_recovered_${record.id}`,
                    path: `fsport://${encodeURIComponent(record.id)}`,
                    folder: String(record.nickname || record.handle?.name || 'Recovered Music Port'),
                    browserFolderId: record.id,
                    browserRootName: String(record.handle?.name || record.nickname || ''),
                    lastSyncedAt: 0,
                    trackCount: 0
                }));
            const recoveredFolders = [...new Set([
                ...(state.musicFolders || []),
                ...musicRecords.map((record) => String(record.nickname || record.handle?.name || '')).filter(Boolean)
            ])];
            if (!inSync || recoveredConnections.length || recoveredFolders.length !== (state.musicFolders || []).length) {
                api.update({
                    browserFolders: registry,
                    musicFolders: recoveredFolders,
                    musicPortConnections: connections.concat(recoveredConnections)
                }, recoveredConnections.length ? 'audioflix-browser-music-port-recovery' : 'audioflix-browser-folders');
            }
        } finally {
            db.close();
        }
    }

    async function folderStates() {
        if (!supported()) return [];
        const records = await allRecords();
        const states = [];
        for (const record of records) {
            states.push({
                id: record.id,
                nickname: record.nickname,
                purpose: record.purpose || 'sound',
                rootName: record.handle?.name || '',
                permission: await permissionOf(record.handle)
            });
        }
        return states;
    }

    async function reconnectAll() {
        const records = await allRecords();
        let granted = 0;
        for (const record of records) {
            try {
                if ((await permissionOf(record.handle)) === 'granted') {
                    granted += 1;
                    continue;
                }
                if ((await record.handle.requestPermission({ mode: 'read' })) === 'granted') granted += 1;
            } catch {
                // The caller refreshes folderStates() to surface denied or missing handles.
            }
        }
        return granted;
    }

    Object.assign(ns, {
        ready: true,
        supported,
        allRecords,
        addFolder,
        removeFolder,
        permissionOf,
        reconcile,
        folderStates,
        reconnectAll
    });
})();
