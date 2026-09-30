'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
async function qualifyDashboardOpen() {
  const source = fs.readFileSync(path.resolve(__dirname, '../Nexus-Browser/extension/dashboard-open.js'), 'utf8');
  let healthy = false, conflict = false, denied = false, existing = [], starts = 0, creates = 0, focuses = 0;
  const origin = 'http://127.0.0.1:12345';
  const context = vm.createContext({ URL, AbortSignal, setTimeout:callback => { callback(); },
    NexusBrowserRuntimeConfig:{ httpOrigin:origin, controlOrigin:origin, healthUrl:origin+'/health', tabPattern:origin+'/*' },
    fetch:async (url, options) => {
      if (url.endsWith('/health')) return { ok:true, json:async () => ({ ok:healthy || conflict,
        service:conflict ? 'unrelated-service' : 'eveos-nexus-browser' }) };
      assert(url.endsWith('/api/nexus-browser/start') && options.method === 'POST');
      starts++; if (!denied) healthy = true;
      return { ok:!denied, json:async () => ({ ok:!denied, message:'Lifecycle permission denied' }) };
    }, chrome:{ tabs:{ query:async () => existing, create:async ({ url }) => { creates++; return { id:8, url }; },
      update:async id => { focuses++; return { id }; } }, windows:{ update:async () => {} } } });
  vm.runInContext(source, context);
  const api = context.NexusBrowserDashboard;
  assert.equal((await api.status()).online, false); assert.equal(starts, 0, 'status must remain passive');
  const [first, second] = await Promise.all([api.open(), api.open()]);
  assert.equal(first.tabId, second.tabId); assert.equal(starts, 1); assert.equal(creates, 1, 'concurrent opens must not duplicate startup/tabs');
  existing = [{ id:9, windowId:2, url:origin+'/' }];
  await api.open(); assert.equal(starts, 1); assert.equal(creates, 1); assert.equal(focuses, 1);
  healthy = false; denied = true;
  await assert.rejects(api.open(), /permission denied/); assert.equal(creates, 1, 'denied starts must not open a broken dashboard');
  conflict = true;
  await assert.rejects(api.open(), /another service/); assert.equal(starts, 2, 'port conflict must never issue Start');
  return 5;
}
module.exports = { qualifyDashboardOpen };
