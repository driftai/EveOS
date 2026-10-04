const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const access = require('../extension/host-access.js');

test('originPattern normalizes provider pages to an origin host permission', () => {
  assert.equal(access.originPattern('https://chat.deepseek.com/a/chat/s/test'), 'https://chat.deepseek.com/*');
  assert.equal(access.originPattern('https://muse.ai/chat'), 'https://muse.ai/*');
  assert.equal(access.originPattern('chrome://extensions'), null);
});

test('declaresAllSites detects the global host-permission manifest mode', () => {
  assert.equal(access.declaresAllSites({ host_permissions: ['<all_urls>'] }), true);
  assert.equal(access.declaresAllSites({ host_permissions: ['https://chatgpt.com/*'] }), false);
});

test('hasHostAccess reflects Chrome runtime host-access state', async () => {
  const permissionsApi = { contains: async ({ origins }) => origins[0] === 'https://chatgpt.com/*' };
  assert.equal((await access.hasHostAccess('https://chatgpt.com/c/test', permissionsApi)).ok, true);
  const blocked = await access.hasHostAccess('https://claude.ai/chat/test', permissionsApi);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'host-access-withheld');
});

test('requireHostAccess keeps legacy per-site requests when all-sites is not declared', async () => {
  const calls = [];
  const permissionsApi = {
    contains: async () => false,
    addHostAccessRequest: async (request) => calls.push(request)
  };
  await assert.rejects(
    access.requireHostAccess(42, 'https://muse.ai/chat', permissionsApi, { host_permissions: ['https://muse.ai/*'] }),
    (error) => error.code === 'HOST_ACCESS_REQUIRED'
      && error.detail.pattern === 'https://muse.ai/*'
      && error.detail.requestAdded === true
      && error.detail.allSitesDeclared === false
  );
  assert.deepEqual(calls, [{ tabId: 42, pattern: 'https://muse.ai/*' }]);
});

test('all-sites mode does not queue per-site host requests and points Chrome to the one-time global grant', async () => {
  const calls = [];
  const permissionsApi = {
    contains: async () => false,
    addHostAccessRequest: async (request) => calls.push(request)
  };
  await assert.rejects(
    access.requireHostAccess(42, 'https://muse.ai/chat', permissionsApi, { host_permissions: ['<all_urls>'] }),
    (error) => error.code === 'HOST_ACCESS_REQUIRED'
      && error.detail.pattern === 'https://muse.ai/*'
      && error.detail.requestAdded === false
      && error.detail.allSitesDeclared === true
      && /On all sites/.test(error.message)
  );
  assert.deepEqual(calls, []);
});

test('service worker checks host access before adapter recovery and preserves its error code', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', 'extension', 'service-worker.js'), 'utf8');
  const selectStart = worker.indexOf('async function selectTarget');
  const selectEnd = worker.indexOf('async function selectedProviderAndTab', selectStart);
  const selectBody = worker.slice(selectStart, selectEnd);
  assert.match(selectBody, /hostAccessApi\.requireHostAccess/);
  assert.ok(selectBody.indexOf('requireHostAccess') < selectBody.indexOf('ensureProviderAdapter'));
  assert.match(worker, /emitError\(error\.code \|\| 'COMMAND_FAILED'/);
});

test('service-worker entry loads host-access before provider-control boot', () => {
  const entry = fs.readFileSync(path.join(__dirname, '..', 'extension', 'service-worker-entry.js'), 'utf8');
  assert.ok(entry.indexOf("importScripts('host-access.js')") < entry.indexOf("importScripts('dex-provider-control-boot.js')"));
});


test('Base and Dex UIs surface host-access failures as an actionable one-time permission step', () => {
  const base = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const dex = fs.readFileSync(path.join(__dirname, '..', 'public', 'dex-mode.js'), 'utf8');
  const helper = require('../public/host-access-ui.js');
  assert.equal(helper.message({ code: 'OTHER' }), null);
  assert.match(helper.message({ code: 'HOST_ACCESS_REQUIRED', detail: { pattern: 'https://example.test/*' } }), /Chrome site access is required.*extension Site access/);
  assert.match(helper.message({ code: 'HOST_ACCESS_REQUIRED', detail: { allSitesDeclared: true } }), /On all sites/);
  assert.match(base, /hostAccessUiApi\.message.*click Connect target again/);
  assert.match(dex, /hostAccessUiApi\.message.*retry the Dex relay/);
  assert.match(dex, /Site access required/);
});
