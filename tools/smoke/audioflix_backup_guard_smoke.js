const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const APPLY_SOURCE = path.join(ROOT, 'js', 'modules', 'features', 'data-state', 'data-state.apply.scoped.variants.js');
const BACKUP_SOURCE = path.join(ROOT, 'js', 'modules', 'modals', 'modal-settings.audioflix-backup.js');
const STATE_SOURCES = [
    'audioflix.state.recovery.js',
    'audioflix.state.schema.js',
    'audioflix.state.js'
].map((name) => path.join(ROOT, 'js', 'modules', 'features', 'audioflix', name));
const clone = (value) => JSON.parse(JSON.stringify(value));
const fails = [];
const check = (condition, message) => { if (!condition) fails.push(message); };

function runLegacyApplyGuard() {
    const calls = [];
    const noOp = () => {};
    const dataStore = {
        captureReady: true,
        applySharedReady: true,
        applyScopedHelpersReady: true,
        getLinks: () => [],
        getBookmarkFolders: () => ({}),
        cloneConnections: () => [],
        getConnectionCategoryName: () => '',
        parseLibraryKey: () => null,
        findCategoryLibraryData: () => null,
        stripLegacyPinnedFlag: (entry) => entry,
        mergeLibraryEntries: noOp,
        deriveLegacyPinsFromLinks: () => [],
        replaceQuickPinsForWorkspace: noOp,
        replaceQuickPinsForCard: noOp,
        replaceQuickPinsForBookmark: noOp,
        replaceQuickPinsForFolder: noOp,
        getFolderTreesObject: () => ({}),
        buildScopedCategoryKey: () => '',
        filterFolderTreesByWorkspace: () => ({}),
        getFolderNodes: () => [],
        normalizeFolderTreeSettings: (value) => value,
        buildFolderMaps: () => ({}),
        collectFolderSubtreeIds: () => new Set(),
        mergeFolderSubtree: noOp,
        setLinks: noOp,
        setConfig: noOp,
        setBookmarkFolders: noOp,
        setQuickPins: noOp,
        applyLibraryCategories: noOp,
        applyConnections: noOp,
        applyKnowledgeState: noOp,
        createApplyFolderState: () => () => true
    };
    const window = {
        EveDataStore: dataStore,
        EveAudioflixAudio: { stopAll: async () => true },
        EveAudioflixAudioCodec: { clearCache: noOp },
        EveAudioflixState: {
            replaceDatapackState(value, reason) { calls.push({ value, reason }); }
        }
    };
    const context = vm.createContext({ window, console, Set, Map, Object, Array, String, Promise });
    vm.runInContext(fs.readFileSync(APPLY_SOURCE, 'utf8'), context, { filename: APPLY_SOURCE });

    check(dataStore.applyState({ metadata: { type: 'legacy' } }) === true, 'legacy backup was rejected');
    check(calls.length === 0, 'backup without Audioflix wiped the current Audioflix library');

    const explicit = { music: [], soundboard: [], marker: 'explicit-empty' };
    check(dataStore.applyState({ audioflix: explicit }) === true, 'explicit Audioflix backup was rejected');
    check(calls.length === 1 && calls[0].value.marker === 'explicit-empty', 'explicit empty Audioflix state was not honored');

    const legacyNested = { music: [{ id: 'm1' }], marker: 'legacy-nested' };
    dataStore.applyState({ bookmarks: { config: { audioflix: legacyNested } } });
    check(calls.length === 2 && calls[1].value.marker === 'legacy-nested', 'legacy nested Audioflix backup lost compatibility');
}

function createBackupHarness(initialState = {}, options = {}) {
    const storage = new Map();
    const fullStateKey = 'eveAudioflixFallbackState';
    let exportedBlob = null;
    let nextTimer = 1;
    const statusNode = { textContent: '', dataset: {} };
    const localStorage = {
        getItem: (key) => storage.has(String(key)) ? storage.get(String(key)) : null,
        setItem(key, value) {
            const normalized = String(key);
            if (options.failFullState && normalized === fullStateKey) throw new Error('Quota exceeded writing full Audioflix state');
            storage.set(normalized, String(value));
        },
        removeItem: (key) => storage.delete(String(key))
    };
    class HarnessURL extends URL {
        static createObjectURL(blob) { exportedBlob = blob; return 'blob:audioflix-smoke'; }
        static revokeObjectURL() {}
    }
    const document = {
        readyState: 'complete',
        body: { appendChild() {} },
        getElementById: (id) => id === 'audioflixBackupStatus' ? statusNode : null,
        querySelector: () => ({}),
        createElement: () => ({ click() {}, remove() {} }),
        addEventListener() {}
    };
    const config = { audioflix: clone(initialState) };
    const quietConsole = { log() {}, warn() {}, error() {} };
    const window = {
        config,
        eveState: { config },
        EveAudioflixStateGroups: { create: () => ({}) },
        addEventListener() {},
        dispatchEvent() {},
        setTimeout: () => nextTimer++,
        clearTimeout() {},
        saveConfig() { return options.coreSaveResult; },
        showToast() {}
    };
    const context = vm.createContext({
        window, document, localStorage, console: quietConsole,
        Date, JSON, Math, Object, Array, String, Number, Boolean, Set, Map, Promise,
        Blob, URL: HarnessURL, CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
        fetch: async () => ({ ok: true, status: 200, json: async () => ({}) })
    });
    [...STATE_SOURCES, BACKUP_SOURCE].forEach((source) => {
        vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
    });
    return {
        window,
        statusNode,
        storage,
        fullStateKey,
        exported: async () => exportedBlob ? JSON.parse(await exportedBlob.text()) : null
    };
}

function inputFor(tab, data) {
    const payload = JSON.stringify({ format: 'eveos-audioflix-tab', version: 1, tab, data });
    return { value: 'selected', files: [{ size: Buffer.byteLength(payload), text: async () => payload }] };
}

async function runPlaylistIdentityRegression() {
    const harness = createBackupHarness();
    const sharedUrl = 'https://open.spotify.com/track/sharedTrack123';
    await harness.window.importAudioflixTabBackup(inputFor('music', {
        music: [
            { id: 'track-a', title: 'Shared Song', url: sharedUrl, sourceProvider: 'spotify', sourceId: 'sharedTrack123', playlistId: 'playlist-a', folder: 'Playlist A' },
            { id: 'track-b', title: 'Shared Song', url: sharedUrl, sourceProvider: 'spotify', sourceId: 'sharedTrack123', playlistId: 'playlist-b', folder: 'Playlist B' }
        ],
        musicGroups: ['Playlist A', 'Playlist B'],
        musicGroupMap: { 'track-a': ['Playlist A'], 'track-b': ['Playlist B'] },
        musicPlaylists: [
            { id: 'playlist-a', playlistId: 'source-a', url: 'https://open.spotify.com/playlist/sourceA', title: 'Playlist A', provider: 'spotify', group: 'Playlist A' },
            { id: 'playlist-b', playlistId: 'source-b', url: 'https://open.spotify.com/playlist/sourceB', title: 'Playlist B', provider: 'spotify', group: 'Playlist B' }
        ]
    }), 'music');

    const state = harness.window.EveAudioflixState.ensure();
    const copies = state.music.filter((item) => item.sourceId === 'sharedTrack123');
    const inA = copies.find((item) => item.playlistId === 'playlist-a');
    const inB = copies.find((item) => item.playlistId === 'playlist-b');
    check(copies.length === 2, 'same Spotify source in two playlists collapsed into one record');
    check(inA && state.musicGroupMap[inA.id]?.includes('Playlist A'), 'first playlist copy lost its group-map membership');
    check(inB && state.musicGroupMap[inB.id]?.includes('Playlist B'), 'second playlist copy lost its group-map membership');
}

async function runOrganizationRoundTripRegression() {
    const harness = createBackupHarness({
        music: [{ id: 'roundtrip-track', title: 'Round Trip', url: 'https://media.example/roundtrip', folder: 'Filed Music' }],
        musicFolders: ['Filed Music', 'Empty Music Folder'],
        musicGroups: ['Mood', 'Night'],
        musicGroupParents: { Night: 'Mood' },
        musicGroupMap: { 'roundtrip-track': ['Night'] }
    });
    harness.window.exportAudioflixTabBackup('music');
    const payload = await harness.exported();
    check(payload?.data?.musicFolders?.includes('Empty Music Folder'), 'musicFolders were omitted from the tab export');
    check(payload?.data?.musicGroupParents?.Night === 'Mood', 'musicGroupParents were omitted from the tab export');

    harness.window.EveAudioflixState.replaceDatapackState({}, 'audioflix-backup-smoke-clear');
    harness.window.EveAudioflixState.flush('audioflix-backup-smoke-clear');
    await harness.window.importAudioflixTabBackup(inputFor('music', payload?.data || {}), 'music');
    const restored = harness.window.EveAudioflixState.ensure();
    check(restored.musicFolders.includes('Empty Music Folder'), 'musicFolders did not survive export/import round-trip');
    check(restored.musicGroupParents?.Night === 'Mood', 'musicGroupParents did not survive export/import round-trip');
}

async function runPersistenceFailureRegression() {
    const harness = createBackupHarness({}, { failFullState: true });
    await harness.window.importAudioflixTabBackup(inputFor('music', {
        music: [{ id: 'quota-track', title: 'Quota Track', url: 'https://media.example/quota', folder: 'Quota Folder' }],
        musicFolders: ['Quota Folder']
    }), 'music');
    const structureKey = `${harness.fullStateKey}${harness.window.EveAudioflixStateRecovery.STRUCTURE_SUFFIX}`;
    check(harness.storage.has(structureKey) && !harness.storage.has(harness.fullStateKey), 'quota fixture did not isolate structural success from full-state failure');
    check(harness.statusNode.dataset.status === 'error', 'full-state persistence failure was reported as a successful import');
    check(/persist|save|durab|quota|fail/i.test(harness.statusNode.textContent), 'persistence failure did not surface an actionable error');
}

async function runCorePersistenceFallbackRegression() {
    const harness = createBackupHarness({}, { failFullState: true, coreSaveResult: true });
    await harness.window.importAudioflixTabBackup(inputFor('music', {
        music: [{ id: 'core-track', title: 'Core Track', url: 'https://media.example/core' }]
    }), 'music');
    check(harness.statusNode.dataset.status === 'success', 'successful core-storage fallback was reported as a failed import');
}

(async function main() {
    runLegacyApplyGuard();
    await runPlaylistIdentityRegression();
    await runOrganizationRoundTripRegression();
    await runPersistenceFailureRegression();
    await runCorePersistenceFallbackRegression();
    if (fails.length) {
        console.error(`AUDIOFLIX_BACKUP_GUARD_SMOKE_FAIL: ${fails.join('; ')}`);
        process.exitCode = 1;
        return;
    }
    console.log('AUDIOFLIX_BACKUP_GUARD_SMOKE_OK');
})().catch((error) => {
    console.error(`AUDIOFLIX_BACKUP_GUARD_SMOKE_FAIL: ${error?.message || error}`);
    process.exit(1);
});
