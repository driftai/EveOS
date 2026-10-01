const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const scripts = [
    'audioflix.paths.js',
    'audioflix.state.schema.js',
    'audioflix.state.groups.js',
    'audioflix.state.recovery.js',
    'audioflix.state.js',
    'audioflix.nexus.js',
    'audioflix.classifiers.js',
    'audioflix.localize.audit.js',
    'audioflix.localize.port.js',
    'audioflix.localize.js'
];

function loadContext() {
    const values = {};
    const localStorage = {
        getItem: (key) => values[key] ?? null,
        setItem: (key, value) => { values[key] = String(value); },
        removeItem: (key) => { delete values[key]; }
    };
    const context = {
        console, Date, JSON, Math, Object, Array, String, Number, Boolean, Set, Map,
        Promise, RegExp, queueMicrotask, setTimeout, clearTimeout, localStorage,
        config: {}, CustomEvent: function (type, init) { this.type = type; this.detail = init?.detail; },
        window: { dispatchEvent() {}, addEventListener() {} }
    };
    context.window.window = context.window;
    context.window.localStorage = localStorage;
    context.window.CustomEvent = context.CustomEvent;
    context.window.setTimeout = setTimeout;
    context.window.clearTimeout = clearTimeout;
    context.window.EveAudioflixFsPorts = {
        supported: () => true,
        scanMusicFolder: async () => ({
            ok: true,
            dir: 'fsport://music-grant/',
            browserFolderId: 'music-grant',
            rootName: 'Picked Music',
            files: [
                { name: 'Nested Offline.mp3', path: 'fsport://music-grant/Album/Nested%20Offline.mp3', subfolders: ['Album'] },
                { name: 'Root Offline.mp3', path: 'fsport://music-grant/Root%20Offline.mp3', subfolders: [] }
            ]
        })
    };
    for (const name of scripts) {
        const file = path.join(root, 'js/modules/features/audioflix', name);
        vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    }
    return context.window;
}

(async () => {
    const window = loadContext();
    const result = await window.EveAudioflixLocalize.importMusicPort('', '');
    assert.equal(result.ok, true);
    assert.equal(result.added, 2);
    assert.equal(result.folder, 'Picked Music');
    const stored = window.EveAudioflixState.ensure();
    const nested = stored.music.find((item) => item.title === 'Nested Offline');
    assert.match(nested.localPath, /^fsport:\/\/music-grant\//);
    assert.ok((stored.musicGroupMap[nested.id] || []).includes('Album'));
    assert.equal(nested.musicPortGroup, 'Album', 'automatic nested-folder group survives state normalization');
    const connection = stored.musicPortConnections.find((entry) => entry.folder === 'Picked Music');
    assert.equal(connection?.browserFolderId, 'music-grant');
    assert.equal(connection?.browserRootName, 'Picked Music', 'browser Music Port reconnect metadata survives normalization');

    // Preserve extra user organization in the structural journal, lose the song list, then rescan
    // the same Music Port. The re-created track gets its old labels/group by stable local-path identity.
    window.EveAudioflixState.addMusicGroup('Recovered Custom');
    window.EveAudioflixState.toggleMusicGroup(nested.id, 'Recovered Custom', true);
    window.EveAudioflixState.updateItem('music', nested.id, {
        classifiers: [...new Set([...(nested.classifiers || []), 'Manual Recovery'])]
    });
    window.EveAudioflixState.flush('music-port-recovery-seed');
    const structure = window.EveAudioflixStateRecovery.captureStructure(window.EveAudioflixState.ensure());

    window.EveAudioflixState.replaceDatapackState({
        soundboard: [], music: [], ports: [], browserFolders: [],
        soundboardGroups: [], soundGroupMap: {},
        musicFolders: [], musicGroups: [], musicGroupMap: {},
        musicPlaylists: [], musicPortConnections: [], musicClassifiers: [],
        localizeScopeDirs: {}, scopeBindings: []
    }, 'simulated-loss');
    window.localStorage.setItem(
        'eveAudioflixFallbackState' + window.EveAudioflixStateRecovery.STRUCTURE_SUFFIX,
        JSON.stringify(structure)
    );
    window.EveAudioflixStateRecovery.applyStructureSnapshot(window.EveAudioflixState.ensure(), structure);

    const rebuiltResult = await window.EveAudioflixLocalize.importMusicPort('', 'Picked Music');
    assert.equal(rebuiltResult.ok, true);
    const rebuilt = window.EveAudioflixState.ensure();
    const rebuiltNested = rebuilt.music.find((item) => item.title === 'Nested Offline');
    assert.ok(rebuiltNested, 'Music Port rescan reconstructs the missing track from the source folder');
    assert.ok(rebuiltNested.classifiers.includes('Manual Recovery'),
        'reimported Music Port track reclaims its preserved manual label');
    assert.ok((rebuilt.musicGroupMap[rebuiltNested.id] || []).includes('Recovered Custom'),
        'reimported Music Port track reclaims preserved custom group membership under its new id');
    assert.ok(rebuilt.musicPortConnections.some((entry) => entry.folder === 'Picked Music'),
        'Music Port source provenance survives structural-only recovery');

    console.log('AUDIOFLIX_BROWSER_MUSIC_PORT_OK');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
