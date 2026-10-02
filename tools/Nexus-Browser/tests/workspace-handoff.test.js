'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCoordinator, SNAPSHOT_KEY } = require('../public/workspace-handoff');

function sharedStorageBus() {
  const values = new Map(), listeners = new Set();
  const storage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) {
      const oldValue = values.has(key) ? values.get(key) : null;
      values.set(key, String(value));
      for (const listener of listeners) listener({ key, oldValue, newValue: String(value) });
    },
    removeItem(key) {
      const oldValue = values.has(key) ? values.get(key) : null;
      values.delete(key);
      for (const listener of listeners) listener({ key, oldValue, newValue: null });
    }
  };
  return {
    storage,
    addEvent(type, listener) { if (type === 'storage') listeners.add(listener); },
    removeEvent(type, listener) { if (type === 'storage') listeners.delete(listener); }
  };
}

function coordinator(bus, { id, detached }) {
  return createCoordinator({
    storage: bus.storage,
    addEvent: bus.addEvent,
    removeEvent: bus.removeEvent,
    setTimer: () => 1,
    clearTimer() {},
    now: (() => { let value = 1000; return () => ++value; })(),
    detached,
    instanceId: id
  });
}

test('workspace handoff keeps exactly one socket owner and carries view state both directions', () => {
  const bus = sharedStorageBus();
  let embeddedValue = 'embedded-before-detach';
  const embeddedEvents = [], embeddedRestores = [];
  const embedded = coordinator(bus, { id: 'embedded', detached: false });
  embedded.start();
  embedded.register('base', {
    snapshot: () => ({ value: embeddedValue }),
    restore: (value) => { embeddedRestores.push(value?.value); if (value?.value) embeddedValue = value.value; },
    resume: () => embeddedEvents.push('resume'),
    suspend: () => embeddedEvents.push('suspend')
  });
  assert.equal(embedded.isOwner(), true);
  assert.deepEqual(embeddedEvents, ['resume']);

  embedded.snapshotNow('detach');
  let detachedValue = 'detached-empty';
  const detachedEvents = [], detachedRestores = [];
  const detached = coordinator(bus, { id: 'detached', detached: true });
  detached.start();
  detached.register('base', {
    snapshot: () => ({ value: detachedValue }),
    restore: (value) => { detachedRestores.push(value?.value); if (value?.value) detachedValue = value.value; },
    resume: () => detachedEvents.push('resume'),
    suspend: () => detachedEvents.push('suspend')
  });

  assert.equal(embedded.isOwner(), false);
  assert.equal(detached.isOwner(), true);
  assert.deepEqual(embeddedEvents, ['resume', 'suspend']);
  assert.deepEqual(detachedEvents, ['resume']);
  assert.equal(detachedValue, 'embedded-before-detach');

  detachedValue = 'changed-while-detached';
  detached.relinquish('reattach');

  assert.equal(detached.isOwner(), false);
  assert.equal(embedded.isOwner(), true);
  assert.equal(embeddedValue, 'changed-while-detached');
  assert.deepEqual(detachedEvents, ['resume', 'suspend']);
  assert.deepEqual(embeddedEvents, ['resume', 'suspend', 'resume']);
  assert.ok(embeddedRestores.includes('changed-while-detached'));
});

test('a second embedded view cannot steal a fresh detached ownership lease', () => {
  const bus = sharedStorageBus();
  const detached = coordinator(bus, { id: 'detached', detached: true });
  detached.start();
  const secondEmbedded = coordinator(bus, { id: 'embedded-2', detached: false });
  secondEmbedded.start();
  assert.equal(detached.isOwner(), true);
  assert.equal(secondEmbedded.isOwner(), false);
});


test('fresh attached startup clears a stale persisted workspace snapshot', () => {
  const bus = sharedStorageBus();
  bus.storage.setItem(SNAPSHOT_KEY, JSON.stringify({
    version: 1,
    at: 1,
    source: 'old-session',
    parts: { base: { transcript: [{ role: 'user', text: 'old message' }] } }
  }));
  const embedded = coordinator(bus, { id: 'fresh-embedded', detached: false });
  embedded.start();
  assert.equal(embedded.snapshot(), null);
});

test('a fresh detached owner preserves the detach snapshot from a newly loaded embedded standby view', () => {
  const bus = sharedStorageBus();
  const embedded = coordinator(bus, { id: 'embedded', detached: false });
  embedded.start();
  embedded.register('base', { snapshot: () => ({ transcript: ['current detach state'] }) });
  embedded.snapshotNow('detach');
  const detached = coordinator(bus, { id: 'detached', detached: true });
  detached.start();
  const before = detached.snapshot();
  const standby = coordinator(bus, { id: 'new-embedded', detached: false });
  standby.start();
  assert.equal(standby.isOwner(), false);
  assert.deepEqual(standby.snapshot(), before);
});


test('explicit reattach adopts the detached snapshot directly even if storage ownership timing races', () => {
  const bus = sharedStorageBus();
  let embeddedValue = 'attached-old';
  const embedded = coordinator(bus, { id: 'embedded-direct', detached: false });
  embedded.start();
  embedded.register('base', {
    snapshot: () => ({ value: embeddedValue }),
    restore: (value) => { if (value?.value) embeddedValue = value.value; }
  });

  const detachedSnapshot = {
    version: 1,
    at: 2000,
    source: 'detached-direct',
    detached: true,
    reason: 'reattach',
    parts: { base: { value: 'latest-detached-state' } }
  };
  assert.equal(embedded.adoptSnapshot(detachedSnapshot, 'reattach-direct'), true);
  assert.equal(embeddedValue, 'latest-detached-state');
  assert.equal(embedded.isOwner(), true);
  assert.equal(embedded.snapshot().reason, 'reattach-direct');
});
