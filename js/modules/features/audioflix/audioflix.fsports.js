// Browser-native soundboard folder ports — no EveOS server required (works on file://).
//
// The classic "Ports" feature stores a bare folder PATH and needs the localhost server to
// os.listdir it and stream the bytes, because a web page cannot enumerate a directory from a
// path string and fetch('file://...') is blocked even on file:// pages. This module does it the
// way the PC-image features do: the user GRANTS the folder once via showDirectoryPicker, the
// FileSystemDirectoryHandle is persisted in IndexedDB, and every session we re-enumerate the
// handle in pure JS and hand out blob: URLs — which both <audio> playback and
// decodeAudioData/getDecodedBuffer can consume. Listing + browser playback become fully
// serverless; only the native CABLE bridge / global hotkeys still need a running EveOS port
// (they live in the Python process).
window.EveAudioflixFsPorts = window.EveAudioflixFsPorts || {};
(function () {
    'use strict';

    const ns = window.EveAudioflixFsPorts;
    if (ns.ready) return;

    // Mirror the server-side port filter (audioflix_bridge_ports.py AUDIO_EXTENSIONS).
    const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.mp4', '.webm']);
    const registry = window.EveAudioflixFsPortsRegistry;
    if (!registry?.ready) throw new Error('Audioflix folder registry loaded out of order.');
    const {
        supported,
        allRecords,
        addFolder,
        removeFolder,
        permissionOf,
        reconcile,
        folderStates,
        reconnectAll
    } = registry;
    let liveObjectUrls = [];
    // Blobs minted for a specific TRACK path are kept apart from the soundboard listing's blobs.
    // They shared one list, so every ported-sounds refresh revoked the URL of whatever music was
    // playing at the time — the track died mid-song. These are only revoked on an explicit reset.
    let pathObjectUrls = [];

    // Enumerate every GRANTED folder (top-level audio files, matching the server port behavior)
    // into soundboard-shaped raw items. The id embeds the persisted record id + filename so the
    // existing per-item maps (portVolumes / exposedPortedSounds / portHotkeys) keep working
    // unchanged across sessions and across server/browser modes.
    // Resolve an absolute disk path to a playable blob: URL through the granted folder handles.
    //
    // A localized music track stores a real path (C:\...\All Songs\track.mp3). A browser cannot
    // open that path — fetch('file://') is blocked, and even a file:// page treats other file URLs
    // as separate origins — so playback used to go through the localhost port server and simply
    // fell silent whenever that server was not running. The handles the user already granted for
    // Browser Folders can serve the same bytes with no server at all, which is why the soundboard
    // works offline and the music library did not.
    //
    // Handles expose only their folder NAME, never an absolute path, so match on the parent folder
    // name and confirm by actually opening the file; failing that, accept any granted folder that
    // directly holds a file of that name.
    const pathBlobCache = new Map();

    const paths = window.EveAudioflixPaths;

    async function openRelativeFile(root, segments) {
        if (!root || !segments.length) return null;
        let directory = root;
        for (const segment of segments.slice(0, -1)) {
            directory = await directory.getDirectoryHandle(segment);
        }
        return directory.getFileHandle(segments[segments.length - 1]);
    }

    function browserMusicPath(recordId, segments = []) {
        const tail = segments.map((segment) => encodeURIComponent(String(segment))).join('/');
        return `fsport://${encodeURIComponent(recordId)}/${tail}`;
    }

    function parseBrowserMusicPath(value) {
        const match = String(value || '').match(/^fsport:\/\/([^/]+)\/(.*)$/i);
        if (!match) return null;
        try {
            return {
                id: decodeURIComponent(match[1]),
                segments: match[2].split('/').filter(Boolean).map(decodeURIComponent)
            };
        } catch {
            return null;
        }
    }

    async function grantedRecord(id, request = false) {
        const record = (await allRecords()).find((entry) => entry.id === id);
        if (!record?.handle) return null;
        let permission = await permissionOf(record.handle);
        if (request && permission === 'prompt' && typeof record.handle.requestPermission === 'function') {
            try { permission = await record.handle.requestPermission({ mode: 'read' }); } catch {}
        }
        return permission === 'granted' ? record : null;
    }

    async function scanMusicRecord(record) {
        if (!record?.handle) return { ok: false, reason: 'Music folder needs reconnect.' };
        const files = [];
        const queue = [{ handle: record.handle, segments: [], depth: 0 }];
        let visited = 0;
        const maxEntries = 12000, maxDepth = 32;
        while (queue.length && visited < maxEntries) {
            const current = queue.shift();
            for await (const [name, entry] of current.handle.entries()) {
                visited += 1;
                if (entry.kind === 'directory' && current.depth < maxDepth) {
                    queue.push({ handle: entry, segments: [...current.segments, name], depth: current.depth + 1 });
                } else if (entry.kind === 'file') {
                    const dot = name.lastIndexOf('.');
                    if (dot >= 0 && AUDIO_EXTENSIONS.has(name.slice(dot).toLowerCase())) {
                        const segments = [...current.segments, name];
                        files.push({
                            name,
                            path: browserMusicPath(record.id, segments),
                            relativePath: segments.join('/'),
                            subfolders: current.segments.slice()
                        });
                    }
                }
                if (visited >= maxEntries) break;
            }
        }
        files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
        return {
            ok: true,
            files,
            dir: browserMusicPath(record.id),
            browserFolderId: record.id,
            rootName: record.handle.name || record.nickname || 'Music',
            truncated: visited >= maxEntries
        };
    }

    async function scanMusicFolder(options = {}) {
        if (!supported()) return { ok: false, reason: 'Browser folder access needs Edge or Chrome.' };
        let record = options.id ? await grantedRecord(options.id, true) : null;
        if (!record) {
            const picked = await addFolder({
                id: options.id,
                nickname: options.nickname || 'Ported Music',
                purpose: 'music'
            });
            record = await grantedRecord(picked.id, true);
        }
        if (!record) return { ok: false, reason: 'Music folder access was not granted.' };
        return scanMusicRecord(record);
    }

    async function scanMusicFolderById(id) {
        if (!supported() || !id) return { ok: false, reason: 'Browser folder access is unavailable.' };
        const record = await grantedRecord(id, true);
        if (!record) return { ok: false, reason: 'Music folder needs reconnect.' };
        return scanMusicRecord(record);
    }

    // Repair stale absolute paths by searching only a bounded portion of a granted tree.
    async function findFileInTree(root, fileName, maxEntries = 1600, maxDepth = 12) {
        const wanted = String(fileName || '').toLowerCase();
        const queue = [{ handle: root, depth: 0 }];
        let visited = 0;
        let match = null;
        while (queue.length && visited < maxEntries) {
            const current = queue.shift();
            for await (const [name, entry] of current.handle.entries()) {
                visited += 1;
                if (entry.kind === 'file' && name.toLowerCase() === wanted) {
                    if (match) return null;
                    match = entry;
                }
                if (entry.kind === 'directory' && current.depth < maxDepth) {
                    queue.push({ handle: entry, depth: current.depth + 1 });
                }
                if (visited >= maxEntries) break;
            }
        }
        return match;
    }

    async function fileUrlForPath(localPath) {
        if (!supported() || !localPath) return '';
        const cacheKey = paths?.key?.(localPath) || String(localPath);
        const cached = pathBlobCache.get(cacheKey);
        if (cached) return cached;
        const browserPath = parseBrowserMusicPath(localPath);
        if (browserPath?.segments?.length) {
            const record = await grantedRecord(browserPath.id);
            if (!record) return '';
            try {
                const handle = await openRelativeFile(record.handle, browserPath.segments);
                const url = URL.createObjectURL(await handle.getFile());
                pathObjectUrls.push(url);
                pathBlobCache.set(cacheKey, url);
                return url;
            } catch {
                return '';
            }
        }
        const file = paths?.basename?.(localPath) || '';
        const dir = paths?.basename?.(paths?.dirname?.(localPath)) || '';
        if (!file) return '';

        const records = await allRecords();
        const granted = [];
        for (const rec of records) {
            if (!rec.handle) continue;
            if ((await permissionOf(rec.handle)) !== 'granted') continue;
            granted.push(rec);
        }
        // Same-named parent folder first, then any granted folder holding that filename.
        const ordered = [
            ...granted.filter((r) => String(r.handle.name || '').toLowerCase() === dir.toLowerCase()),
            ...granted.filter((r) => String(r.handle.name || '').toLowerCase() !== dir.toLowerCase())
        ];
        for (const rec of ordered) {
            try {
                const relative = paths?.relativeAfterFolder?.(localPath, rec.handle.name) || [];
                let handle = relative.length ? await openRelativeFile(rec.handle, relative) : null;
                if (!handle) handle = await rec.handle.getFileHandle(file);
                const url = URL.createObjectURL(await handle.getFile());
                pathObjectUrls.push(url);
                pathBlobCache.set(cacheKey, url);
                return url;
            } catch { /* not in this folder — keep looking */ }
        }
        for (const rec of ordered) {
            try {
                const handle = await findFileInTree(rec.handle, file);
                if (!handle) continue;
                const url = URL.createObjectURL(await handle.getFile());
                pathObjectUrls.push(url);
                pathBlobCache.set(cacheKey, url);
                return url;
            } catch { /* unreadable tree - keep looking */ }
        }
        return '';
    }

    // Health checks inspect the CURRENT tree, never a cached blob URL, so moved files are visible.
    async function verifyPath(localPath) {
        if (!supported() || !localPath) return { verified: false, present: false };
        const browserPath = parseBrowserMusicPath(localPath);
        if (browserPath?.segments?.length) {
            const record = (await allRecords()).find((entry) => entry.id === browserPath.id);
            if (!record?.handle || (await permissionOf(record.handle)) !== 'granted') return { verified: false, present: false, reason: 'needs-reconnect' };
            try {
                await openRelativeFile(record.handle, browserPath.segments);
                return { verified: true, present: true, id: record.id, rootName: record.handle.name || record.nickname || '' };
            } catch {
                return { verified: true, present: false, id: record.id, rootName: record.handle.name || record.nickname || '' };
            }
        }
        const records = await allRecords();
        let covered = false;
        for (const record of records) {
            if (!record?.handle || (await permissionOf(record.handle)) !== 'granted') continue;
            const relative = paths?.relativeAfterFolder?.(localPath, record.handle.name) || [];
            if (!relative.length) continue;
            covered = true;
            try {
                await openRelativeFile(record.handle, relative);
                return { verified: true, present: true, id: record.id, rootName: record.handle.name || record.nickname || '' };
            } catch {}
        }
        return covered ? { verified: true, present: false } : { verified: false, present: false };
    }

    // Drop cached track blobs so the next lookup re-resolves (used after a new folder is granted).
    function clearPathCache() {
        pathObjectUrls.forEach((u) => { try { URL.revokeObjectURL(u); } catch (e) { } });
        pathObjectUrls = [];
        pathBlobCache.clear();
    }

    async function listSounds() {
        if (!supported()) return [];
        liveObjectUrls.forEach((u) => { try { URL.revokeObjectURL(u); } catch (e) { } });
        liveObjectUrls = [];
        const records = await allRecords();
        const items = [];
        for (const rec of records) {
            try {
                if (rec.purpose === 'music') continue;
                if ((await permissionOf(rec.handle)) !== 'granted') continue;
                const files = [];
                for await (const [name, entry] of rec.handle.entries()) {
                    if (entry.kind !== 'file') continue;
                    const dot = name.lastIndexOf('.');
                    if (dot < 0 || !AUDIO_EXTENSIONS.has(name.slice(dot).toLowerCase())) continue;
                    files.push({ name, entry });
                }
                files.sort((a, b) => a.name.localeCompare(b.name));
                for (const f of files) {
                    const url = URL.createObjectURL(await f.entry.getFile());
                    liveObjectUrls.push(url);
                    items.push({
                        id: `ported_${rec.id}_${f.name}`,
                        title: f.name.replace(/\.[^/.]+$/, ''),
                        url,
                        category: rec.nickname
                    });
                }
            } catch (err) {
                console.warn(`[Audioflix] browser folder "${rec.nickname}" could not be read:`, err);
            }
        }
        return items;
    }

    const renderPortsManager = (...args) => window.EveAudioflixFsPortsUi.renderPortsManager(supported(), ...args);

    async function handleAction(action, id, actionTarget) {
        if (action === 'remove-port') {
            try { await removeFolder(id); await reconcile(); } catch (e) { }
            return null;
        }
        if (action === 'link-fsport') {
            try {
                await addFolder({ id, nickname: actionTarget.dataset.afNickname });
                await reconcile();
                return 'Port granted browser access — it now loads without the server';
            } catch (err) {
                if (err?.name !== 'AbortError') return err.message || 'Folder access failed';
            }
            return null;
        }
        if (action === 'regrant-fsport') {
            try {
                await addFolder({ id, nickname: actionTarget.dataset.afNickname });
                await reconcile();
                return 'Browser folder reconnected — per-item settings restored';
            } catch (err) {
                if (err?.name !== 'AbortError') return err.message || 'Folder access failed';
            }
            return null;
        }
        if (action === 'add-fsport') {
            try {
                const rec = await addFolder();
                if (rec) { await reconcile(); return `Browser folder "${rec.nickname}" connected`; }
            } catch (err) {
                if (err?.name !== 'AbortError') return err.message || 'Folder access failed';
            }
            return null;
        }
        if (action === 'remove-fsport') {
            try { await removeFolder(id); await reconcile(); } catch (e) { }
            return null;
        }
        if (action === 'reconnect-fsports') {
            try {
                const n = await reconnectAll();
                return `Reconnected ${n ?? 0} browser folder${n === 1 ? '' : 's'}`;
            } catch (err) {
                return err.message || 'Folder reconnect failed';
            }
        }
        return null;
    }

    async function loadPortedSounds(state, base, deadServerPorts) {
        const ports = state.ports || [], fetched = [], portVols = state.portVolumes || {}, portExposed = state.exposedPortedSounds || {}, portHotkeys = state.portHotkeys || {};
        let fsPortFolders = [];
        try {
            if (supported()) {
                // Surface restored-backup folders (and keep the mirror current) before listing.
                await reconcile().catch(() => {});
                fsPortFolders = await folderStates();
                if (fsPortFolders.some(f => f.permission === 'prompt')) {
                    try { await reconnectAll(); fsPortFolders = await folderStates(); } catch (e) { }
                }
            }
        } catch (err) { console.error('Failed to read browser folder ports:', err); }
        const grantedFs = new Set(fsPortFolders.filter(f => f.permission === 'granted').map(f => f.id));
        for (const p of ports) {
            if (grantedFs.has(p.id)) continue;
            try {
                const res = await fetch(`${base}/api/audioflix/port/list?path=${encodeURIComponent(p.path)}`), data = await res.json();
                if (data.ok && Array.isArray(data.files)) data.files.forEach(f => {
                    const id = `ported_${p.id}_${f.name}`;
                    fetched.push({ id, type: 'sound', title: f.name.replace(/\.[^/.]+$/, ""), url: `${base}/api/audioflix/port/file?path=${encodeURIComponent(f.path)}`, category: p.nickname, isPorted: true, volume: portVols[id] ?? 1, exposed: portExposed[id] === true, hotkey: portHotkeys[id] ?? '' });
                });
                else if (!data.ok) deadServerPorts.add(p.id);
            } catch (err) { deadServerPorts.add(p.id); console.error(`Failed to load port: ${p.nickname}`, err); }
        }
        try {
            if (supported()) (await listSounds()).forEach(r => {
                fetched.push({ ...r, type: 'sound', isPorted: true, volume: portVols[r.id] ?? 1, exposed: portExposed[r.id] === true, hotkey: portHotkeys[r.id] ?? '' });
            });
        } catch (err) { console.error('Failed to load browser folder ports:', err); }
        return { fetched, fsPortFolders };
    }

    Object.assign(ns, {
        ready: true,
        supported,
        fileUrlForPath,
        verifyPath,
        scanMusicFolder,
        scanMusicFolderById,
        clearPathCache,
        addFolder,
        removeFolder,
        folderStates,
        reconnectAll,
        listSounds,
        renderPortsManager,
        handleAction,
        loadPortedSounds,
        reconcile
    });
})();
