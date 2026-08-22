const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const SOURCE = path.join(ROOT, 'js', 'modules', 'modals', 'modal-settings.audioflix-backup.js');
const FILTER_SOURCE = path.join(ROOT, 'js', 'modules', 'features', 'audioflix', 'audioflix.ui.render.js');
const assert = (condition, message) => { if (!condition) throw new Error(`ASSERT FAILED: ${message}`); };

const state = {
    soundboard: [{ id: 'sound-live', title: 'Airhorn', url: 'https://media.example/airhorn', classifiers: ['Live'] }],
    music: [{ id: 'music-live', title: 'Night Drive', url: 'https://media.example/night', classifiers: ['Current'] }],
    soundboardGroups: ['Current Sounds'], soundGroupMap: { 'sound-live': ['Current Sounds'] },
    musicGroups: ['Current Music'], musicGroupMap: { 'music-live': ['Current Music'] },
    musicPlaylists: [{ id: 'playlist-live', url: 'https://playlist.example/night', title: 'Night' }],
    scopeBindings: []
};
const statusNode = { textContent: '', dataset: {} };
let flushes = 0;
let pianoRequest = null;
const window = {
    EveAudioflixState: {
        getSnapshot: () => JSON.parse(JSON.stringify(state)),
        ensure: () => state,
        replaceState(patch) {
            Object.keys(state).forEach((key) => delete state[key]);
            Object.assign(state, JSON.parse(JSON.stringify(patch)));
            return state;
        },
        flush: () => { flushes += 1; }
    },
    EveAudioflixPiano: { serviceUrl: () => 'http://127.0.0.1:8771/' },
    setTimeout,
    showToast() {}
};
class MutationObserverStub { observe() {} }
const documentStub = {
    body: {},
    getElementById: (id) => id === 'audioflixBackupStatus' ? statusNode : null,
    querySelector: () => ({}),
    addEventListener() {}
};
const fetchMock = async (url, options = {}) => {
    pianoRequest = { url: String(url), options };
    return { ok: true, status: 200, json: async () => ({ imported: 2, updated: 1 }) };
};
const context = vm.createContext({
    window, console, Date, JSON, Math, Object, Array, String, Number, Boolean, Set, Map, URL,
    Blob, setTimeout, clearTimeout, MutationObserver: MutationObserverStub, document: documentStub, fetch: fetchMock
});
vm.runInContext(fs.readFileSync(SOURCE, 'utf8'), context, { filename: SOURCE });

function inputFor(tab, data) {
    const payload = JSON.stringify({ format: 'eveos-audioflix-tab', version: 1, tab, data });
    return { value: 'selected', files: [{ size: Buffer.byteLength(payload), text: async () => payload }] };
}

function runFrontendFilterSmoke() {
    const filterState = {
        soundboard: [], soundboardGroups: [], soundGroupMap: {}, soundboardViewMode: 'frontend', activeFrontendGroup: '',
        music: [
            { id: 'both', title: 'Both groups', artist: 'A', exposed: true },
            { id: 'only-one', title: 'Only group one', artist: 'B', exposed: true }
        ],
        musicGroups: ['Group 1', 'Group 2'],
        musicGroupMap: { both: ['Group 1', 'Group 2'], 'only-one': ['Group 1'] },
        musicViewMode: 'frontend', activeFrontendMusicGroup: '', activeFrontendMusicArtist: '', activeFrontendMusicClassifier: '', activeMusicFolderScope: ''
    };
    let capturedClick = null;
    const storage = new Map();
    const filterWindow = {
        EveAudioflixState: {
            ensure: () => filterState,
            update(patch) { Object.assign(filterState, patch || {}); return filterState; }
        },
        EveAudioflixNexus: { getArtist: (item) => item.artist || '' },
        EveAudioflixClassifiersUi: { create: () => ({ renderFrontendRow: () => '' }) }
    };
    const filterDocument = {
        head: { appendChild() {} },
        createElement: () => ({ id: '', textContent: '' }),
        addEventListener(type, handler, capture) { if (type === 'click' && capture) capturedClick = handler; }
    };
    const localStorage = {
        getItem: (key) => storage.has(key) ? storage.get(key) : null,
        setItem: (key, value) => storage.set(key, String(value))
    };
    const filterContext = vm.createContext({
        window: filterWindow, document: filterDocument, localStorage,
        console, Date, JSON, Math, Object, Array, String, Number, Boolean, Set, Map
    });
    vm.runInContext(fs.readFileSync(FILTER_SOURCE, 'utf8'), filterContext, { filename: FILTER_SOURCE });
    assert(typeof capturedClick === 'function', 'tri-state filter layer installs its capturing click hook');

    const click = (group) => capturedClick({ target: { closest: () => ({ dataset: { afAction: 'select-frontend-group', afType: 'music', afDimension: 'group', afGroup: group } }) } });
    const updateGroup = (group) => filterWindow.EveAudioflixState.update({ activeFrontendMusicGroup: group, musicViewMode: 'frontend' }, 'audioflix-active-music-group');

    click('Group 2'); updateGroup('Group 2');
    assert(filterState.activeFrontendMusicGroup === 'Group 2', 'first click includes a group');
    click('Group 2'); updateGroup('');
    let saved = JSON.parse(storage.get('eveAudioflixFrontendExclusionsV1') || '{}');
    assert(filterState.activeFrontendMusicGroup === '' && saved.musicGroups.includes('Group 2'), 'second click excludes the group and persists the red scope');

    click('Group 1'); updateGroup('Group 1');
    const ctx = {
        state: () => filterState,
        esc: (value) => String(value ?? ''),
        itemMeta: () => '', groupKey: () => 'Ungrouped', groupTags: () => '', internalViewButton: () => '',
        isItemExposed: (item) => item.exposed === true,
        allGroups: (type) => type === 'music' ? filterState.musicGroups : filterState.soundboardGroups,
        groupsOf: (id, type) => (type === 'music' ? filterState.musicGroupMap : filterState.soundGroupMap)?.[id] || [],
        stopSvg: '', playSvg: '', layerPlaySvg: '', cogSvg: '', closeSvg: '',
        getPorted: () => [], getActiveRepeaters: () => ({}), getActiveMusicQueue: () => ({}),
        renderClassifierRow: () => '', classifierEntries: () => [], getCollapsedGroups: () => ({}), smartArtistExpanded: false
    };
    const render = filterWindow.EveAudioflixUiRender.create(ctx);
    const visible = render.frontendActiveGroup('music').items.map((item) => item.id);
    assert(visible.length === 1 && visible[0] === 'only-one', 'excluded Group 2 wins overlap while included Group 1 remains focused');

    click('Group 2'); updateGroup('Group 2');
    saved = JSON.parse(storage.get('eveAudioflixFrontendExclusionsV1') || '{}');
    assert(!saved.musicGroups.includes('Group 2') && filterState.activeFrontendMusicGroup === 'Group 1', 'third click neutralizes only that exclusion and preserves another included group');
}

(async function main() {
    const soundInput = inputFor('soundboard', {
        soundboard: [
            { id: 'sound-old', title: 'Airhorn restored', url: 'https://media.example/airhorn', classifiers: ['Imported'] },
            { id: 'sound-new', title: 'Bell', url: 'C:/sounds/bell.wav' }
        ],
        soundboardGroups: ['Imported Sounds'],
        soundGroupMap: { 'sound-old': ['Imported Sounds'], 'sound-new': ['Imported Sounds'] },
        portVolumes: { 'sound-old': 0.4 },
        portHotkeys: { 'sound-old': 'ctrl+1' },
        scopeBindings: [{ audioType: 'sound', audioId: 'sound-old', scopeType: 'workspace', workspaceId: 'main' }]
    });
    await window.importAudioflixTabBackup(soundInput, 'soundboard');
    assert(state.soundboard.length === 2, 'sound import merges rather than replacing existing clips');
    assert(state.music.length === 1 && state.music[0].id === 'music-live', 'sound import cannot replace the music library');
    assert(state.soundboard.find((item) => item.id === 'sound-live').classifiers.includes('Imported'), 'same-URL sound merges into its retained ID');
    assert(state.soundGroupMap['sound-live'].includes('Imported Sounds'), 'sound group membership remaps to the retained ID');
    assert(state.portVolumes['sound-live'] === 0.4 && state.portHotkeys['sound-live'] === 'ctrl+1', 'per-sound settings remap to the retained ID');
    assert(state.scopeBindings.some((entry) => entry.audioId === 'sound-live'), 'Nexus scope binding remaps to the retained sound');
    assert(soundInput.value === '', 'sound file picker resets after import');

    const musicInput = inputFor('music', {
        music: [{
            id: 'music-old', title: 'Night Drive restored', url: 'https://media.example/night',
            playlistId: 'playlist-old', classifiers: ['Imported'], duration: 180
        }],
        musicGroups: ['Imported Music'],
        musicGroupMap: { 'music-old': ['Imported Music'] },
        musicPlaylists: [{ id: 'playlist-old', url: 'https://playlist.example/night', title: 'Imported Night' }],
        dupDismissedPairs: ['music-old|other'],
        scopeBindings: [{ audioType: 'music', audioId: 'music-old', scopeType: 'card', workspaceId: 'main', categoryName: 'Audio' }]
    });
    await window.importAudioflixTabBackup(musicInput, 'music');
    assert(state.soundboard.length === 2, 'music import cannot replace the soundboard');
    assert(state.music.length === 1 && state.music[0].id === 'music-live', 'same-URL music merges into its retained ID');
    assert(state.music[0].playlistId === 'playlist-live', 'playlist references remap to the retained playlist');
    assert(state.musicGroupMap['music-live'].includes('Imported Music'), 'music group membership remaps to the retained ID');
    assert(state.dupDismissedPairs.includes('music-live|other'), 'duplicate dismissals remap to the retained ID');
    assert(state.scopeBindings.some((entry) => entry.audioType === 'music' && entry.audioId === 'music-live'), 'Nexus scope binding remaps to the retained track');
    assert(flushes === 2, 'both imports force an immediate durable save');
    assert(statusNode.dataset.status === 'success', 'settings panel reports a successful merge');

    const pianoFile = { size: 2048, name: 'piano-library.zip' };
    const pianoInput = { value: 'selected', files: [pianoFile] };
    await window.importPianoLibraryBackup(pianoInput);
    assert(pianoRequest?.url === 'http://127.0.0.1:8771/api/library/import?filename=piano-library.zip', 'Piano backup uses the configured Piano library import endpoint');
    assert(pianoRequest?.options?.method === 'POST' && pianoRequest.options.body === pianoFile, 'Piano ZIP is streamed directly to the merge endpoint');
    assert(pianoInput.value === '', 'Piano file picker resets after import');
    assert(statusNode.dataset.status === 'success' && /2 songs processed/.test(statusNode.textContent), 'Piano merge reports imported song count');
    assert(typeof window.exportPianoLibraryBackup === 'function', 'Piano library export is exposed to Settings');

    runFrontendFilterSmoke();
    console.log('AUDIOFLIX_SETTINGS_BACKUP_SMOKE_OK');
})().catch((error) => { console.error(error); process.exit(1); });
