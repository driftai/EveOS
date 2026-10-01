const test = require('node:test');
const assert = require('node:assert/strict');

const mirrorApi = require('../extension/chatgpt-app-mirror.js');
const mirrorDedupe = require('../extension/chatgpt-app-mirror-dedupe.js');

function createStorage(seed = {}) {
  const data = { ...seed };
  return {
    data,
    async get(key) {
      if (typeof key === 'string') return { [key]: data[key] };
      return { ...data };
    },
    async set(payload) { Object.assign(data, payload); },
    async remove(key) { delete data[key]; }
  };
}

function createChrome({ tabs = [], storageSeed = {} } = {}) {
  const records = new Map(tabs.map((tab) => [Number(tab.id), { status: 'complete', ...tab }]));
  let nextId = 100;
  const created = [];
  const reloaded = [];
  const sent = [];
  const local = createStorage(storageSeed);
  const api = {
    storage: { local },
    tabs: {
      async query() { return [...records.values()]; },
      async get(id) {
        const tab = records.get(Number(id));
        if (!tab) throw new Error('missing tab');
        return { ...tab };
      },
      async create(input) {
        const tab = { id: nextId++, windowId: 1, title: 'ChatGPT', status: 'complete', ...input };
        records.set(tab.id, tab); created.push({ ...tab }); return { ...tab };
      },
      async reload(id) { reloaded.push(Number(id)); },
      async sendMessage(id, message) {
        sent.push({ id: Number(id), message });
        return { ok: true, adapter: message.type === 'dex_provider_control_rescan' ? 'dex-provider-control' : 'chatgpt' };
      }
    }
  };
  return { api, records, created, reloaded, sent, local };
}

const fakeTimers = {
  setInterval() { return 1; },
  clearInterval() {}
};
const getProvider = (id) => id === 'chatgpt'
  ? { id: 'chatgpt', name: 'ChatGPT', capabilities: { chat: true } }
  : null;
const waitForTabComplete = async (id, chromeApi) => chromeApi.tabs.get(id);

function controllerFor(chromeRecord, extra = {}) {
  return mirrorApi.createController({
    chromeApi: chromeRecord.api,
    getProvider,
    ensureProviderAdapter: async () => true,
    waitForTabComplete: (id) => chromeRecord.api.tabs.get(id),
    publishTabs: async () => true,
    safeSend: () => true,
    timers: fakeTimers,
    ...extra
  });
}

test('App Mirror accepts only exact ChatGPT conversation URLs', () => {
  const good = 'https://chatgpt.com/c/6abde859-1d40-83ea-89b2-2e29b9163a4f';
  assert.equal(mirrorApi.normalizeConversationUrl(good), good);
  assert.equal(mirrorApi.normalizeConversationUrl(good + '/'), good);
  assert.equal(mirrorApi.normalizeConversationUrl('https://chatgpt.com/'), '');
  assert.equal(mirrorApi.normalizeConversationUrl('https://chatgpt.com/g/g-test'), '');
  assert.equal(mirrorApi.normalizeConversationUrl('https://example.com/c/6abde859-1d40-83ea-89b2-2e29b9163a4f'), '');
});

test('App Mirror reuses an exact authenticated conversation tab instead of spawning another', async () => {
  const url = 'https://chatgpt.com/c/6abde859-1d40-83ea-89b2-2e29b9163a4f';
  const chromeRecord = createChrome({ tabs: [{ id: 7, windowId: 2, title: 'Current chat', url }] });
  const controller = controllerFor(chromeRecord);
  const result = await controller.ensure(url);
  assert.equal(result.tab.id, 7);
  assert.equal(chromeRecord.created.length, 0);
  assert.equal(controller.snapshot().url, url);
  assert.ok(chromeRecord.sent.some((entry) => entry.id === 7 && entry.message.type === 'dex_provider_control_rescan'));
});

test('App Mirror opens a background mirror tab when the exact conversation is absent', async () => {
  const url = 'https://chatgpt.com/c/6abde859-1d40-83ea-89b2-2e29b9163a4f';
  const chromeRecord = createChrome();
  const controller = controllerFor(chromeRecord);
  const result = await controller.ensure(url);
  assert.equal(chromeRecord.created.length, 1);
  assert.equal(chromeRecord.created[0].active, false);
  assert.equal(chromeRecord.created[0].url, url);
  assert.equal(result.target.appMirror, true);
  assert.equal(result.target.targetTypeId, 'chatgpt-app-mirror');
  assert.equal(result.target.concreteTargetIdentity.conversationUrl, url);
});

test('hard sync is blocked while the mirror owns an active Nexus turn', async () => {
  const url = 'https://chatgpt.com/c/6abde859-1d40-83ea-89b2-2e29b9163a4f';
  const chromeRecord = createChrome({ tabs: [{ id: 9, windowId: 1, title: 'Chat', url }] });
  const controller = controllerFor(chromeRecord);
  await controller.ensure(url);
  assert.equal(controller.noteDispatch(9, 'dex-turn-active'), true);
  await assert.rejects(
    () => controller.sync({ hard: true }),
    (error) => error?.code === 'APP_MIRROR_BUSY'
  );
  assert.deepEqual(chromeRecord.reloaded, []);
  controller.noteFinal(9, 'dex-turn-active');
  await controller.sync({ hard: true });
  assert.deepEqual(chromeRecord.reloaded, [9]);
});

test('soft mirror pulse rescans without reloading the conversation', async () => {
  const url = 'https://chatgpt.com/c/6abde859-1d40-83ea-89b2-2e29b9163a4f';
  const chromeRecord = createChrome({ tabs: [{ id: 11, windowId: 1, title: 'Chat', url }] });
  const controller = controllerFor(chromeRecord);
  await controller.ensure(url);
  chromeRecord.sent.length = 0;
  await controller.pulse();
  assert.deepEqual(chromeRecord.reloaded, []);
  assert.ok(chromeRecord.sent.some((entry) => entry.message.type === 'dex_provider_control_rescan'));
});

test('App Mirror restores the persisted exact conversation identity', async () => {
  const url = 'https://chatgpt.com/c/6abde859-1d40-83ea-89b2-2e29b9163a4f';
  const chromeRecord = createChrome({
    tabs: [{ id: 12, windowId: 1, title: 'Chat', url }],
    storageSeed: {
      [mirrorApi.STORAGE_KEY]: { url, tabId: 12, savedAt: Date.now() }
    }
  });
  const controller = controllerFor(chromeRecord);
  const restored = await controller.restore();
  assert.equal(restored.configured, true);
  assert.equal(restored.url, url);
  assert.equal(restored.tabId, 12);
});

test('App Mirror command dedupe survives a tab recreation by keying on conversation plus turn identity', async () => {
  const url = 'https://chatgpt.com/c/6abde859-1d40-83ea-89b2-2e29b9163a4f';
  const local = createStorage({
    [mirrorApi.STORAGE_KEY]: { url, tabId: 20, savedAt: Date.now() }
  });
  const previousChrome = global.chrome;
  global.chrome = { storage: { local } };
  try {
    const sender = { tab: { id: 99, url } };
    const key = await mirrorDedupe.actionKey(sender, 'chatgpt:message:turn-123');
    assert.match(key, /turn-123$/);
    assert.equal(await mirrorDedupe.seen(key), false);
    await mirrorDedupe.remember(key);
    assert.equal(await mirrorDedupe.seen(key), true);
    const recreated = { tab: { id: 101, url } };
    assert.equal(await mirrorDedupe.actionKey(recreated, 'chatgpt:message:turn-123'), key);
  } finally {
    global.chrome = previousChrome;
  }
});
