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
    const connection = stored.musicPortConnections.find((entry) => entry.folder === 'Picked Music');
    assert.equal(connection?.browserFolderId, 'music-grant');
    console.log('AUDIOFLIX_BROWSER_MUSIC_PORT_OK');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
