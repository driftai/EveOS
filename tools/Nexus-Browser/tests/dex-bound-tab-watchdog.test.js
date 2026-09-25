'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBoundTabWatchdog } = require('../extension/dex-bound-tab-watchdog.js');

function memoryStore() {
  const values = new Map();
  return {
    values,
    async get(key) { return { [key]: values.get(key) }; },
    async set(obj) { for (const [k, v] of Object.entries(obj)) values.set(k, v); },
    async remove(key) { values.delete(key); }
  };
}

function harness({ revision = 45, control = true, draft = false } = {}) {
  const local = memoryStore(), session = memoryStore();
  const sent = [], injected = [], reloaded = [], runtimeReloads = [];
  const tab = { id: 42, url: 'https://chatgpt.com/c/eve' };
  const api = {
    runtime: { reload() { runtimeReloads.push(true); } },
    storage: { local, session },
    tabs: {
      async get(id) { assert.equal(id, 42); return tab; },
      async reload(id, options) { reloaded.push({ id, options }); },
      async sendMessage(id, msg) {
        sent.push(msg.type);
        if (msg.type === 'provider_adapter_revision_ping')
          return { ok: true, adapter: 'provider-adapter-revision', revision };
        if (msg.type === 'dex_provider_control_ping')
          return control ? { ok: true, adapter: 'dex-provider-control', revision } : null;
        if (msg.type === 'dex_provider_control_rescan') return { ok: true };
        return null;
      }
    },
    scripting: {
      async executeScript(options) {
        if (options.files) { injected.push(options.files[0]); control = true; return []; }
        return [{ result: draft }];
      }
    }
  };
  const watchdog = createBoundTabWatchdog({
    chromeApi: api, getSocket: () => null, expectedRevision: 45, now: () => 1000
  });
  return { watchdog, api, local, session, sent, injected, reloaded, runtimeReloads,
    target: { targetClassId: 'online-origin', providerId: 'chatgpt',
      targetId: 42, url: tab.url, roomIds: ['room-eve-astro'] } };
}

test('current exact bound ChatGPT tab is rescanned without a reload', async (t) => {
  const h = harness();
  t.after(() => h.watchdog.stop());
  await h.watchdog.repairTarget(h.target, { hardReloadSafe: true });
  assert.ok(h.sent.includes('dex_provider_control_rescan'));
  assert.equal(h.reloaded.length, 0);
});

test('missing control watcher is soft-injected and immediately rescans the visible turn', async (t) => {
  const h = harness({ control: false });
  t.after(() => h.watchdog.stop());
  await h.watchdog.repairTarget(h.target, { hardReloadSafe: true });
  assert.deepEqual(h.injected, ['content/dex-provider-control.js']);
  assert.ok(h.sent.includes('dex_provider_control_rescan'));
  assert.equal(h.reloaded.length, 0);
});

test('stale page revision reloads only when globally safe and no composer draft exists', async (t) => {
  const h = harness({ revision: 44 });
  t.after(() => h.watchdog.stop());
  await h.watchdog.repairTarget(h.target, { hardReloadSafe: false });
  assert.equal(h.reloaded.length, 0);
  await h.watchdog.repairTarget(h.target, { hardReloadSafe: true });
  assert.equal(h.reloaded.length, 1);
  await h.watchdog.repairTarget(h.target, { hardReloadSafe: true });
  assert.equal(h.reloaded.length, 1, 'one persistent attempt per expected revision');
});

test('stale page revision never destroys an unsent ChatGPT composer draft', async (t) => {
  const h = harness({ revision: 44, draft: true });
  t.after(() => h.watchdog.stop());
  await h.watchdog.repairTarget(h.target, { hardReloadSafe: true });
  assert.equal(h.reloaded.length, 0);
  assert.ok(h.watchdog.diagnostics().deferred >= 1);
});

test('stale extension runtime self-reloads once per server-advertised revision when globally idle', async (t) => {
  const h = harness();
  t.after(() => h.watchdog.stop());
  assert.equal(await h.watchdog.runtimeReloadIfNeeded({
    expectedAdapterRevision: 46, reloadSafe: false
  }), false);
  assert.equal(h.runtimeReloads.length, 0);
  assert.equal(await h.watchdog.runtimeReloadIfNeeded({
    expectedAdapterRevision: 46, reloadSafe: true
  }), true);
  assert.equal(h.runtimeReloads.length, 1);
  assert.equal(await h.watchdog.runtimeReloadIfNeeded({
    expectedAdapterRevision: 46, reloadSafe: true
  }), false);
  assert.equal(h.runtimeReloads.length, 1, 'uncertain runtime reload is never looped');
});
