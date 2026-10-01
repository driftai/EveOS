// JSON-only backup round-trip smoke for Audioflix (file:// / browser-only mode).
//
// Drift reported that after a "Backup All Data JSON Only" export and re-import (fresh
// incognito tab), the Audioflix datapack did not come back. This drives the REAL
// window.exportDataJsonOnly() download, captures the produced JSON blob, and feeds it back
// through the same unified-restore action the importer runs (applyState) — asserting the
// soundboard/music/ports/groups survive the file, and that the restore persists to the
// fallback store a reload reads from.
const path = require('path');
const { chromium } = require('playwright');
const FILE_URL = 'file:///' + path.join(path.resolve(__dirname, '..', '..'), 'EveOS.html').replace(/\\/g, '/');

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.addInitScript(() => {
        try { localStorage.clear(); } catch {}
        window.__eveSmokeNoAutoGemini = true;
        // Capture every JSON blob handed to a download so we can read the exact backup file
        // bytes exportDataJsonOnly() produced, instead of re-deriving them.
        window.__eveCapturedBackupBlobs = [];
        const originalCreate = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (blob) => {
            try { window.__eveCapturedBackupBlobs.push(blob); } catch {}
            return originalCreate(blob);
        };
    });
    await page.goto(FILE_URL, { waitUntil: 'load', timeout: 180000 });
    await page.waitForFunction(() => !!window.EveAudioflixState
        && !!(window.EveDataStore && window.EveDataStore.Store && window.EveDataStore.Store.applyState)
        && typeof window.exportDataJsonOnly === 'function', undefined, { timeout: 60000 });

    // 1. Seed Audioflix content that must survive a JSON backup + restore.
    await page.evaluate(() => {
        window.EveAudioflixState.addPort({ nickname: 'JsonPort', path: 'C:/json/sounds' });
        window.EveAudioflixState.addSoundboardGroup('JsonGroup');
        window.EveAudioflixState.addItem('sound', { id: 'json-sound', title: 'JSON Sound', url: 'media/json.wav', volume: 0.4 });
        window.EveAudioflixState.addItem('music', { id: 'json-music', title: 'JSON Music', url: 'https://example.com/watch?v=json', volume: 0.9, folder: 'Json Folder', card: 'Json Folder', classifiers: ['Json Label'] });
        window.EveAudioflixState.addMusicGroup('JsonMusicGroup');
        window.EveAudioflixState.toggleMusicGroup('json-music', 'JsonMusicGroup', true);
        window.EveAudioflixState.addItem('music', {
            id: 'json-spotify',
            title: 'Spotify JSON Music',
            url: 'https://open.spotify.com/track/spotifyJson123',
            artist: 'Backup Artist',
            album: 'Backup Album',
            image: 'https://i.scdn.co/image/backup',
            explicit: true,
            sourceProvider: 'spotify',
            playlistPosition: 7,
            playlistId: 'json-spotify-playlist',
            sourceId: 'spotifyJson123'
        });
        window.EveAudioflixState.update({
            musicPortConnections: [{
                id: 'json-music-port',
                path: 'C:/json/music',
                folder: 'Json Folder',
                browserFolderId: 'json-browser-folder',
                browserRootName: 'music',
                trackCount: 1
            }],
            musicPlaylists: [{
                id: 'json-spotify-playlist',
                url: 'https://open.spotify.com/playlist/spotifyPlaylist123',
                playlistId: 'spotifyPlaylist123',
                title: 'Spotify Backup Playlist',
                provider: 'spotify',
                group: 'Spotify Backup Playlist',
                folder: 'Spotify Playlists',
                owner: 'Backup Owner',
                description: 'Saved-session metadata',
                image: 'https://i.scdn.co/image/playlist-backup',
                embedUrl: 'https://open.spotify.com/embed/playlist/spotifyPlaylist123',
                scrapeSource: 'saved-session',
                trackCount: 1
            }]
        }, 'json-smoke-spotify');
        const soundLab = window.EveAudioflixSoundLabState.ensure();
        window.EveAudioflixSoundLabState.update({
            effects: window.EveAudioflixSoundLabState.cleanEffects({
                ...soundLab.effects,
                delay: { ...soundLab.effects.delay, enabled: true, mix: 0.23 }
            }),
            modulation: {
                ...soundLab.modulation,
                enabled: true,
                lowToFilter: { enabled: true, depth: 0.64 }
            },
            diagnostics: { ...soundLab.diagnostics, showTelemetry: false },
            render: {
                ...soundLab.render,
                name: 'JSON Render Lane',
                prompt: 'backup-safe rendered music'
            }
        }, 'json-smoke-soundlab');
        window.EveAudioflixSoundLabState.captureSceneSlot('a');
    });

    // 2. Run the REAL JSON-only backup and read the produced blob's text.
    const exportedText = await page.evaluate(async () => {
        window.__eveCapturedBackupBlobs = [];
        // Silence the download click + toast side effects; we only want the blob bytes.
        const originalClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {};
        try {
            window.exportDataJsonOnly();
        } finally {
            HTMLAnchorElement.prototype.click = originalClick;
        }
        const blob = window.__eveCapturedBackupBlobs[window.__eveCapturedBackupBlobs.length - 1];
        return blob ? await blob.text() : '';
    });

    let parsed = null;
    try { parsed = JSON.parse(exportedText); } catch { parsed = null; }
    const inFile = parsed && parsed.audioflix ? parsed.audioflix : null;
    const structure = parsed && parsed.audioflixStructure ? parsed.audioflixStructure : null;
    const structureOk = !!(structure
        && !Object.prototype.hasOwnProperty.call(structure, 'music')
        && !Object.prototype.hasOwnProperty.call(structure, 'soundboard')
        && (structure.musicFolders || []).includes('Json Folder')
        && (structure.musicGroups || []).includes('JsonMusicGroup')
        && (structure.musicPortConnections || []).some((entry) => entry.id === 'json-music-port')
        && (structure.musicRefs || []).some((ref) => (
            ref.id === 'json-music'
            && ref.folder === 'Json Folder'
            && (ref.classifiers || []).includes('Json Label')
            && (ref.groups || []).includes('JsonMusicGroup')
            && !Object.prototype.hasOwnProperty.call(ref, 'url')
        )));
    const fileOk = !!(inFile
        && (inFile.ports || []).some((p) => p.nickname === 'JsonPort')
        && (inFile.soundboardGroups || []).includes('JsonGroup')
        && (inFile.soundboard || []).some((item) => item.id === 'json-sound' && item.volume === 0.4)
        && (inFile.music || []).some((item) => item.id === 'json-music' && item.volume === 0.9)
        && (inFile.music || []).some((item) => item.id === 'json-spotify'
            && item.sourceProvider === 'spotify'
            && item.album === 'Backup Album'
            && item.explicit === true
            && item.playlistPosition === 7)
        && (inFile.musicPlaylists || []).some((item) => item.id === 'json-spotify-playlist'
            && item.provider === 'spotify'
            && item.owner === 'Backup Owner'
            && item.embedUrl.includes('/embed/playlist/'))
        && inFile.soundLab?.schemaVersion === 3
        && inFile.soundLab?.effects?.delay?.enabled === true
        && inFile.soundLab?.effects?.delay?.mix === 0.23
        && inFile.soundLab?.modulation?.lowToFilter?.depth === 0.64
        && inFile.soundLab?.diagnostics?.showTelemetry === false
        && inFile.soundLab?.render?.name === 'JSON Render Lane'
        && inFile.soundLab?.sceneSlots?.a?.effects?.delay?.enabled === true);
    // The unified importer keys on metadata+bookmarks+library; the file must satisfy that too.
    const unifiedShapeOk = !!(parsed && parsed.metadata && parsed.bookmarks && parsed.library);

    // 3. Wipe Audioflix, then restore straight from the exported JSON text via the same
    //    applyState the importer calls after the "Restore Unified Backup?" confirm.
    const restore = await page.evaluate((jsonText) => {
        window.EveAudioflixState.replaceState({ soundboard: [], music: [], ports: [], soundboardGroups: [] }, 'json-smoke-wipe');
        const state = JSON.parse(jsonText);
        const applied = window.EveDataStore.Store.applyState(state);
        const live = window.eveState.config.audioflix || {};
        const fallback = JSON.parse(localStorage.getItem('eveAudioflixFallbackState') || '{}');
        return {
            applied,
            liveOk: (live.ports || []).some((p) => p.nickname === 'JsonPort')
                && (live.soundboardGroups || []).includes('JsonGroup')
                && (live.soundboard || []).some((item) => item.id === 'json-sound')
                && (live.music || []).some((item) => item.id === 'json-music')
                && (live.music || []).some((item) => item.id === 'json-spotify' && item.sourceProvider === 'spotify')
                && (live.musicPlaylists || []).some((item) => item.id === 'json-spotify-playlist' && item.owner === 'Backup Owner')
                && live.soundLab?.schemaVersion === 3
                && live.soundLab?.effects?.delay?.mix === 0.23
                && live.soundLab?.sceneSlots?.a?.effects?.delay?.enabled === true,
            // A fresh reload rebuilds Audioflix from this fallback (file:// has no server),
            // so the restored content must be written there, not just held in memory.
            fallbackOk: (fallback.ports || []).some((p) => p.nickname === 'JsonPort')
                && (fallback.soundboard || []).some((item) => item.id === 'json-sound')
                && (fallback.music || []).some((item) => item.id === 'json-music')
                && (fallback.music || []).some((item) => item.id === 'json-spotify' && item.playlistPosition === 7)
                && (fallback.musicPlaylists || []).some((item) => item.id === 'json-spotify-playlist' && item.provider === 'spotify')
                && fallback.soundLab?.schemaVersion === 3
                && fallback.soundLab?.modulation?.enabled === true
                && fallback.soundLab?.render?.prompt === 'backup-safe rendered music'
        };
    }, exportedText);

    // 4. A topology-only backup restores folders/groups/source provenance without manufacturing
    // playable song records. Reimports can later reclaim their labels by source/path identity.
    const structuralOnly = await page.evaluate((jsonText) => {
        const state = JSON.parse(jsonText);
        delete state.audioflix;
        window.EveAudioflixState.replaceDatapackState({
            soundboard: [], music: [], ports: [], browserFolders: [],
            soundboardGroups: [], soundGroupMap: {},
            musicFolders: [], musicGroups: [], musicGroupMap: {},
            musicPlaylists: [], musicPortConnections: [], musicClassifiers: [],
            localizeScopeDirs: {}, scopeBindings: []
        }, 'json-structure-only-wipe');
        const applied = window.EveDataStore.Store.applyState(state);
        const live = window.EveAudioflixState.ensure();
        return {
            applied,
            noSongCopies: live.music.length === 0 && live.soundboard.length === 0,
            folders: live.musicFolders || [],
            groups: live.musicGroups || [],
            ports: live.musicPortConnections || []
        };
    }, exportedText);

    await browser.close();
    const fails = [];
    if (!parsed) fails.push('exportDataJsonOnly did not produce parseable JSON');
    if (!unifiedShapeOk) fails.push('JSON backup is not a unified backup the importer accepts');
    if (!fileOk) fails.push('JSON backup file did NOT contain the seeded Audioflix content');
    if (!structureOk) fails.push('JSON backup did NOT contain a URL-free Audioflix structural recovery map');
    if (!restore.applied) fails.push('applyState rejected the restored JSON backup');
    if (!restore.liveOk) fails.push('Audioflix content was not restored into live state from the JSON backup');
    if (!restore.fallbackOk) fails.push('restored Audioflix was not persisted to the fallback store a reload reads');
    if (!structuralOnly.applied || !structuralOnly.noSongCopies
        || !structuralOnly.folders.includes('Json Folder')
        || !structuralOnly.groups.includes('JsonMusicGroup')
        || !structuralOnly.ports.some((entry) => entry.id === 'json-music-port')) {
        fails.push('structural-only Audioflix restore did not preserve topology without song copies');
    }
    if (fails.length) { console.error('FAIL: ' + fails.join('; ')); process.exit(1); }
    console.log('AUDIOFLIX_JSON_BACKUP_ROUNDTRIP_OK');
})().catch((e) => { console.error(e); process.exit(1); });
