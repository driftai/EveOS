'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore, TTL_MS } = require('../extension/request-ownership');

function storage() {
  let data = {};
  return {
    async get() { return structuredClone(data); },
    async set(next) { data = structuredClone({ ...data, ...next }); }
  };
}

test('request ownership survives a service-worker style store recreation', async () => {
  let now = 10000;
  const disk = storage();
  const first = createStore({ storage: disk, now: () => now });
  await first.remember('turn-a', 41, 'chatgpt');
  const second = createStore({ storage: disk, now: () => now });
  assert.deepEqual(await second.get('turn-a'), { tabId: 41, providerId: 'chatgpt', createdAt: 10000 });
  assert.equal((await second.authorize('turn-a', 41)).ok, true);
});

test('a target switch does not transfer ownership and an unrelated tab is rejected', async () => {
  const store = createStore({ storage: storage(), now: () => 10000 });
  await store.remember('turn-a', 41, 'chatgpt');
  const wrongTab = await store.authorize('turn-a', 77);
  assert.equal(wrongTab.ok, false);
  assert.equal(wrongTab.reason, 'tab-mismatch');
  assert.deepEqual(wrongTab.owner, { tabId: 41, providerId: 'chatgpt', createdAt: 10000 });
  await assert.rejects(store.remember('turn-a', 77, 'claude'), /cannot move/);
  assert.equal((await store.authorize('turn-a', 41)).ok, true);
});

test('stale request ownership expires instead of authorizing an old provider tab forever', async () => {
  let now = 10000;
  const store = createStore({ storage: storage(), now: () => now });
  await store.remember('turn-a', 41, 'chatgpt');
  now += TTL_MS + 1;
  assert.equal(await store.get('turn-a'), null);
  assert.equal((await store.authorize('turn-a', 41)).reason, 'missing-owner');
});
