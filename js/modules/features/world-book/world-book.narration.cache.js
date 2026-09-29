window.EveWorldBookNarrationCache = window.EveWorldBookNarrationCache || {};

(function (cache) {
    'use strict';
    if (cache.ready) return;

    const SETTINGS_KEY = 'eveWorldBookNarrationSettings';
    const DB_NAME = 'eve-world-book-narration';
    const STORE_NAME = 'audio-passages';
    const CACHE_VERSION = 'world-book-narration-v2';
    let dbPromise = null;

    function hash(value) {
        const text = String(value || '');
        let code = 2166136261;
        for (let index = 0; index < text.length; index += 1) {
            code ^= text.charCodeAt(index);
            code = Math.imul(code, 16777619);
        }
        return (code >>> 0).toString(36);
    }

    function settings() {
        try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); }
        catch (_error) { return {}; }
    }

    function openDb() {
        if (!window.indexedDB) return Promise.resolve(null);
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 1);
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains(STORE_NAME)) {
                    request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        }).catch(error => {
            console.warn('Narration cache unavailable:', error);
            dbPromise = null;
            return null;
        });
        return dbPromise;
    }

    async function transact(mode, callback) {
        const db = await openDb();
        if (!db) return null;
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, mode);
            const store = transaction.objectStore(STORE_NAME);
            let result;
            try { result = callback(store); }
            catch (error) { reject(error); return; }
            transaction.oncomplete = () => resolve(result && 'result' in result ? result.result : result ?? null);
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error || new Error('Narration cache transaction aborted.'));
        });
    }

    function key(source, passage, index, config) {
        const policy = config.strictVerbatim === false ? 'natural' : 'verbatim';
        return [
            'gemini', CACHE_VERSION, policy, config.geminiVoice || 'Aoede',
            hash(source?.id || 'unknown'), index, hash(passage)
        ].join(':');
    }

    async function get(source, passage, index, config) {
        const record = await transact('readonly', store => store.get(key(source, passage, index, config)));
        if (!record?.pcm?.byteLength) return null;
        record.lastUsed = Date.now();
        void transact('readwrite', store => store.put(record)).catch(() => {});
        return record;
    }

    async function remove(source, passage, index, config) {
        return transact('readwrite', store => store.delete(key(source, passage, index, config)));
    }

    async function put(source, passage, index, passageCount, config, record) {
        const value = {
            key: key(source, passage, index, config),
            ...record,
            voice: config.geminiVoice || 'Aoede',
            sourceId: source?.id || '',
            sourceTitle: source?.title || 'Unknown source',
            sourceLocator: source?.locator || '',
            sourceKind: source?.kind || '',
            sourceRevision: source?.revision || '',
            sourceHash: hash(passage),
            sourceText: passage,
            passageIndex: index,
            passageCount,
            passagePreview: String(passage || '').replace(/\s+/g, ' ').trim().slice(0, 180),
            narrationPolicy: config.strictVerbatim === false ? 'natural' : 'verbatim',
            cachePolicyVersion: CACHE_VERSION,
            createdAt: Number(record.createdAt) || Date.now(),
            lastUsed: Date.now(),
            size: record.pcm?.byteLength || 0
        };
        await transact('readwrite', store => store.put(value));
        await prune();
        return value;
    }

    async function prune() {
        const rows = (await transact('readonly', store => store.getAll())) || [];
        const config = settings();
        const maxBytes = Math.max(16, Number(config.cacheMb) || 192) * 1024 * 1024;
        const cutoff = Date.now() - Math.max(1, Number(config.cacheDays) || 30) * 86400000;
        rows.sort((left, right) => Number(left.lastUsed || 0) - Number(right.lastUsed || 0));
        const remove = rows.filter(row => Number(row.lastUsed || 0) < cutoff);
        const retained = rows.filter(row => Number(row.lastUsed || 0) >= cutoff);
        let total = retained.reduce((sum, row) => sum + Number(row.size || 0), 0);
        while (total > maxBytes && retained.length) {
            const oldest = retained.shift();
            total -= Number(oldest.size || 0);
            remove.push(oldest);
        }
        if (remove.length) {
            await transact('readwrite', store => remove.forEach(row => store.delete(row.key)));
        }
    }

    Object.assign(cache, {
        ready: true,
        key,
        get,
        remove,
        put,
        prune,
        hash
    });
})(window.EveWorldBookNarrationCache);
