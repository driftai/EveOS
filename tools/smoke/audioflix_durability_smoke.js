const path = require('path');
const { launchChromiumOrConnect, waitForEveCoreHydrated } = require('./playwright-browser');
const seedDurabilityFixture = require('./helpers/audioflix_durability_fixture');
const FILE_URL = 'file:///' + path.join(path.resolve(__dirname, '..', '..'), 'EveOS.html').replace(/\\/g, '/');

(async () => {
    const { browser } = await launchChromiumOrConnect({ headless: true });
    const page = await browser.newPage();
    await page.addInitScript(() => { try { localStorage.clear(); } catch {} window.__eveSmokeNoAutoGemini = true; });
    await page.goto(FILE_URL, { waitUntil: 'load', timeout: 180000 });
    await waitForEveCoreHydrated(page);
    await page.waitForFunction(() => !!window.EveAudioflixState && !!(window.EveDataStore && window.EveDataStore.Store && window.EveDataStore.Store.captureState && window.EveDataStore.Store.applyState), undefined, { timeout: 60000 });

    // 1. Seed every user-content surface that must travel with a datapack.
    await page.evaluate(seedDurabilityFixture);

    // A stale monolithic config snapshot must not outrank the newer Audioflix mirror merely
    // because Soundboard/recent-play data keeps the stale snapshot technically non-empty.
    const staleConfigRecoveryOk = await page.evaluate(() => {
        window.EveAudioflixState.flush('durability-stale-config-seed');
        const rich = JSON.parse(localStorage.getItem('eveAudioflixFallbackState') || '{}');
        const stale = {
            durabilityRevision: Math.max(0, Number(rich.durabilityRevision || 0) - 1),
            soundboard: [{ id: 'stale-sound', title: 'Stale Sound', url: 'media/stale.wav' }],
            recentPlays: [{ id: 'stale-sound', type: 'sound', title: 'Stale Sound', at: Date.now() }],
            music: [], musicGroups: [], musicGroupMap: {}, musicFolders: [],
            musicPlaylists: [], musicPortConnections: []
        };
        window.eveState.config.audioflix = stale;
        const recovered = window.EveAudioflixState.ensure();
        return (recovered.music || []).some((item) => item.id === 'rt-music')
            && (recovered.musicGroups || []).includes('Night')
            && (recovered.musicPortConnections || []).some((entry) => entry.id === 'music-port-rt')
            && !(recovered.soundboard || []).some((item) => item.id === 'stale-sound');
    });

    // 2. Capture (the backup path) -> must include routing plus sound/music content.
    const captureOk = await page.evaluate(() => {
        const cap = window.EveDataStore.Store.captureState();
        const a = cap && cap.audioflix;
        return !!(a
            && (a.ports || []).some(p => p.nickname === 'RTPort')
            && (a.soundboardGroups || []).includes('RTGroup')
            && (a.soundboard || []).some(item => (
                item.id === 'rt-sound'
                && item.volume === 0
                && item.localPath === 'C:/rt/sounds/rt.wav'
                && item.category === 'Alerts'
                && item.hotkey === 'ctrl+shift+r'
                && item.exposed === true
            ))
            && (a.music || []).some(item => (
                item.id === 'rt-music'
                && item.volume === 0.62
                && item.localPath === 'C:/rt/music/Sleep/Disc 1/RT Music.mp3'
                && item.localizations?.length === 2
                && item.classifiers?.join('|') === 'Sleep|Manual'
                && item.artist === 'Runtime Artist'
                && item.folder === 'Sleep'
                && item.category === 'Ambient'
                && item.duration === 321
                && item.playlistId === 'playlist-rt'
                && item.sourceId === 'source-rt'
                && item.upstreamMissing === true
                && item.createdAt === 101
                && item.updatedAt === 202
                && item.lastPlayedAt === 303
            ))
            && a.musicGroupMap?.['rt-music']?.includes('Night')
            && a.soundGroupMap?.['rt-sound']?.includes('RTGroup')
            && (a.musicClassifiers || []).includes('Manual')
            && (a.musicPlaylists || []).some(item => item.id === 'playlist-rt')
            && (a.musicPortConnections || []).some(item => item.id === 'music-port-rt')
            && a.localizeScopeDirs?.['folder:Sleep'] === 'C:/rt/music/Sleep'
            && (a.dupDismissedPairs || []).includes('rt-music|rt-sound')
            && a.portVolumes?.['rt-sound'] === 0
            && a.exposedPortedSounds?.['rt-sound'] === true
            && a.portHotkeys?.['rt-sound'] === 'ctrl+shift+r'
            && (a.scopeBindings || []).some(binding => (
                binding.audioId === 'rt-music'
                && binding.scopeType === 'card'
                && binding.categoryName === 'RT Card'
            ))
            && !cap.bookmarks.config.audioflix);
    });

    // 3. Scoped backups carry only canonical items linked inside that scope. Applying one
    // merges those items/references without replacing unrelated Audioflix content.
    const scopedResult = await page.evaluate(() => {
        const original = window.EveDataStore.Store.captureState();
        const scoped = window.EveDataStore.Store.captureWorkspace('main');
        const scopedAudio = scoped.audioflix || {};
        const capturedCleanly = scopedAudio.scoped === true
            && (scopedAudio.music || []).some(item => item.id === 'rt-music')
            && (scopedAudio.soundboard || []).some(item => item.id === 'rt-sound')
            && !(scopedAudio.music || []).some(item => item.id === 'other-music')
            && (scopedAudio.scopeBindings || []).every(binding => binding.workspaceId === 'main')
            && scopedAudio.musicGroupMap?.['rt-music']?.includes('Night')
            && scopedAudio.soundGroupMap?.['rt-sound']?.includes('RTGroup')
            && (scopedAudio.musicClassifiers || []).includes('Manual')
            && (scopedAudio.musicPlaylists || []).some(item => item.id === 'playlist-rt')
            && (scopedAudio.musicPortConnections || []).some(item => item.id === 'music-port-rt')
            && scopedAudio.localizeScopeDirs?.['folder:Sleep'] === 'C:/rt/music/Sleep'
            && scopedAudio.localizeScopeDirs?.['group:Night'] === 'C:/rt/music/Night'
            && (scopedAudio.dupDismissedPairs || []).includes('rt-music|rt-sound')
            && scopedAudio.portVolumes?.['rt-sound'] === 0
            && scopedAudio.exposedPortedSounds?.['rt-sound'] === true
            && scopedAudio.portHotkeys?.['rt-sound'] === 'ctrl+shift+r';

        window.EveAudioflixState.replaceState({
            music: [{ id: 'preserved-music', title: 'Preserved Music', url: 'media/preserved.mp3' }],
            soundboard: [],
            scopeBindings: []
        }, 'scoped-smoke-wipe');
        window.EveDataStore.Store.applyWorkspaceState(scoped);
        const restored = window.EveAudioflixState.ensure();
        const passed = capturedCleanly
            && restored.music.some(item => item.id === 'rt-music')
            && restored.music.some(item => item.id === 'preserved-music')
            && restored.soundboard.some(item => item.id === 'rt-sound')
            && restored.music.find(item => item.id === 'rt-music')?.localizations?.length === 2
            && restored.musicGroupMap?.['rt-music']?.includes('Night')
            && (restored.musicClassifiers || []).includes('Manual')
            && (restored.musicPortConnections || []).some(item => item.id === 'music-port-rt')
            && restored.localizeScopeDirs?.['folder:Sleep'] === 'C:/rt/music/Sleep'
            && restored.scopeBindings.some(binding => (
                binding.audioId === 'rt-music'
                && binding.workspaceId === 'main'
                && binding.categoryName === 'RT Card'
            ));
        const result = {
            passed,
            capturedMusic: (scopedAudio.music || []).map(item => item.id),
            capturedBindings: (scopedAudio.scopeBindings || []).map(binding => ({
                audioId: binding.audioId,
                scopeType: binding.scopeType,
                workspaceId: binding.workspaceId,
                categoryName: binding.categoryName
            })),
            restoredMusic: restored.music.map(item => item.id),
            restoredBindings: restored.scopeBindings.map(binding => ({
                audioId: binding.audioId,
                scopeType: binding.scopeType,
                workspaceId: binding.workspaceId,
                categoryName: binding.categoryName
            }))
        };
        window.EveDataStore.Store.applyState(original);
        return result;
    });

    const cardScopedResult = await page.evaluate(() => {
        const original = window.EveDataStore.Store.captureState();
        const scoped = window.EveDataStore.Store.captureCard('main', 'RT Card');
        const scopedAudio = scoped.audioflix || {};
        const capturedCleanly = scopedAudio.scoped === true
            && (scopedAudio.music || []).some(item => item.id === 'rt-music')
            && (scopedAudio.soundboard || []).some(item => item.id === 'rt-sound')
            && !(scopedAudio.music || []).some(item => item.id === 'main-workspace-music')
            && (scopedAudio.scopeBindings || []).every(binding => binding.scopeType !== 'workspace')
            && scopedAudio.musicGroupMap?.['rt-music']?.includes('Night')
            && (scopedAudio.musicPortConnections || []).some(item => item.id === 'music-port-rt')
            && scopedAudio.localizeScopeDirs?.['folder:Sleep'] === 'C:/rt/music/Sleep';

        window.EveAudioflixState.replaceState({
            music: [{ id: 'card-preserved', title: 'Card Preserved', url: 'media/card-preserved.mp3' }],
            soundboard: [],
            scopeBindings: []
        }, 'card-scoped-smoke-wipe');
        window.EveDataStore.Store.applyCardState(scoped);
        const restored = window.EveAudioflixState.ensure();
        const result = {
            passed: capturedCleanly
                && restored.music.some(item => item.id === 'rt-music')
                && restored.music.some(item => item.id === 'card-preserved')
                && restored.soundboard.some(item => item.id === 'rt-sound')
                && restored.music.find(item => item.id === 'rt-music')?.classifiers?.includes('Manual')
                && restored.scopeBindings.some(binding => (
                    binding.audioId === 'rt-music'
                    && binding.scopeType === 'card'
                    && binding.workspaceId === 'main'
                    && binding.categoryName === 'RT Card'
                )),
            capturedMusic: (scopedAudio.music || []).map(item => item.id),
            restoredMusic: restored.music.map(item => item.id)
        };
        window.EveDataStore.Store.applyState(original);
        return result;
    });

    const folderScopedResult = await page.evaluate(() => {
        const original = window.EveDataStore.Store.captureState();
        const scoped = window.EveDataStore.Store.captureFolder('main', 'RT Card', 'folder-root');
        const scopedAudio = scoped.audioflix || {};
        const capturedIds = (scopedAudio.music || []).map((item) => item.id).sort();
        const capturedCleanly = scopedAudio.scoped === true
            && capturedIds.join('|') === ['bookmark-music', 'folder-music'].sort().join('|')
            && (scopedAudio.scopeBindings || []).every((binding) => (
                binding.scopeType === 'folder' || binding.scopeType === 'bookmark'
            ));

        window.EveAudioflixState.replaceState({
            music: [{ id: 'folder-preserved', title: 'Folder Preserved', url: 'media/folder-preserved.mp3' }],
            soundboard: [],
            scopeBindings: []
        }, 'folder-scoped-smoke-wipe');
        window.EveDataStore.Store.applyFolderState(scoped);
        const restored = window.EveAudioflixState.ensure();
        const result = {
            passed: capturedCleanly
                && restored.music.some((item) => item.id === 'folder-music')
                && restored.music.some((item) => item.id === 'bookmark-music')
                && restored.music.some((item) => item.id === 'folder-preserved')
                && restored.scopeBindings.some((binding) => (
                    binding.audioId === 'folder-music'
                    && binding.scopeType === 'folder'
                    && binding.folderId === 'folder-root'
                ))
                && restored.scopeBindings.some((binding) => (
                    binding.audioId === 'bookmark-music'
                    && binding.scopeType === 'bookmark'
                    && binding.bookmarkId === 'bookmark-child'
                )),
            capturedIds,
            restoredMusic: restored.music.map((item) => item.id)
        };
        window.EveDataStore.Store.applyState(original);
        return result;
    });

    const bookmarkScopedResult = await page.evaluate(() => {
        const original = window.EveDataStore.Store.captureState();
        const scoped = window.EveDataStore.Store.captureBookmark('main', 'RT Card', 'bookmark-child');
        const scopedAudio = scoped.audioflix || {};
        const capturedCleanly = scopedAudio.scoped === true
            && (scopedAudio.music || []).map((item) => item.id).join('|') === 'bookmark-music'
            && (scopedAudio.scopeBindings || []).every((binding) => (
                binding.scopeType === 'bookmark' && binding.bookmarkId === 'bookmark-child'
            ));

        window.EveAudioflixState.replaceState({
            music: [{ id: 'bookmark-preserved', title: 'Bookmark Preserved', url: 'media/bookmark-preserved.mp3' }],
            soundboard: [],
            scopeBindings: []
        }, 'bookmark-scoped-smoke-wipe');
        window.EveDataStore.Store.applyBookmarkState(scoped);
        const restored = window.EveAudioflixState.ensure();
        const result = {
            passed: capturedCleanly
                && restored.music.some((item) => item.id === 'bookmark-music')
                && restored.music.some((item) => item.id === 'bookmark-preserved')
                && restored.scopeBindings.some((binding) => (
                    binding.audioId === 'bookmark-music'
                    && binding.scopeType === 'bookmark'
                    && binding.bookmarkId === 'bookmark-child'
                )),
            capturedMusic: (scopedAudio.music || []).map((item) => item.id),
            restoredMusic: restored.music.map((item) => item.id)
        };
        window.EveDataStore.Store.applyState(original);
        return result;
    });

    // 4. Wipe Audioflix, restore the captured datapack, then verify all content returns.
    const restoreOk = await page.evaluate(() => {
        const cap = window.EveDataStore.Store.captureState();          // snapshot WITH our data
        window.EveAudioflixState.replaceState({ soundboard: [], music: [], ports: [], soundboardGroups: [] }, 'smoke-wipe');
        window.EveDataStore.Store.applyState(cap);                     // restore
        const a = window.eveState.config.audioflix || {};
        return (a.ports || []).some(p => p.nickname === 'RTPort')
            && (a.soundboardGroups || []).includes('RTGroup')
            && (a.soundboard || []).some(item => item.id === 'rt-sound' && item.localPath === 'C:/rt/sounds/rt.wav')
            && (a.music || []).some(item => (
                item.id === 'rt-music'
                && item.url === 'https://example.com/watch?v=rt'
                && item.localPath === 'C:/rt/music/Sleep/Disc 1/RT Music.mp3'
                && item.localizations?.some(entry => entry.source === 'folder:Sleep')
                && item.classifiers?.includes('Manual')
                && item.folder === 'Sleep'
                && item.playlistId === 'playlist-rt'
            ))
            && a.musicGroupMap?.['rt-music']?.includes('Night')
            && a.soundGroupMap?.['rt-sound']?.includes('RTGroup')
            && (a.musicPlaylists || []).some(item => item.id === 'playlist-rt')
            && (a.musicPortConnections || []).some(item => item.id === 'music-port-rt')
            && a.localizeScopeDirs?.['folder:Sleep'] === 'C:/rt/music/Sleep'
            && a.portHotkeys?.['rt-sound'] === 'ctrl+shift+r'
            && (a.scopeBindings || []).some(binding => binding.audioId === 'rt-music');
    });

    // 5. An explicitly empty Audioflix datapack must stay empty; stale fallback metadata
    // must not silently repopulate sounds or music after load.
    const clearResult = await page.evaluate(() => {
        let stopCalls = 0;
        const originalStopAll = window.EveAudioflixAudio.stopAll;
        window.EveAudioflixAudio.stopAll = async () => { stopCalls += 1; };
        const cap = window.EveDataStore.Store.captureState();
        cap.audioflix = { soundboard: [], music: [], ports: [], soundboardGroups: [], scopeBindings: [] };
        cap.bookmarks.config.audioflix = cap.audioflix;
        window.EveDataStore.Store.applyState(cap);
        const a = window.EveAudioflixState.ensure();
        window.EveAudioflixAudio.stopAll = originalStopAll;
        return {
            cleared: a.soundboard.length === 0
                && a.music.length === 0
                && a.ports.length === 0
                && a.scopeBindings.length === 0
                && a.musicGroups.length === 0
                && Object.keys(a.musicGroupMap).length === 0
                && a.musicPlaylists.length === 0
                && a.musicPortConnections.length === 0
                && a.musicClassifiers.length === 0
                && Object.keys(a.localizeScopeDirs).length === 0
                && a.dupDismissedPairs.length === 0,
            stopCalls
        };
    });

    // 6. Backups created before Audioflix existed have no Audioflix key. Restoring one must
    // preserve the current library/settings because absence is not an explicit request to clear it.
    const absentPreservesOk = await page.evaluate(() => {
        window.EveAudioflixState.update({
            nativeBridgeBase: 'http://127.0.0.1:9876',
            routeMode: 'manual'
        }, 'legacy-route-preserve');
        window.EveAudioflixState.addItem('sound', { id: 'leak-check', title: 'Leak Check', url: 'media/leak.wav' });
        const legacy = window.EveDataStore.Store.captureState();
        delete legacy.audioflix;
        if (legacy.bookmarks?.config) delete legacy.bookmarks.config.audioflix;
        window.EveDataStore.Store.applyState(legacy);
        const a = window.EveAudioflixState.ensure();
        return a.soundboard.some((item) => item.id === 'leak-check')
            && a.music.length === 0
            && a.nativeBridgeBase === 'http://127.0.0.1:9876'
            && a.routeMode === 'manual';
    });

    // 7. An immediate page exit must flush the pending debounce so a quick reload cannot
    // discard the last Audioflix edit.
    const pagehideFlushOk = await page.evaluate(() => {
        window.EveAudioflixState.addItem('music', { id: 'exit-save', title: 'Exit Save', url: 'media/exit-save.mp3' });
        window.dispatchEvent(new Event('pagehide'));
        const fallback = JSON.parse(localStorage.getItem('eveAudioflixFallbackState') || '{}');
        return (fallback.music || []).some((item) => item.id === 'exit-save');
    });

    await browser.close();
    const fails = [];
    if (!staleConfigRecoveryOk) fails.push('newer Audioflix fallback did not defeat a stale partial core-config rollback');
    if (!captureOk) fails.push('captureState() did NOT include audioflix ports/groups');
    if (!scopedResult.passed) {
        fails.push(`scoped Audioflix capture/merge leaked or replaced unrelated content: ${JSON.stringify(scopedResult)}`);
    }
    if (!cardScopedResult.passed) {
        fails.push(`card Audioflix capture/merge leaked inherited workspace content: ${JSON.stringify(cardScopedResult)}`);
    }
    if (!folderScopedResult.passed) {
        fails.push(`folder Audioflix capture/merge leaked parent or outside content: ${JSON.stringify(folderScopedResult)}`);
    }
    if (!bookmarkScopedResult.passed) {
        fails.push(`bookmark Audioflix capture/merge leaked inherited content: ${JSON.stringify(bookmarkScopedResult)}`);
    }
    if (!restoreOk) fails.push('applyState() did NOT restore audioflix ports/groups');
    if (!clearResult.cleared) fails.push('explicitly empty Audioflix state was repopulated by fallback data');
    if (clearResult.stopCalls !== 1) fails.push('datapack replacement did not stop previous Audioflix playback');
    if (!absentPreservesOk) fails.push('legacy datapack without Audioflix did not preserve current Audioflix state');
    if (!pagehideFlushOk) fails.push('pending Audioflix edit was lost during pagehide');
    if (fails.length) { console.error('FAIL: ' + fails.join('; ')); process.exit(1); }
    console.log('AUDIOFLIX_DURABILITY_RT_OK');
})().catch(e => { console.error(e); process.exit(1); });
