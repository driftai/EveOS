// Regression: saved Soundboard/song hotkeys must survive reloads, empty catalogs,
// structural recovery, explicit clearing and cross-tab native-arming transitions.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, 'js/modules/features/audioflix', file), 'utf8');
const slots = new Map();
const localStorage = {
    getItem: key => slots.has(key) ? slots.get(key) : null,
    setItem: (key, value) => { slots.set(key, String(value)); },
    removeItem: key => slots.delete(key)
};
const makeItems = () => Array.from({ length: 100 }, (_, i) => ({
    id: 'sound_' + i, type: 'sound', title: 'Sound ' + i,
    url: 'https://example.invalid/sound/' + i + '.wav', hotkey: combo(i), volume: 1
}));
function combo(i) {
    const keys = 'abcdefghijklmnopqrstuvwxyz0123456789';
    return ['ctrl+shift+', 'ctrl+alt+', 'alt+shift+'][Math.floor(i / keys.length)]
        + keys[i % keys.length];
}
function bootstrap(raw) {
    const win = {
        eveState: { config: { audioflix: raw } },
        addEventListener() {},
        EveAudioflixStateMutations: { create: () => ({
            durableProjection: v => v, durableSnapshot: v => JSON.parse(JSON.stringify(v)),
            persistTracked: work => work(), cancelPendingVolumes() {},
            finalizePendingVolumes() {}
        }) },
        EveAudioflixPersistenceScheduler: { create: () => ({
            flush: () => Promise.resolve(), schedule: () => Promise.resolve(),
            hasPending: () => false, hasUnmirrored: () => false
        }) },
        EveAudioflixStateGroups: { create: () => ({}) },
        EveAudioflixLibraryIndex: {
            invalidate() {},
            get: (state, type) => ({
                getById: id => (state[type === 'music' ? 'music' : 'soundboard'] || [])
                    .find(item => item.id === id)
            })
        }
    };
    const context = vm.createContext({ window: win, localStorage, console, Date, Math,
        setTimeout, clearTimeout, setInterval, clearInterval });
    for (const file of ['audioflix.state.schema.js', 'audioflix.state.recovery.js', 'audioflix.state.js'])
        vm.runInContext(read(file), context, { filename: file });
    return { win, context };
}
async function main() {
    const key = 'eveAudioflixFallbackState', originals = makeItems();
    const data = { soundboard: originals, music: [], portHotkeys: {},
        lastAudioflixTab: 'music', durabilityRevision: 1, durabilityUpdatedAt: 1 };
    const first = bootstrap(data), store = first.win.EveAudioflixState;
    assert.equal(store.ensure().soundboard.length, 100);
    assert.equal(Object.keys(store.ensure().portHotkeys).length, 100);
    first.win.EveAudioflixStateRecovery.write(key, store.getSnapshot());
    const reload = bootstrap({ ...data, soundboard: originals.map(item => ({ ...item, hotkey: '' })),
        portHotkeys: {}, durabilityRevision: 9, durabilityUpdatedAt: 2 });
    let restored = reload.win.EveAudioflixState.ensure();
    assert.equal(restored.lastAudioflixTab, 'music');
    assert.equal(restored.soundboard.filter(item => item.hotkey).length, 100,
        '100 assignments must survive higher-revision partial core config');
    assert.equal(Object.keys(restored.portHotkeys).length, 100);
    const guard = reload.win.EveAudioflixStateRecovery;
    const partial = guard.restoreStructure(key, { soundboard: [], music: [], portHotkeys: {} });
    assert.equal(Object.keys(partial.portHotkeys).length, 100,
        'empty transient catalogs may not erase durable mappings');
    const refused = guard.write(key, { soundboard: [], music: [], portHotkeys: {} });
    assert.equal(refused.written, false, 'empty state must not overwrite the stored library');
    store.setItemHotkey('sound', 'sound_0', '', { explicitClear: true });
    const afterClear = bootstrap({ ...data, portHotkeys: {}, soundboard: originals,
        durabilityRevision: 1, durabilityUpdatedAt: 1 }).win.EveAudioflixState.ensure();
    assert.equal(afterClear.soundboard[0].hotkey, '', 'explicit per-item clear must stay cleared');
    assert.equal(afterClear.soundboard.filter(item => item.hotkey).length, 99);
    const withoutConfig = bootstrap({});
    delete withoutConfig.win.eveState;
    assert.equal(withoutConfig.win.EveAudioflixState.ensure().portHotkeys.sound_0, null);
    assert.equal(withoutConfig.win.EveAudioflixState.ensure().soundboard.filter(item => item.hotkey).length, 99);
    const restoredTab = bootstrap({ ...data, lastAudioflixTab: 'soundboard',
        durabilityRevision: 1, durabilityUpdatedAt: 1 }).win.EveAudioflixState.ensure();
    assert.equal(restoredTab.lastAudioflixTab, 'music', 'journal preserves last tab on early reload');
    const ignored = store.setItemHotkey('sound', 'sound_1', '');
    assert.equal(ignored.soundboard[1].hotkey, combo(1), 'generic blank writes must not erase');

    const sent = [], sounds = makeItems();
    let tab = 'soundboard';
    const hotWin = {
        EveAudioflixAudio: { getDecodedBuffer: async () => ({ sampleRate: 48000 }),
            encodeBufferToBase64: () => 'AA==' },
        EveAudioflixNative: {
            async setHotkeys(payload) {
                sent.push(payload);
                return { ok: true, registered: payload.bindings.map(item => item.combo),
                    configured: payload.bindings.length, bypassRegistered: true };
            },
            async clearHotkeys() { throw Error('bypass must not be cleared'); }
        }
    };
    const hotContext = vm.createContext({ window: hotWin, console, Date, setInterval, clearInterval, setTimeout });
    vm.runInContext(read('audioflix.ui.hotkeys.js'), hotContext);
    const ctx = {
        get activeTab() { return tab; },
        hotkeySoundItems: () => sounds, hotkeyCatalogReady: () => true,
        state: () => ({ nativeOutputId: 'default', hotkeyBypassCombo: 'shift+z' }),
        overlay: { hidden: false, querySelector: () => null },
        nativeHotkeysLive: false, activeInfoItem: null
    };
    const controller = hotWin.EveAudioflixUiHotkeys.create(ctx);
    await controller.syncHotkeys();
    assert.equal(sent.at(-1).bindings.length, 100);
    for (const other of ['music', 'piano', 'soundlab', 'router']) {
        tab = other;
        await controller.syncHotkeys();
        assert.equal(sent.at(-1).bindings.length, 0, other + ' must unarm sounds');
        assert.equal(sent.at(-1).bypassCombo, 'shift+z', 'bypass survives tab switch');
    }
    tab = 'soundboard';
    await controller.syncHotkeys();
    assert.equal(sent.at(-1).bindings.length, 100, 'Soundboard must re-arm saved group');
    assert.equal(sounds.length, 100, 'arming never mutates saved assignments');
    console.log('AUDIOFLIX_HOTKEY_DURABILITY_OK bindings=100 reload=true clear=explicit tabs=5 bypass=preserved');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
