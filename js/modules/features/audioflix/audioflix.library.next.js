window.EveAudioflixLibraryNext = window.EveAudioflixLibraryNext || {};
(function () {
    'use strict';
    const ns = window.EveAudioflixLibraryNext;
    if (ns.ready) return;

    const HEALTH_KEY = 'eveAudioflixUrlHealthV1';
    const PREF_KEY = 'eveAudioflixUrlHealthPrefsV1';
    const DB_NAME = 'eveAudioflixUrlCacheV1';
    const STORE = 'media';
    const MAX_CACHE_BYTES = 350 * 1024 * 1024;
    const MAX_ONE_CACHE = 80 * 1024 * 1024;
    const text = (v, f = '') => String(v ?? '').trim() || f;
    const state = () => window.EveAudioflixState?.ensure?.() || {};
    const canonUrl = (v) => { try { const u = new URL(text(v)); u.hash = ''; return u.toString().replace(/\/$/, ''); } catch { return text(v).replace(/\/$/, ''); } };
    const loadMap = (key) => { try { const v = JSON.parse(localStorage.getItem(key) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
    const saveMap = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };

    function libraryTime(item) {
        const value = Number(item?.createdAt || item?.addedAt || item?.libraryAddedAt || 0);
        return value > 0 ? value : Number.MAX_SAFE_INTEGER;
    }
    function earliest(items) {
        return [...(items || [])].sort((a, b) => libraryTime(a) - libraryTime(b) || String(a?.id || '').localeCompare(String(b?.id || '')))[0] || null;
    }
    function numericRename(title, taken) {
        const base = text(title, 'Untitled Track');
        let n = 2, candidate = `${base} (${n})`;
        while (taken.has(candidate.toLowerCase())) candidate = `${base} (${++n})`;
        return candidate;
    }
    ns.earliest = earliest;
    ns.numericRename = numericRename;

    // ---------- Durable URL health preferences/status ----------
    function health(id) { return loadMap(HEALTH_KEY)[id] || null; }
    function prefs(id) { return loadMap(PREF_KEY)[id] || { showLive: false, hideDown: false }; }
    function setHealth(id, patch) {
        const map = loadMap(HEALTH_KEY);
        map[id] = { ...(map[id] || {}), ...patch, checkedAt: Date.now() };
        saveMap(HEALTH_KEY, map);
        return map[id];
    }
    function setPrefs(id, patch) {
        const map = loadMap(PREF_KEY);
        map[id] = { showLive: map[id]?.showLive === true, hideDown: map[id]?.hideDown === true, ...patch };
        saveMap(PREF_KEY, map);
        return map[id];
    }
    function isLocalHost() {
        return /^(?:localhost|127\.0\.0\.1)$/i.test(location.hostname || '') || /\/\/localhost(?::|\/)/i.test(String(location.href));
    }
    function providerFor(itemOrUrl) {
        const url = text(typeof itemOrUrl === 'string' ? itemOrUrl : itemOrUrl?.url);
        const provider = text(window.EveAudioflixUrlProviders?.providerFor?.(url)).toLowerCase();
        if (provider) return provider;
        return /^https?:\/\/open\.spotify\.com\/(?:embed\/)?track\//i.test(url) ? 'spotify' : '';
    }
    function providerManagedHealth(item) {
        if (providerFor(item) !== 'spotify') return null;
        return { status: 'provider', provider: 'spotify', source: 'spotify-official', mediaUrl: '' };
    }
    function effectiveHealth(item) {
        const stored = health(item?.id);
        const managed = providerManagedHealth(item);
        if (!managed) return stored;
        if (stored?.status === 'down' && stored?.source === 'spotify-provider-error') return stored;
        return { ...(stored || {}), ...managed };
    }

    // ---------- IndexedDB media cache ----------
    let dbPromise;
    function db() {
        if (!('indexedDB' in window)) return Promise.resolve(null);
        if (!dbPromise) dbPromise = new Promise((resolve) => {
            try {
                const request = indexedDB.open(DB_NAME, 1);
                request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'key' }); };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => resolve(null);
            } catch { resolve(null); }
        });
        return dbPromise;
    }
    async function cacheGet(key) {
        const database = await db(); if (!database) return null;
        return new Promise((resolve) => { try { const tx = database.transaction(STORE, 'readonly'); const r = tx.objectStore(STORE).get(key); r.onsuccess = () => resolve(r.result || null); r.onerror = () => resolve(null); } catch { resolve(null); } });
    }
    async function cachePut(key, blob, meta = {}) {
        if (!blob || blob.size > MAX_ONE_CACHE) return false;
        const database = await db(); if (!database) return false;
        try {
            const existing = await cacheGet(key);
            const total = await cacheTotal();
            if (total - Number(existing?.blob?.size || 0) + blob.size > MAX_CACHE_BYTES) return false;
            await new Promise((resolve, reject) => { const tx = database.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put({ key, blob, ...meta, size: blob.size, savedAt: Date.now() }); tx.oncomplete = resolve; tx.onerror = reject; });
            return true;
        } catch { return false; }
    }
    async function cacheTotal() {
        const database = await db(); if (!database) return 0;
        return new Promise((resolve) => { try { const tx = database.transaction(STORE, 'readonly'); const req = tx.objectStore(STORE).getAll(); req.onsuccess = () => resolve((req.result || []).reduce((n, x) => n + Number(x.size || x.blob?.size || 0), 0)); req.onerror = () => resolve(0); } catch { resolve(0); } });
    }
    async function cacheBlobUrl(key) {
        const entry = await cacheGet(key); if (!entry?.blob) return '';
        try { return URL.createObjectURL(entry.blob); } catch { return ''; }
    }
    ns.cache = { get: cacheGet, put: cachePut, blobUrl: cacheBlobUrl, total: cacheTotal };

    async function fetchForCache(url) {
        const target = /^https?:\/\//i.test(url) && isLocalHost()
            ? `/api/proxy?media=1&url=${encodeURIComponent(url)}` : url;
        try {
            const response = await fetch(target, { method: 'GET', cache: 'no-store' });
            if (!response.ok) return null;
            return { response, blob: await response.blob() };
        } catch { return null; }
    }

    async function resolveLive(item) {
        const url = text(item?.url);
        if (!/^https?:\/\//i.test(url) || !isLocalHost()) return { live: null, mediaUrl: '' };
        const provider = providerFor(url);
        try {
            // Spotify is intentionally owned by the official iframe player. The generic resolver
            // rejects Spotify identities by design, so probing it here only manufactures a 422 and
            // a false "URL Down" state while the official provider is playing normally.
            if (provider === 'spotify') return { live: null, mediaUrl: '', providerManaged: true, provider };
            if (provider === 'instagram') {
                const res = await window.EveAudioflixNative?.resolveInstagramVideo?.(url);
                if (res?.ok && res.videoUrl) return { live: true, mediaUrl: res.videoUrl, result: res };
                return { live: false, mediaUrl: '' };
            }
            if (window.EveAudioflixNative?.resolveUrl) {
                const res = await window.EveAudioflixNative.resolveUrl(url, true);
                if (res?.ok && res.audioUrl) return { live: true, mediaUrl: res.audioUrl, result: res };
                return { live: false, mediaUrl: '' };
            }
            const probe = await fetch(url, { method: 'HEAD', cache: 'no-store' });
            return { live: probe.ok, mediaUrl: url };
        } catch { return { live: false, mediaUrl: '' }; }
    }

    async function maybeCache(item, mediaUrl) {
        if (!mediaUrl || !isLocalHost()) return false;
        const fetched = await fetchForCache(mediaUrl);
        if (!fetched) return false;
        return cachePut(canonUrl(item.url), fetched.blob, { sourceUrl: item.url, mime: fetched.response.headers.get('content-type') || '' });
    }

    async function prepareUrlPlayback(item, originalPlay) {
        const key = item.id;
        const cacheKey = canonUrl(item.url);
        const stored = await cacheGet(cacheKey);
        if (!isLocalHost()) {
            if (!stored) return originalPlay(item);
            const blobUrl = await cacheBlobUrl(cacheKey);
            return blobUrl ? originalPlay({ ...item, url: blobUrl, originalUrl: item.url }) : originalPlay(item);
        }

        const live = await resolveLive(item);
        if (live.providerManaged === true) {
            setHealth(key, {
                status: 'provider',
                provider: text(live.provider, 'spotify'),
                source: 'spotify-official',
                mediaUrl: '',
                lastCheckedAt: Date.now()
            });
            // Do not substitute an old URL cache for a Spotify identity. Explicit localization is
            // still allowed elsewhere, but ordinary URL playback stays on Spotify's official player.
            return originalPlay(item);
        }
        setHealth(key, { status: live.live === true ? 'live' : 'down', source: text(live.result?.source || ''), mediaUrl: text(live.mediaUrl || ''), lastCheckedAt: Date.now() });
        if (live.live === true) {
            if (stored) {
                const blobUrl = await cacheBlobUrl(cacheKey);
                if (blobUrl) return originalPlay({ ...item, url: blobUrl, originalUrl: item.url });
            }
            const played = await originalPlay(item);
            if (live.mediaUrl) void maybeCache(item, live.mediaUrl);
            return played;
        }
        if (stored) {
            const blobUrl = await cacheBlobUrl(cacheKey);
            if (blobUrl) return originalPlay({ ...item, url: blobUrl, originalUrl: item.url });
        }
        return originalPlay(item);
    }

    function marker(item) {
        const h = effectiveHealth(item); if (!h) return '';
        const p = prefs(item.id);
        if (h.status === 'provider') return '<span class="eve-url-health-badge is-provider" title="Spotify playback uses the official embedded player; generic URL resolution is intentionally bypassed">● Spotify</span>';
        if (h.status === 'down') return p.hideDown ? '' : '<span class="eve-url-health-badge is-down" title="URL checked when played and is currently unavailable">● URL Down</span>';
        if (h.status === 'live' && p.showLive) return '<span class="eve-url-health-badge is-live" title="URL checked when played and is currently live">● Live URL</span>';
        return '';
    }

    function injectStyle() {
        if (document.getElementById('eve-audioflix-library-next-style')) return;
        const style = document.createElement('style'); style.id = 'eve-audioflix-library-next-style';
        style.textContent = '.eve-url-health-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:9px;font-size:.67rem;font-weight:800;line-height:1.1}.eve-url-health-badge.is-down{color:#fecaca;background:#7f1d1d;border:1px solid #ef4444}.eve-url-health-badge.is-live{color:#bbf7d0;background:#14532d;border:1px solid #22c55e}.eve-url-health-badge.is-provider{color:#d1fae5;background:#064e3b;border:1px solid #10b981}.eve-next-tool{font-size:.72rem;padding:4px 9px;border-radius:10px;cursor:pointer;margin:4px 4px 0 0;border:1px solid #475569;background:#1e293b;color:#e2e8f0}.eve-next-tool:hover{filter:brightness(1.15)}.eve-url-health-box{margin-top:10px;padding:9px;background:#0f172a;border:1px solid #334155;border-radius:7px}.eve-url-health-box label{display:flex;align-items:center;gap:6px;color:#cbd5e1;font-size:.74rem;margin-top:6px}';
        document.head.appendChild(style);
    }

    function cleanGhostIgGroups() {
        const s = state(); const connections = Array.isArray(s.musicPlaylists) ? s.musicPlaylists.filter((x) => String(x.provider).toLowerCase() === 'instagram') : [];
        const groups = new Set(connections.map((x) => text(x.group)).filter(Boolean));
        const maps = s.musicGroupMap || {};
        groups.forEach((group) => {
            const memberIds = (s.music || []).filter((it) => (maps[it.id] || []).some((g) => String(g).toLowerCase() === group.toLowerCase())).map((it) => it.id);
            if (!memberIds.length && !connections.some((c) => text(c.group).toLowerCase() === group.toLowerCase() && (s.music || []).some((it) => it.playlistId === c.id))) window.EveAudioflixState?.removeMusicGroup?.(group);
        });
    }

    function duplicateTools() {
        const dup = window.EveAudioflixDuplicates; if (!dup) return;
        if (!dup.mergeEarliest) dup.mergeEarliest = function (type, itemId) {
            const current = (state()[type === 'music' ? 'music' : 'soundboard'] || []).find((x) => x.id === itemId);
            if (!current) return { ok: false, reason: 'Item not found' };
            const matches = dup.duplicateInfoFor(type, itemId).filter((x) => x.level === 'hard').map((x) => x.item);
            if (!matches.length) return { ok: false, reason: 'No hard duplicates found' };
            const all = [current, ...matches]; const primary = earliest(all); const ids = all.filter((x) => x.id !== primary.id).map((x) => x.id);
            return dup.mergeDuplicates(type, primary.id, ids, primary.folder || primary.card || '');
        };
        if (!dup.renameEarliestSoft) dup.renameEarliestSoft = function (type, itemId) {
            const items = state()[type === 'music' ? 'music' : 'soundboard'] || [];
            const current = items.find((x) => x.id === itemId); if (!current) return { ok: false, reason: 'Item not found' };
            const soft = dup.duplicateInfoFor(type, itemId).filter((x) => x.level === 'soft').map((x) => x.item);
            if (!soft.length) return { ok: false, reason: 'No soft duplicates found' };
            const primary = earliest([current, ...soft]);
            if (primary.id === current.id) return { ok: false, reason: 'This is already the earliest song; the newly added song keeps the existing name.' };
            const taken = new Set(items.map((x) => text(x.title).toLowerCase()));
            const nextTitle = numericRename(primary.title, taken);
            window.EveAudioflixState?.updateItem?.(type, primary.id, { title: nextTitle });
            return { ok: true, renamedId: primary.id, title: nextTitle };
        };
    }

    function installStateHooks() {
        const S = window.EveAudioflixState; if (!S || S.__eveLibraryNext) return;
        S.__eveLibraryNext = true;
        const originalRemove = S.removeItem?.bind(S);
        if (originalRemove) S.removeItem = function (type, id) { const result = originalRemove(type, id); setTimeout(cleanGhostIgGroups, 0); return result; };
        const originalAdd = S.addItem?.bind(S);
        if (originalAdd) S.addItem = function (type, item) {
            const source = { ...(item || {}) };
            if (!source.createdAt && !source.addedAt) source.createdAt = Date.now();
            return originalAdd(type, source);
        };
        duplicateTools();
        cleanGhostIgGroups();
    }

    function installPlaybackHook() {
        const A = window.EveAudioflixAudio; if (!A || A.__eveLibraryNext) return;
        const originalPlay = A.playItem?.bind(A); if (!originalPlay) return;
        A.__eveLibraryNext = true;
        A.playItem = async function (item, ...args) {
            const isUrlSong = item?.type === 'music' && /^https?:\/\//i.test(text(item.url)) && !item.localPath;
            if (!isUrlSong) return originalPlay(item, ...args);
            return prepareUrlPlayback(item, (next) => originalPlay(next, ...args));
        };
    }

    function findItemIdFromModal(root) { return root?.querySelector?.('[data-af-form="edit-track"]')?.dataset?.afId || ''; }
    function addModalHealthBox(root) {
        if (!root || root.querySelector('.eve-url-health-box')) return;
        const id = findItemIdFromModal(root); if (!id) return;
        const item = (state().music || []).find((x) => x.id === id); if (!item || !/^https?:\/\//i.test(text(item.url))) return;
        const h = effectiveHealth(item); const p = prefs(id);
        const providerManaged = h?.status === 'provider';
        const statusColor = h?.status === 'down' ? '#fca5a5' : h?.status === 'live' ? '#86efac' : providerManaged ? '#6ee7b7' : '#94a3b8';
        const statusText = h?.status === 'down' ? 'URL Down' : h?.status === 'live' ? 'Live URL' : providerManaged ? 'Spotify Provider' : 'Not checked yet';
        const note = providerManaged
            ? 'Spotify playback is provider-managed by the official embedded player. Generic URL resolution and URL-cache probing are intentionally skipped.'
            : 'Checked only when this song is played with EveOS localhost running. file:// uses cache only.';
        const controls = providerManaged ? '' : `<label><input type="checkbox" data-next-pref="live" data-next-id="${id}" ${p.showLive ? 'checked' : ''}> Show green Live URL marker on the song card</label><label><input type="checkbox" data-next-pref="hideDown" data-next-id="${id}" ${p.hideDown ? 'checked' : ''}> Hide red URL Down marker on the song card</label>`;
        const box = document.createElement('div'); box.className = 'eve-url-health-box';
        box.innerHTML = `<strong style="font-size:.8rem;color:#e2e8f0">URL health & cache</strong><div style="font-size:.72rem;color:#94a3b8;margin-top:3px">${note}</div><div style="margin-top:5px;font-size:.72rem;color:${statusColor}">Status: ${statusText}</div>${controls}`;
        root.querySelector('.audioflix-info-body')?.appendChild(box);
    }

    function enhanceDuplicateBox(box) {
        if (!box || box.querySelector('.eve-next-tool')) return;
        const base = box.querySelector('[data-af-action="merge-duplicate"]'); if (!base) return;
        if (box.querySelector('.audioflix-dup-badge') || box.textContent.includes('Duplicate')) {
            const tools = document.createElement('div'); tools.style.marginTop = '7px';
            const hard = box.textContent.includes('Duplicate detected');
            const b = document.createElement('button'); b.type = 'button'; b.className = 'eve-next-tool'; b.dataset.nextAction = hard ? 'merge-earliest' : 'rename-earliest-soft'; b.dataset.afType = base.dataset.afType || 'music'; b.dataset.afId = base.dataset.afId || ''; b.textContent = hard ? '⏱ Auto-merge: Keep Earliest Added' : '🔤 Rename Earliest Soft Duplicate';
            b.title = hard ? 'For hard/found duplicates only. Keeps the oldest library item as the survivor.' : 'Keeps the newest item unchanged and adds a numeric suffix to the earliest item.';
            tools.appendChild(b); box.appendChild(tools);
        }
    }

    function enhanceDuplicateBoxes(root) {
        root?.querySelectorAll?.('.audioflix-dup-manager-box').forEach(enhanceDuplicateBox);
    }

    function scanDomDecorators(root) {
        if (!root || root.nodeType !== 1) return;
        const modal = root.closest?.('.audioflix-info-modal');
        if (modal) addModalHealthBox(modal);
        const duplicateBox = root.closest?.('.audioflix-dup-manager-box');
        if (duplicateBox) enhanceDuplicateBox(duplicateBox);
        if (root.matches?.('.audioflix-info-modal')) addModalHealthBox(root);
        if (root.matches?.('.audioflix-dup-manager-box')) enhanceDuplicateBox(root);
        root.querySelectorAll?.('.audioflix-info-modal').forEach(addModalHealthBox);
        root.querySelectorAll?.('.audioflix-dup-manager-box').forEach(enhanceDuplicateBox);
    }

    function installOverlayDomObserver() {
        let overlayObserver = null;
        let bodyObserver = null;

        const connect = () => {
            const overlay = document.getElementById('audioflix-overlay');
            if (!overlay || overlayObserver) return false;
            scanDomDecorators(overlay);
            overlayObserver = new MutationObserver((records) => {
                records.forEach((record) => {
                    record.addedNodes.forEach((node) => {
                        if (node?.nodeType === 1) scanDomDecorators(node);
                    });
                });
            });
            overlayObserver.observe(overlay, { childList: true, subtree: true });
            bodyObserver?.disconnect();
            bodyObserver = null;
            return true;
        };

        if (connect()) return;

        // The AudioFlix overlay is a direct child of body. Observe only that one level until the
        // overlay appears, then disconnect so unrelated EveOS/Gemini DOM churn never reaches us.
        bodyObserver = new MutationObserver((records) => {
            for (const record of records) {
                for (const node of record.addedNodes) {
                    if (node?.nodeType === 1 && node.id === 'audioflix-overlay') {
                        connect();
                        return;
                    }
                }
            }
        });
        bodyObserver.observe(document.body, { childList: true });
    }

    function installDomHooks() {
        injectStyle();
        document.addEventListener('click', async (event) => {
            const target = event.target?.closest?.('[data-next-action]');
            if (target) {
                const type = target.dataset.afType || 'music'; const id = target.dataset.afId || '';
                if (target.dataset.nextAction === 'merge-earliest') window.EveAudioflixDuplicates?.mergeEarliest?.(type, id);
                else if (target.dataset.nextAction === 'rename-earliest-soft') window.EveAudioflixDuplicates?.renameEarliestSoft?.(type, id);
                window.EveAudioflix?.rerender?.();
                return;
            }
            const pref = event.target?.closest?.('[data-next-pref]');
            if (pref) { setPrefs(pref.dataset.nextId, { [pref.dataset.nextPref]: pref.checked }); return; }

            const play = event.target?.closest?.('[data-af-action="play"][data-af-type="music"]');
            if (play) {
                const card = play.closest('.audioflix-item-card');
                const inQueue = !!card?.querySelector('.audioflix-queue-badge');
                if (!inQueue && state().musicViewMode === 'frontend' && state().activeFrontendMusicGroup) {
                    const stopGroup = document.querySelector('[data-af-action="stop-music-group"]');
                    stopGroup?.click?.();
                }
            }
            if (play) {
                const card = play.closest('.audioflix-item-card'); const badge = card?.querySelector('.audioflix-queue-badge');
                const m = badge?.textContent?.match(/#(\d+)/); if (m) window.__eveAudioflixQueueRebase = { position: Number(m[1]), group: card?.closest('.audioflix-item-grid') };
            }
        }, true);

        installOverlayDomObserver();
        document.addEventListener('eve:audioflix-playback', () => {}, true);
        window.addEventListener?.('eve:audioflix-playback', (event) => {
            const detail = event.detail || {};
            const providerItem = detail.item;
            if (providerItem?.id && providerFor(providerItem) === 'spotify') {
                if (detail.error === true) {
                    setHealth(providerItem.id, {
                        status: 'down',
                        provider: 'spotify',
                        source: 'spotify-provider-error',
                        mediaUrl: '',
                        reason: text(detail.status)
                    });
                } else if (/^Playing\b/i.test(text(detail.status))) {
                    setHealth(providerItem.id, {
                        status: 'provider',
                        provider: 'spotify',
                        source: 'spotify-official',
                        mediaUrl: ''
                    });
                }
            }
            // Queue progression has one owner: audioflix.ui.js -> playQueueIndex().
            // This compatibility marker may follow manual clicks, but it must never click the next
            // card on Ended or it races the real queue and can start two different songs.
            if (detail.status === 'Ended') window.__eveAudioflixQueueRebase = null;
        }, true);
    }

    function boot() {
        installStateHooks(); duplicateTools(); installPlaybackHook();
        if (document.body && !ns.domReady) { ns.domReady = true; installDomHooks(); }
        if (!ns.readyTimer) ns.readyTimer = setInterval(() => { installStateHooks(); duplicateTools(); installPlaybackHook(); }, 1000);
    }

    Object.assign(ns, { ready: true, boot, health, effectiveHealth, providerManagedHealth, prefs, setHealth, setPrefs });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
})();
