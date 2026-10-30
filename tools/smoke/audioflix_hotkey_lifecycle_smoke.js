const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'js/modules/features/audioflix/audioflix.ui.hotkeys.js'), 'utf8');
const calls = { set: [], clear: 0, bypass: [], play: [] };
const state = { nativeOutputId: '', hotkeyBypassCombo: 'ctrl+shift+b' };
const items = [
    { id: 'one', title: 'One', url: 'one.wav', hotkey: 'u', volume: 1 },
    { id: 'two', title: 'Two', url: 'two.wav', hotkey: 'ctrl+y', volume: 0.5 }
];
const statusElement = { textContent: '', dataset: {} };
const bypassButton = { textContent: '', dataset: {}, setAttribute(name, value) { this[name] = value; } };
const window = {
    EveAudioflixUiHotkeys: {},
    EveAudioflixNative: {
        setHotkeys: async payload => { calls.set.push(payload); return { ok: true, configured: 2, registered: ['u'], conflicted: ['ctrl+y'], bypassRegistered: true }; },
        clearHotkeys: async () => { calls.clear++; return { ok: true }; },
        hotkeyStatus: async () => ({ ok: true, configured: 2, bindings: [{ combo: 'u', registered: true }, { combo: 'ctrl+y', registered: false }], bypassRegistered: true }),
        setHotkeyBypassed: async bypassed => { calls.bypass.push(bypassed); return { ok: true, configured: 2, registered: ['u'], bypassed, bypassRegistered: true }; }
    },
    EveAudioflixAudio: {
        getDecodedBuffer: async url => ({ sampleRate: 48000, url }),
        encodeBufferToBase64: buffer => `pcm:${buffer.url}`,
        playItem: async item => calls.play.push(item.id)
    },
    SearchMonitorBoot: null
};
const context = { window, console, setTimeout, clearTimeout, setInterval, clearInterval };
vm.runInNewContext(source, context, { filename: 'audioflix.ui.hotkeys.js' });

let live = false;
let catalogReady = true;
const ctx = {
    state: () => state,
    hotkeySoundItems: () => items,
    hotkeyCatalogReady: () => catalogReady,
    get nativeHotkeysLive() { return live; },
    set nativeHotkeysLive(value) { live = value; },
    overlay: { hidden: false, querySelector: selector => selector === '.audioflix-bypass-state' ? statusElement
        : selector === '[data-af-action="toggle-hotkey-bypass"]' ? bypassButton : null, querySelectorAll: () => [] },
    activeInfoItem: null,
    activeTab: 'soundboard',
    settingsOpen: false
};
const controller = window.EveAudioflixUiHotkeys.create(ctx);

(async () => {
    await controller.syncHotkeys();
    assert.strictEqual(calls.set.length, 1);
    assert.deepStrictEqual(Array.from(calls.set[0].bindings, binding => binding.combo), ['u', 'ctrl+y']);
    assert.strictEqual(calls.set[0].deviceId, 'default');
    assert.strictEqual(live, true, 'partial native registration must remain live');

    await controller.syncHotkeys();
    assert.strictEqual(calls.set.length, 1, 'unchanged catalog must not be decoded/reposted');

    catalogReady = false;
    await controller.syncHotkeys({ force: true });
    assert.strictEqual(calls.set.length, 1, 'an incomplete port catalog must preserve native registrations');
    assert.strictEqual(calls.clear, 0, 'an incomplete port catalog must never clear native registrations');
    catalogReady = true;

    // While the last selected tab is not Soundboard, unarm even when the
    // scanned sound catalog is temporarily unavailable; bypass stays live.
    ctx.activeTab = 'music';
    catalogReady = false;
    await controller.syncHotkeys();
    assert.deepStrictEqual(Array.from(calls.set.at(-1).bindings, binding => binding.combo), [],
        'leaving Soundboard must unregister its sounds even before catalog hydration');
    assert.strictEqual(calls.set.at(-1).bypassCombo, state.hotkeyBypassCombo,
        'the bypass remains registered across tabs');
    assert.strictEqual(calls.clear, 0, 'tab standby must never clear the bypass');
    controller.handleHotkey({ key: 'y', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false,
        target: { tagName: 'DIV' }, preventDefault() {} });
    assert.deepStrictEqual(calls.play, [], 'standby must suppress the focused sound fallback');
    catalogReady = true;
    ctx.activeTab = 'soundboard';
    await controller.syncHotkeys();
    assert.deepStrictEqual(Array.from(calls.set.at(-1).bindings, binding => binding.combo),
        ['u', 'ctrl+y'], 'returning to Soundboard re-arms the visible group');

    controller.handleHotkey({ key: 'u', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
        target: { tagName: 'DIV' }, preventDefault() {} });
    controller.handleHotkey({ key: 'y', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false,
        target: { tagName: 'DIV' }, preventDefault() {} });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepStrictEqual(calls.play, ['two'], 'only the native-conflicted combo should use focused fallback');

    await controller.setBypassed(true);
    assert.deepStrictEqual(calls.bypass, [true], 'manual bypass must use the authoritative native owner');
    assert(statusElement.textContent.includes('SYSTEM-WIDE BYPASSED'), 'manual native bypass must update status');
    assert.strictEqual(bypassButton.textContent, 'Deactivate bypass');

    window.EveAudioflixNative.setHotkeys = async () => ({ ok: false, message: 'localhost unavailable' });
    await controller.syncHotkeys({ force: true });
    assert(statusElement.textContent.includes('PAGE ONLY'), 'offline bridge must describe focused-page fallback');
    assert(statusElement.textContent.includes('system-wide unavailable'), 'offline bridge must distinguish system-wide reach');
    assert(!statusElement.textContent.includes('NOT CONFIGURED'), 'configured fallback must never be reported as not configured');

    window.EveAudioflixNative.setHotkeyBypassed = async () => { throw new Error('offline'); };
    await controller.setBypassed(true);
    assert(statusElement.textContent.includes('PAGE BYPASSED'), 'manual button must retain a page-local fallback');
    await controller.setBypassed(false);
    assert(statusElement.textContent.includes('PAGE ONLY'), 'manual button must re-arm the page-local fallback');

    state.hotkeyBypassCombo = 'j';
    ctx.activeTab = 'music';
    controller.handleHotkey({ key: 'j', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
        target: { tagName: 'DIV' }, preventDefault() {} });
    assert(statusElement.textContent.includes('PAGE BYPASSED'),
        'focused-page bypass must work in Music');
    controller.handleHotkey({ key: 'j', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
        target: { tagName: 'DIV' }, preventDefault() {} });
    ctx.activeTab = 'soundboard';
    controller.handleHotkey({ key: 'j', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
        target: { tagName: 'DIV' }, preventDefault() {} });
    assert(statusElement.textContent.includes('PAGE BYPASSED'), 'page-local bypass state must be visible');
    controller.handleHotkey({ key: 'u', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
        target: { tagName: 'DIV' }, preventDefault() {} });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepStrictEqual(calls.play, ['two'], 'page-local bypass must suppress focused fallback');
    controller.handleHotkey({ key: 'j', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
        target: { tagName: 'DIV' }, preventDefault() {} });
    controller.handleHotkey({ key: 'u', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
        target: { tagName: 'DIV' }, preventDefault() {} });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepStrictEqual(calls.play, ['two', 'one'], 're-armed page-local fallback must play the configured sound');

    const uiSource = fs.readFileSync(path.join(root, 'js/modules/features/audioflix/audioflix.ui.js'), 'utf8');
    assert(!/beforeunload[\s\S]{0,120}clearHotkeys/.test(uiSource),
        'page unload must not clear durable global registrations');
    const queueDetails = uiSource.match(/const openQueueDetails\s*=\s*\(\)\s*=>\s*\{([\s\S]*?)\};/)?.[1] || '';
    assert(queueDetails.includes("activeTab = 'music'") && queueDetails.includes("lastAudioflixTab: activeTab")
        && queueDetails.includes('pushHotkeysToBridge()'),
        'opening Music queue details must persist Music tab and disarm Soundboard');
    assert(fs.readFileSync(path.join(root, 'js/modules/features/audioflix/audioflix.ui.panel.js'), 'utf8').includes('data-af-action="toggle-hotkey-bypass"'),
        'settings panel must expose the manual bypass button');
    console.log('AUDIOFLIX_HOTKEY_LIFECYCLE_OK visibleGroup=true coalesced=true conflictFallback=true durable=true');
})().catch(error => { console.error(error); process.exitCode = 1; });
