'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function qualifyMediaWorker() {
  const state = {}, listeners = [], sent = [], injected = [], offscreen = [];
  let rejectCapture = false;
  const context = vm.createContext({ console, URL, Date, Map, Set, Promise, importScripts() {},
    EveOSExtensionModuleRoots: { watchfusion: 'modules/watchfusion/' } });
  context.chrome = {
    runtime: {
      id: 'official', getURL: value => `chrome-extension://official/${value}`,
      getContexts: async () => [], onMessage: { addListener: fn => listeners.push(fn) },
      sendMessage: async message => { sent.push(message); return { ok: true }; }
    },
    storage: { session: {
      get: async () => ({ ...state }), set: async value => Object.assign(state, value),
      remove: async key => { delete state[key]; }
    } },
    tabs: { query: async () => [{ id: 7 }], sendMessage: async (...args) => { sent.push(args); return { ok: true }; },
      onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
    tabCapture: { getMediaStreamId: async () => { if (rejectCapture) throw new Error('Capture denied'); return 'fixture-stream'; } },
    offscreen: { createDocument: async details => { offscreen.push(details); } },
    scripting: { executeScript: async details => {
      injected.push(details);
      // The real probe can report before executeScript resolves. Keep that sample.
      vm.runInContext(`combinedSample(1, {token:'player',topFrame:false,hasMedia:true,score:3,rect:{x:.1,y:.2,width:.8,height:.6},metadata:{title:'frame'}})`, context);
      return [{ frameId: 0 }, { frameId: 1 }];
    } }
  };
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../tools/WatchFusion/browser-extension/worker.js'), 'utf8'), context);
  const link = 'http://localhost:19193/#live=12345678-1234-1234-1234-123456789abc.' + 'a'.repeat(48);
  await context.WatchFusionMediaLink.startCurrentTab(link);
  assert.equal(state.sourceTab, 7);
  assert.equal(injected[0].files[0], 'modules/watchfusion/source-probe.js');
  assert.equal(offscreen[0].url, 'modules/watchfusion/offscreen.html');
  assert.equal(vm.runInContext('frameSamples.get(1).metadata.title', context), 'frame');
  vm.runInContext(`combinedSample(0, {token:'root',topFrame:true,hasMedia:false,children:[{token:'player',rect:{x:.2,y:.1,width:.5,height:.8}}]})`, context);
  const crop = vm.runInContext(`combinedSample(1, {token:'player',topFrame:false,hasMedia:true,score:3,rect:{x:.1,y:.2,width:.8,height:.6}}).rect`, context);
  assert.equal(crop.x, .25); assert.equal(crop.width, .4);
  assert(Math.abs(crop.y - .26) < 1e-9); assert.equal(crop.height, .48);
  const missing = vm.runInContext(`combinedSample(0, {token:'root',topFrame:true,hasMedia:false,children:[],rect:{x:0,y:0,width:1,height:1}})`, context);
  assert.equal(missing.rect, null, 'unassociated comments frames must never become the media crop');
  assert.match(missing.metadata.status, /embedded players/);
  await new Promise(resolve => listeners[0]({ to: 'worker', type: 'control', action: 'pause' },
    { id: 'official', url: 'chrome-extension://official/modules/watchfusion/offscreen.html' }, resolve));
  assert(sent.some(value => Array.isArray(value) && value[2]?.frameId === 1 && value[1].type === 'source-control'));
  rejectCapture = true;
  await assert.rejects(context.WatchFusionMediaLink.startCurrentTab(link), /Capture denied/);
  assert.equal(state.sourceTab, undefined);
  assert.equal((await context.WatchFusionMediaLink.status()).linked, false);
  await qualifyAudioflixFailure();
  await qualifyLiveActions();
  await qualifyConnectorActions();
  return 17;
}

async function qualifyConnectorActions() {
  const source = fs.readFileSync(path.resolve(__dirname, '../WatchFusion/browser-extension/eveos-hub-connector.js'), 'utf8');
  for (const bundled of [false, true]) {
    let handle;
    const requests = [];
    const sandbox = vm.createContext({
      chrome: { storage: { session: { get: async () => ({}) } }, runtime: {
        getManifest: () => ({ version: 'fixture' }),
        onMessageExternal: { addListener: listener => { handle = message => new Promise(resolve => listener(message, {}, resolve)); } }
      } },
      fetch: async url => { requests.push(url); return { ok: true, json: async () => ({ ok: true }) }; },
      ...(bundled ? { EveOSExtensionModules: { register: (_id, listener) => { handle = listener; } } } : {})
    });
    vm.runInContext(source, sandbox);
    const request = type => ({ channel: 'eveos.extension.v1', version: 1, type });
    const described = await handle(request('describe'));
    assert(!described.detail.actions.some(action => action.id === 'open-extension-folder'), 'folder access belongs only in WatchFusion');
    const obsolete = await handle({ ...request('invoke'), detail: { action: 'open-extension-folder' } });
    assert.equal(obsolete.code, 'UNKNOWN_ACTION');
    assert(requests.every(url => !url.includes('open-extension-folder')), 'obsolete extension actions cannot open folders');
  }
}

async function qualifyLiveActions() {
  const elements = new Map(), listeners = {}, saved = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', hidden: false, dataset: {}, style: {},
      setAttribute() {}, querySelectorAll: () => [], replaceChildren() {}, addEventListener() {}, play: async () => {} });
    return elements.get(id);
  };
  const window = { addEventListener: (type, callback) => { listeners[type] = callback; }, removeEventListener() {},
    watchPartyProviders: { register() {} }, WatchFusionLivePeer: class { stop() {} } };
  const target = { postMessage: message => queueMicrotask(() => listeners.message({ source: target,
    data: { type: 'watchfusion:extension-folder-result', requestId: message.requestId, ok: true, message: `${message.package} opened` } })) };
  window.parent = target;
  const sandbox = vm.createContext({ window, $: element, session: null, roomId: null,
    document: { activeElement: null }, ytPlayer: null, state: { source: null },
    location: { origin: 'http://localhost:19193' }, crypto: require('node:crypto').webcrypto,
    localStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
    apiUrl: value => value, makeClientId: () => require('node:crypto').randomUUID(), setStatus() {}, isHost: () => true, URL, setTimeout, clearTimeout,
    copyText: async () => true, setCopyButtonFeedback() {}, fetch: async () => ({ ok: true, json: async () => ({ id: 'test', publisherToken: 'private', viewerToken: 'viewer' }) }) });
  sandbox.applySoloSource = source => { sandbox.state = { source }; window.watchFusionLive.load(source); };
  let unloaded = 0;
  window.unloadWatchFusionMedia = async () => { unloaded++; await window.watchFusionLive.unload(); sandbox.state = { source: null }; };
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../WatchFusion/public/client/live-source.js'), 'utf8'), sandbox);
  await element('linkTabBtn').onclick();
  assert.equal(element('linkTabBtn').textContent, 'Unlink playing tab');
  await element('linkTabBtn').onclick();
  assert.equal(unloaded, 1); assert.equal(element('linkTabBtn').textContent, 'Link a playing tab');
  sandbox.state = { source: { kind: 'live', mode: 'audioflix', streamId: 'audio' } };
  window.watchFusionLive.load(sandbox.state.source);
  assert.equal(element('linkAudioflixBtn').textContent, 'Disconnect Audioflix');
  await element('linkAudioflixBtn').onclick();
  assert.equal(unloaded, 2); assert.equal(element('linkAudioflixBtn').textContent, 'Connect Audioflix');
  await element('livePairOfficialFolder').onclick();
  assert.equal(element('livePairFeedback').textContent, 'official opened');
  await element('livePairFolder').onclick();
  assert.equal(element('livePairFeedback').textContent, 'watchfusion opened');
}

async function qualifyAudioflixFailure() {
  const listeners = {}, replies = [];
  let tapReleased = 0, muteReleased = 0;
  const source = { postMessage: message => replies.push(message) };
  const controller = {
    getActivePlayer: () => ({}),
    createLiveTap: async () => ({ stream: {}, release: () => { tapReleased += 1; } }),
    acquireSpeakerMute: () => () => { muteReleased += 1; }
  };
  const window = {
    EveAudioflixAudio: { getPlaybackState: () => ({ item: {} }), getWaveformController: () => controller },
    EveWatchFusionRuntimeSensor: { isCandidateOrigin: () => true },
    WatchFusionLivePeer: class { constructor() { throw new Error('fixture publisher refused'); } },
    addEventListener: (type, callback) => { listeners[type] = callback; }
  };
  const sandbox = vm.createContext({ window, document: { querySelector: () => ({ contentWindow: source }) },
    Map, URL, Date, setTimeout() {}, clearInterval() {}, setInterval() {} });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../js/modules/features/watchfusion/watchfusion.audioflix-link.js'), 'utf8'), sandbox);
  const event = { source, origin: 'http://localhost:19193' };
  await listeners.message({ ...event, data: { type: 'watchfusion:audioflix-probe', requestId: 'fixture' } });
  await listeners.message({ ...event, data: { type: 'watchfusion:audioflix-start', requestId: 'fixture',
    config: { id: 'fixture', base: event.origin } } });
  assert.equal(tapReleased, 1, 'failed publisher must release its capture tap');
  assert.equal(muteReleased, 1, 'failed publisher must restore host speaker monitoring');
  assert.equal(window.EveWatchFusionAudioflixLink.active(), false);
  assert.match(replies.at(-1).error, /publisher refused/);
}
module.exports = { qualifyMediaWorker };
