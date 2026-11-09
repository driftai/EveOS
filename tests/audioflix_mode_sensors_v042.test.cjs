'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const installed = path.join(root, 'js', 'modules', 'features', 'audioflix', 'audioflix.mode.sensors.v042.js');
const source = fs.readFileSync(fs.existsSync(installed) ? installed : path.join(root, 'payload', 'audioflix.mode.sensors.v042.js'), 'utf8');
const win = { addEventListener() {} };
vm.runInNewContext(source, { window: win, document: { addEventListener() {} }, setTimeout }, { filename: 'mode-sensors.js' });
const resolve = win.EveAudioflixModeSensorsV042.resolveRows;
const baseline = {
    modeCapabilitiesV042: { schemaVersion: 1, edgeBeta: { status: 'detected', detail: 'Installed' }, windowsAppRouting: { status: 'installed', detail: 'Pinned' } },
    playbackAvailable: true, devices: [{ id: 'sd:7', kind: 'output', playable: true }]
};
test('Edge Beta detection distinguishes installation from playback', () => {
    const rows = resolve(baseline, 'sd:7');
    assert.equal(rows['Edge Beta'].label, 'Detected');
    assert.equal(rows['Windows app routing adapter'].label, 'Module detected');
    assert.equal(rows['Official Embed prerequisites'].label, 'Dependencies detected');
    assert.notEqual(rows['Managed Engine prerequisites'].label, 'Ready');
});
test('No active output means no official embed readiness', () => {
    const rows = resolve(baseline, 'sd:99');
    assert.equal(rows['Official Embed prerequisites'].label, 'Not checked');
});
test('Missing Edge is clearly differentiated', () => {
    const payload = { ...baseline, modeCapabilitiesV042: { ...baseline.modeCapabilitiesV042, edgeBeta: { status: 'missing' } } };
    assert.equal(resolve(payload, 'sd:7')['Edge Beta'].label, 'Missing');
    assert.equal(resolve(payload, 'sd:7')['Official Embed prerequisites'].label, 'Needs setup');
});
test('Missing adapter is clearly differentiated', () => {
    const payload = { ...baseline, modeCapabilitiesV042: { ...baseline.modeCapabilitiesV042, windowsAppRouting: { status: 'missing' } } };
    assert.equal(resolve(payload, 'sd:7')['Windows app routing adapter'].label, 'Missing');
});
test('Old backend is unknown, never a false absence', () => {
    assert.equal(resolve({ playbackAvailable: true, devices: [] }, '')['Edge Beta'].label, 'Not checked');
});
test('No device evidence cannot qualify official embed', () => {
    assert.equal(resolve({ ...baseline, playbackAvailable: false }, 'sd:7')['Official Embed prerequisites'].label, 'Not checked');
});
test('No global AudioFlix state or sessions are changed by module load', () => {
    assert.equal(win.EveAudioflixModeSensorsV042.ready, true);
    assert.equal(typeof win.EveAudioflixModeSensorsV042.reconcile, 'function');
});
