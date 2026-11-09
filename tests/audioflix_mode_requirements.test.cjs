'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
assert.ok(fs.existsSync(path.join(ROOT, 'js/modules/features/audioflix/audioflix.playback.policy.ui.js')),
    'AudioFlix policy source must be located in the current EveOS checkout');
const code = fs.readFileSync(path.join(ROOT, 'js/modules/features/audioflix/audioflix.playback.policy.ui.js'), 'utf8');
const window = {};
vm.runInNewContext(code, { window, console });
const ui = window.EveAudioflixPlaybackPolicyUi;
const payload = {
    ok: true, playbackAvailable: true,
    spotifyModePrerequisites: { platform: 'win32', edgeBetaInstalled: true, windowsRoutingAdapterInstalled: true },
    devices: [{ id: 'sd:12', kind: 'output', playable: true, label: 'Headphones (WASAPI)' },
        { id: 'sd:13', kind: 'output', playable: false, label: 'Discovery only' }]
};
const selection = { playbackPolicy: { spotifyMethod: 'embed', outputMode: 'global' },
    nativeBridgeEnabled: true, nativeOutputId: 'sd:12' };

test('inline requirements button is inside existing Playback policies panel', () => {
    window.EveAudioflixState = { ensure: () => selection };
    const markup = ui.renderNexus('music');
    assert.match(markup, /data-af-action="check-playback-mode-requirements"/);
    assert.match(markup, /data-af-mode-requirements-report/);
    assert.match(markup, /Playback policies/);
});
test('installed Edge Beta, adapter and selected playable endpoint are reported as prerequisites', () => {
    const r = ui.evaluateModePrerequisites(selection, payload);
    assert.equal(r.method, 'Official Spotify Embed');
    assert.equal(r.rows.find(row => row[0] === 'Official Embed prerequisites')[2], 'ready');
    assert.equal(r.selectedLabel, 'Headphones (WASAPI)');
    assert.equal(r.playableCount, 1);
});
test('missing Edge Beta does not pass managed or official checks', () => {
    const r = ui.evaluateModePrerequisites(selection, { ...payload,
        spotifyModePrerequisites: { ...payload.spotifyModePrerequisites, edgeBetaInstalled: false } });
    assert.equal(r.rows.find(row => row[0] === 'Managed Engine prerequisites')[2], 'attention');
    assert.equal(r.rows.find(row => row[0] === 'Official Embed prerequisites')[2], 'attention');
});
test('unavailable or stale native output cannot count as ready', () => {
    const r = ui.evaluateModePrerequisites({ ...selection, nativeOutputId: 'sd:7' }, payload);
    assert.equal(r.rows.find(row => row[0] === 'Selected native output')[2], 'attention');
    assert.equal(r.rows.find(row => row[0] === 'Official Embed prerequisites')[2], 'attention');
});
test('unknown browser capability never claims ready', () => {
    const r = ui.evaluateModePrerequisites(selection, { ok: true, devices: payload.devices });
    assert.equal(r.rows.find(row => row[0] === 'Edge Beta')[2], 'unknown');
    assert.equal(r.rows.find(row => row[0] === 'Official Embed prerequisites')[2], 'unknown');
});
test('click is read-only and requests no forced PortAudio reinitialization', async () => {
    let selectionMutations = 0, forceFlag = null;
    const report = { hidden: true, textContent: '', innerHTML: '' };
    const panel = { querySelector(selector) { assert.equal(selector, '[data-af-mode-requirements-report]'); return report; } };
    const button = { disabled: false, closest(selector) { assert.equal(selector, '.audioflix-policy-panel'); return panel; }, dataset: {} };
    window.EveAudioflixNative = {
        async listSystemOutputs(force) { forceFlag = force; return payload; },
        selectNativeOutput() { selectionMutations++; },
        setNativeBridgeEnabled() { selectionMutations++; }
    };
    assert.equal(ui.handleAction(button, 'check-playback-mode-requirements', {}), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(forceFlag, false);
    assert.equal(selectionMutations, 0);
    assert.equal(button.disabled, false);
    assert.equal(report.hidden, false);
    assert.match(report.innerHTML, /Official Embed prerequisites/);
    assert.match(report.innerHTML, /Headphones/);
});
test('failure reports uncertainty without mutating playback policy', async () => {
    const report = { hidden: true, textContent: '', innerHTML: '' };
    const button = { disabled: false, dataset: {}, closest() { return { querySelector() { return report; } }; } };
    window.EveAudioflixNative = { async listSystemOutputs() { throw new Error('server offline'); } };
    assert.equal(ui.handleAction(button, 'check-playback-mode-requirements', {}), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.match(report.textContent, /server offline/);
    assert.equal(button.disabled, false);
    assert.equal(selection.nativeOutputId, 'sd:12');
});
test('unrelated controls are not swallowed by requirements action', () => {
    assert.equal(ui.handleAction({ dataset: {} }, 'select-output', {}), false);
});
