'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const binding = require('../app-targets/app-target-binding');

function target({
  id = 'app-chatgpt-windows',
  providerId = 'chatgpt-desktop',
  pid = 10,
  hwnd = 20,
  anchor = 'anchor-a',
  anchors = [anchor],
  title = ''
} = {}) {
  return {
    id,
    providerId,
    providerName: 'ChatGPT App',
    title: 'ChatGPT · verified native conversation',
    pid,
    windowHandle: hwnd,
    concreteTargetIdentity: {
      processId: pid,
      windowHandle: hwnd,
      ...(title ? { conversationTitle: title } : {}),
      ...(anchor ? { conversationAnchor: anchor } : {}),
      ...(anchors.length ? { conversationAnchors: anchors } : {})
    }
  };
}

function memoryStorage(selection = null) {
  return {
    selection,
    writes: [],
    readTargetSelection() { return this.selection || { available: false }; },
    writeTargetSelection(value) {
      this.writes.push(value);
      this.selection = { targetId: value.id, target: value };
      return this.selection;
    }
  };
}

test('shared App-Origin binding creates one stable delivery scope', () => {
  const first = binding.createBinding(target());
  assert.match(first.concreteTargetIdentity.deliveryScope, /^[a-f0-9]{64}$/);
  const second = binding.createBinding(first);
  assert.equal(second.concreteTargetIdentity.deliveryScope,
    first.concreteTargetIdentity.deliveryScope);
});

test('automatic binding restores and advances the exact persisted conversation', () => {
  const stored = binding.createBinding(target({ anchor: 'anchor-a' }));
  const live = target({
    anchor: 'anchor-b',
    anchors: ['anchor-a', 'anchor-b']
  });
  const storage = memoryStorage({ targetId: stored.id, target: stored });
  const appTargetsApi = {
    advanceAppTargetBinding(expected, actual) {
      assert.equal(expected.id, actual.id);
      return {
        ...expected,
        concreteTargetIdentity: {
          ...expected.concreteTargetIdentity,
          conversationAnchor: 'anchor-b',
          conversationAnchors: ['anchor-a', 'anchor-b']
        }
      };
    }
  };

  const result = binding.restorePersistedBinding({
    selection: storage.readTargetSelection(),
    liveTargets: [live],
    appTargetsApi,
    storage,
    allowSingleTargetFallback: true
  });

  assert.equal(result.mode, 'restored');
  assert.equal(result.binding.concreteTargetIdentity.conversationAnchor, 'anchor-b');
  assert.equal(result.binding.concreteTargetIdentity.deliveryScope,
    stored.concreteTargetIdentity.deliveryScope);
  assert.equal(storage.writes.length, 1);
});

test('automatic binding recovers a poisoned selection from one strong live ChatGPT target', () => {
  const storage = memoryStorage({
    targetId: 'app-chatgpt-windows',
    target: {
      id: 'app-chatgpt-windows',
      providerId: 'chatgpt-desktop',
      concreteTargetIdentity: { deliveryScope: 'synthetic' }
    }
  });
  const live = target();

  const result = binding.restorePersistedBinding({
    selection: storage.readTargetSelection(),
    liveTargets: [live],
    appTargetsApi: { advanceAppTargetBinding() { return null; } },
    storage,
    allowSingleTargetFallback: true
  });

  assert.equal(result.mode, 'recovered-single-target');
  assert.equal(result.binding.pid, 10);
  assert.equal(result.binding.windowHandle, 20);
  assert.match(result.binding.concreteTargetIdentity.deliveryScope, /^[a-f0-9]{64}$/);
});

test('automatic binding fails closed when multiple strong ChatGPT targets are available', () => {
  const storage = memoryStorage();
  assert.throws(() => binding.restorePersistedBinding({
    selection: storage.readTargetSelection(),
    liveTargets: [
      target({ id: 'one', pid: 10, hwnd: 20, anchor: 'a' }),
      target({ id: 'two', pid: 11, hwnd: 21, anchor: 'b' })
    ],
    appTargetsApi: { advanceAppTargetBinding() { return null; } },
    storage,
    allowSingleTargetFallback: true
  }), (error) => error.code === 'AUTO_BIND_AMBIGUOUS');
});

test('automatic binding refuses a target without PID/HWND and conversation proof', () => {
  const storage = memoryStorage();
  assert.throws(() => binding.restorePersistedBinding({
    selection: storage.readTargetSelection(),
    liveTargets: [{
      id: 'app-chatgpt-windows',
      providerId: 'chatgpt-desktop',
      concreteTargetIdentity: {}
    }],
    appTargetsApi: { advanceAppTargetBinding() { return null; } },
    storage,
    allowSingleTargetFallback: true
  }), (error) => error.code === 'AUTO_BIND_TARGET_UNAVAILABLE');
});
