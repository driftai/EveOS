'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
async function qualifyDashboardOpen() {
  for (const kind of ['nexus-browser', 'watchfusion']) await qualifyManagedTool(kind);
  await qualifyHubRouting();
  return 14;
}
async function qualifyManagedTool(kind) {
  const source = fs.readFileSync(path.resolve(__dirname, '../Nexus-Browser/extension/dashboard-open.js'), 'utf8');
  let healthy = false, conflict = false, denied = false, existing = [], starts = 0, creates = 0, focuses = 0;
  const origin = 'http://127.0.0.1:12345';
  const healthKey = kind === 'watchfusion' ? 'app' : 'service';
  const healthValue = kind === 'watchfusion' ? 'WatchFusion' : 'eveos-nexus-browser';
  const context = vm.createContext({ URL, AbortSignal, setTimeout:callback => { callback(); },
    NexusBrowserRuntimeConfig:{ httpOrigin:origin, controlOrigin:origin, healthUrl:origin+'/health', tabPattern:origin+'/*' },
    fetch:async (url, options) => {
      if (url.endsWith('/health')) return { ok:true, json:async () => ({ ok:healthy || conflict,
        [healthKey]:conflict ? 'unrelated-service' : healthValue }) };
      assert(url.endsWith(`/api/${kind}/start`) && options.method === 'POST');
      starts++; if (!denied) healthy = true;
      return { ok:!denied, json:async () => ({ ok:!denied, message:'Lifecycle permission denied' }) };
    }, chrome:{ tabs:{ query:async () => existing, create:async ({ url }) => { creates++; return { id:8, url }; },
      update:async id => { focuses++; return { id }; } }, windows:{ update:async () => {} } } });
  vm.runInContext(source, context);
  const api = kind === 'nexus-browser' ? context.NexusBrowserDashboard : context.EveOSManagedDashboard.create({
    ...context.NexusBrowserRuntimeConfig, name:'WatchFusion', healthKey, healthValue, startPath:'/api/watchfusion/start' });
  assert.equal((await api.status()).online, false); assert.equal(starts, 0, 'status must remain passive');
  const [first, second] = await Promise.all([api.open(), api.open()]);
  assert.equal(first.tabId, second.tabId); assert.equal(starts, 1); assert.equal(creates, 1, 'concurrent opens must not duplicate startup/tabs');
  existing = [{ id:9, windowId:2, url:origin+'/' }];
  await api.open(); assert.equal(starts, 1); assert.equal(creates, 1); assert.equal(focuses, 1);
  healthy = false; denied = true;
  await assert.rejects(api.open(), /permission denied/); assert.equal(creates, 1, 'denied starts must not open a broken dashboard');
  conflict = true;
  await assert.rejects(api.open(), /another service/); assert.equal(starts, 2, 'port conflict must never issue Start');
}

async function qualifyHubRouting() {
  let listener;
  const opened = [];
  const protocol = require('../../extension/core/protocol.js');
  const context = vm.createContext({ URL, Map, fetch:async () => { throw new Error('Unexpected hub fetch'); },
    EveOSExtensionProtocol:protocol,
    EveOSExtensionCatalog:{ services:[{ id:'watchfusion', url:'http://127.0.0.1:12345/', health:'http://127.0.0.1:12345/api/health' }] },
    EveOSExtensionDiscovery:{ STORAGE_KEY:'saved', create:() => ({}) },
    NexusBrowserRuntimeConfig:{ controlOrigin:'http://127.0.0.1:12346' },
    NexusBrowserDashboard:{ open:async () => { opened.push('nexus-browser'); return { opened:true }; } },
    EveOSManagedDashboard:{ create:config => {
      assert.equal(config.startPath, '/api/watchfusion/start');
      assert.equal(config.healthKey, 'app');
      return { open:async () => { opened.push('watchfusion'); return { opened:true }; } };
    } },
    EveOSExtensionModules:{ describe:async () => ['nexus-browser', 'watchfusion'].map(id => ({
      id, extensionId:'hub', integration:'included', moduleId:id, actions:[] })) },
    EveOSExtensionModuleEntries:[{ id:'watchfusion', popup:'popup.html' }],
    chrome:{ runtime:{ id:'hub', onMessage:{ addListener:fn => { listener = fn; } } },
      storage:{ local:{ get:async () => ({ saved:[] }) } } }
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../extension/service-worker.js'), 'utf8'), context);
  const send = details => new Promise(resolve => listener({ channel:protocol.UI_CHANNEL, ...details }, { id:'hub' }, resolve));
  for (const id of ['nexus-browser', 'watchfusion']) {
    const result = await send({ type:'open-connector', id, extensionId:'hub' });
    assert.equal(result.ok, true); assert.equal(result.detail.uiModule, undefined, 'Open tool must open the managed runtime, not the companion panel');
    assert.equal(opened.at(-1), id);
  }
  assert.equal((await send({ type:'open-service', id:'watchfusion' })).ok, true);
  assert.equal(opened.at(-1), 'watchfusion');
  assert.equal((await send({ type:'invoke-connector', id:'nexus-browser', extensionId:'hub', action:'open-dashboard' })).code, 'UNKNOWN_CONNECTOR_ACTION');
}
module.exports = { qualifyDashboardOpen };
