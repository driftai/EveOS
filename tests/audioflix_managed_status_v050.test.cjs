'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const target = path.join(root, 'js/modules/features/audioflix/audioflix.mode.sensors.v042.js');
const source = fs.readFileSync(target, 'utf8');
const marker = '// EVEOS_MANAGED_RUNTIME_STATUS_V050';
assert.equal(source.split(marker).length, 2, 'Managed runtime status shim must be present once');
const script = source.slice(source.indexOf(marker));
const listeners = {};
const label = {children: [], textContent: 'Managed Engine prerequisites', contains: () => false};
const status = {textContent: 'Not checked', title: '', dataset: {}, contains: () => false};
const row = {lastElementChild: status};
label.parentElement = row;
label.closest = () => null;
const doc = {
    querySelectorAll: () => [label],
    addEventListener: (kind, callback) => { listeners[kind] = callback; }
};
let getter = async () => ({ok:true, nodeAvailable:true, playwrightAvailable:true,
    helperExists:true,browserRunning:true,helperReachable:true,pageAttached:true,
    sessionPresent:true,authState:'signed-in'});
const ctx = {window: {addEventListener(){}, EveAudioflixNative: {
    request: async (...args) => getter(...args)
}}, document: doc, setTimeout(){}};
vm.runInNewContext(script, ctx);
const mod = ctx.window.EveAudioflixManagedRuntimeStatus;

test('live managed engine is Ready without starting playback', async () => {
    assert.equal(mod.classify(await getter())[0], 'Ready');
    await mod.refresh();
    assert.equal(status.textContent, 'Ready');
});
test('stopped engine with healthy dependencies is distinct from missing', async () => {
    getter = async () => ({ok:true,nodeAvailable:true,playwrightAvailable:true,helperExists:true,browserRunning:false});
    assert.equal(mod.classify(await getter())[0], 'Stopped (available)');
});
test('missing Playwright fails with actionable unavailability', async () => {
    getter = async () => ({ok:true,nodeAvailable:true,playwrightAvailable:false,helperExists:true});
    assert.equal(mod.classify(await getter())[0], 'Unavailable');
});
test('unauthenticated engine requires sign-in', async () => {
    getter = async () => ({ok:true,nodeAvailable:true,playwrightAvailable:true,helperExists:true,
      browserRunning:true,helperReachable:true,pageAttached:true,sessionPresent:true,authState:'signed-out'});
    assert.equal(mod.classify(await getter())[0], 'Sign-in required');
});
test('helper with absent page is not falsely Ready', async () => {
    getter = async () => ({ok:true,nodeAvailable:true,playwrightAvailable:true,helperExists:true,
      browserRunning:true,helperReachable:true,pageAttached:false,sessionPresent:true,authState:'signed-in'});
    assert.equal(mod.classify(await getter())[0], 'Starting / disconnected');
});
test('status never uses start, stop, auth, or play endpoints', async () => {
    let routes=[];
    getter = async (url,options) => { routes.push([url, options.method]); return {
       ok:true,nodeAvailable:true,playwrightAvailable:true,helperExists:true,browserRunning:false
    }; };
    await mod.refresh();
    assert.deepEqual(routes, [['/api/audioflix/spotify-browser/status','GET']]);
});
