// Browser-folder reconcile smoke: proves a backed-up Browser Folder (fsport) that has NO
// granted handle in this browser (incognito reload / new machine) is materialized as a stub
// that shows "Needs reconnect", without losing its per-item identity.
//
// The other audioflix smokes run headless where showDirectoryPicker is absent, so fsports'
// supported() is false and reconcile() no-ops. Here we stub showDirectoryPicker to a function
// so supported() is true and the real IndexedDB reconcile path runs.
const path = require('path');
const { launchChromiumOrConnect, waitForEveCoreHydrated } = require('./playwright-browser');
const FILE_URL = 'file:///' + path.join(path.resolve(__dirname, '..', '..'), 'EveOS.html').replace(/\\/g, '/');

(async () => {
    const { browser } = await launchChromiumOrConnect({ headless: true });
    const page = await browser.newPage();
    await page.addInitScript(() => {
        try { localStorage.clear(); } catch {}
        window.__eveSmokeNoAutoGemini = true;
        // Make fsports.supported() true (it checks typeof showDirectoryPicker === 'function').
        // We never call it in this test — reconcile only materializes stubs from the mirror.
        if (typeof window.showDirectoryPicker !== 'function') {
            window.showDirectoryPicker = async () => { throw new Error('picker not available in test'); };
        }
    });
    await page.goto(FILE_URL, { waitUntil: 'load', timeout: 180000 });
    await waitForEveCoreHydrated(page);
    await page.waitForFunction(() => !!(window.EveAudioflixState && window.EveAudioflixState.ready)
        && !!(window.EveAudioflixFsPorts && window.EveAudioflixFsPorts.ready)
        && !!(window.EveAudioflixUiActionsLocalize && window.EveAudioflixUiActionsLocalize.ready),
    undefined, { timeout: 60000 });

    const result = await page.evaluate(async () => {
        const wipeDb = () => new Promise((resolve) => {
            const req = indexedDB.deleteDatabase('eve-audioflix-fsports');
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
        });
        const rawRecords = () => new Promise((resolve, reject) => {
            const open = indexedDB.open('eve-audioflix-fsports', 1);
            open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains('folders')) open.result.createObjectStore('folders', { keyPath: 'id' }); };
            open.onsuccess = () => {
                const db = open.result;
                const t = db.transaction('folders', 'readonly');
                const g = t.objectStore('folders').getAll();
                g.onsuccess = () => { resolve(g.result || []); db.close(); };
                g.onerror = () => { reject(g.error); db.close(); };
            };
            open.onerror = () => reject(open.error);
        });

        await wipeDb();
        if (!window.EveAudioflixFsPorts.supported()) return { skip: 'showDirectoryPicker not a function' };

        // Simulate a restored backup: the mirror has a folder, IndexedDB has no handle for it.
        window.EveAudioflixState.replaceState({
            browserFolders: [{ id: 'fsp_echo', nickname: 'Echo-Like-Connect', purpose: 'music', addedAt: 7 }],
            music: [], musicFolders: [], musicPortConnections: []
        }, 'reconcile-smoke');
        await window.EveAudioflixFsPorts.reconcile();

        const states = await window.EveAudioflixFsPorts.folderStates();
        const records = await rawRecords();
        const sounds = await window.EveAudioflixFsPorts.listSounds();
        const liveState = window.EveAudioflixState.ensure();
        const mirror = liveState.browserFolders || [];
        const surfaced = states.some((f) => f.id === 'fsp_echo' && f.nickname === 'Echo-Like-Connect' && f.permission === 'prompt');
        const musicSourceRecovered = (liveState.musicFolders || []).includes('Echo-Like-Connect')
            && (liveState.musicPortConnections || []).some((entry) => (
                entry.browserFolderId === 'fsp_echo'
                && entry.folder === 'Echo-Like-Connect'
                && String(entry.path || '').startsWith('fsport://')
            ));
        const stub = records.some((r) => r.id === 'fsp_echo' && !r.handle);
        const mirrorInSync = mirror.filter((f) => f.id === 'fsp_echo').length === 1;
        let liveRefreshes = 0;
        const actionContext = {
            playbackStatus: '',
            rerender() {},
            async loadPortedSounds() { liveRefreshes += 1; }
        };
        const handleAction = window.EveAudioflixUiActionsLocalize.create(actionContext);
        await handleAction({ dataset: { afId: 'fsp_echo' } }, 'remove-music-fsport');
        const afterRemoveRecords = await rawRecords();
        const afterRemoveMirror = window.EveAudioflixState.ensure().browserFolders || [];
        return {
            // The restored folder surfaces as a needs-reconnect entry...
            surfaced,
            // ...backed by a stub record with no handle (can't cross browser boundaries)...
            stub,
            // ...the mirror stays in sync (no duplication)...
            mirrorInSync,
            // A persisted music handle is enough to reconstruct a resync-able Music Port stub,
            // even if the large Audioflix state lost its track/source arrays.
            musicSourceRecovered,
            // ...and enumerating sounds skips the un-granted stub without throwing.
            listSafe: Array.isArray(sounds) && sounds.every((s) => !String(s.id).includes('fsp_echo')),
            removedLive: !afterRemoveRecords.some((r) => r.id === 'fsp_echo')
                && !afterRemoveMirror.some((f) => f.id === 'fsp_echo')
                && liveRefreshes === 1
        };
    });

    await browser.close();
    if (result.skip) { console.log('AUDIOFLIX_BROWSER_FOLDER_RECONCILE_SKIPPED: ' + result.skip); return; }
    const fails = [];
    if (!result.surfaced) fails.push('restored folder did not surface as needs-reconnect');
    if (!result.stub) fails.push('no handle-less stub record was created for the restored folder');
    if (!result.mirrorInSync) fails.push('browserFolders mirror diverged / duplicated');
    if (!result.musicSourceRecovered) fails.push('music folder handle did not reconstruct a Music Port source stub');
    if (!result.listSafe) fails.push('listSounds did not skip the un-granted stub');
    if (!result.removedLive) fails.push('remove action did not persist and refresh live folder state');
    if (fails.length) { console.error('FAIL: ' + fails.join('; ')); process.exit(1); }
    console.log('AUDIOFLIX_BROWSER_FOLDER_RECONCILE_OK');
})().catch((e) => { console.error(e); process.exit(1); });
