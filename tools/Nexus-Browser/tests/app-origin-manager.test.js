'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const manager = require('../app-targets/manager');

const TARGET_ID = 'app-chatgpt-windows';
const target = {
  id: TARGET_ID,
  title: 'ChatGPT',
  providerId: 'chatgpt-desktop',
  providerName: 'ChatGPT App',
  targetClassId: 'app-origin',
  targetTypeId: 'desktop-app',
  targetTypeName: 'Desktop App',
  pid: 118148,
  windowHandle: 4473474,
  concreteTargetIdentity: {
    kind: 'windows-app-window',
    processId: 118148,
    windowHandle: 4473474
  }
};

test('App-Origin manager coalesces concurrent forced discovery into one UIA scan', async () => {
  const adapter = manager.adapterForTarget(TARGET_ID);
  const originalList = adapter.listTargets;
  let release;
  let calls = 0;
  adapter.listTargets = async () => {
    calls += 1;
    await new Promise((resolve) => { release = resolve; });
    return [target];
  };
  manager.invalidateAppTargetCache();

  try {
    const first = manager.listAppTargets({ force: true });
    const second = manager.listAppTargets({ force: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, 'concurrent refreshes must share one expensive native discovery');
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a[0].id, TARGET_ID);
    assert.equal(b[0].id, TARGET_ID);
  } finally {
    release?.();
    adapter.listTargets = originalList;
    manager.invalidateAppTargetCache();
  }
});

test('App-Origin manager serializes sends per exact native target and releases the lease', async () => {
  const adapter = manager.adapterForTarget(TARGET_ID);
  assert.ok(adapter, 'ChatGPT App adapter must be registered');

  const originalList = adapter.listTargets;
  const originalSend = adapter.sendPrompt;
  let releaseFirst;
  let sends = 0;

  adapter.listTargets = async () => [target];
  adapter.sendPrompt = async ({ requestId }) => {
    sends += 1;
    if (requestId === 'first') {
      await new Promise((resolve) => { releaseFirst = resolve; });
    }
    return { text: requestId };
  };
  manager.invalidateAppTargetCache();

  try {
    const first = manager.sendAppPrompt({
      targetId: TARGET_ID, requestId: 'first', text: 'one', emit() {}
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.appTargetBusy(TARGET_ID), true);

    await assert.rejects(
      () => manager.sendAppPrompt({
        targetId: TARGET_ID, requestId: 'second', text: 'two', emit() {}
      }),
      (error) => error?.code === 'APP_TARGET_BUSY'
    );
    assert.equal(sends, 1, 'busy rejection must happen before the adapter sees a second prompt');

    releaseFirst();
    assert.equal((await first).text, 'first');
    assert.equal(manager.appTargetBusy(TARGET_ID), false);

    const third = await manager.sendAppPrompt({
      targetId: TARGET_ID, requestId: 'third', text: 'three', emit() {}
    });
    assert.equal(third.text, 'third');
    assert.equal(sends, 2);
    assert.equal(manager.appTargetBusy(TARGET_ID), false);
  } finally {
    releaseFirst?.();
    adapter.listTargets = originalList;
    adapter.sendPrompt = originalSend;
    manager.invalidateAppTargetCache();
  }
});

test('App-Origin manager releases a target lease after adapter failure', async () => {
  const adapter = manager.adapterForTarget(TARGET_ID);
  const originalList = adapter.listTargets;
  const originalSend = adapter.sendPrompt;
  adapter.listTargets = async () => [target];
  adapter.sendPrompt = async () => {
    const error = new Error('synthetic app failure');
    error.code = 'SYNTHETIC_APP_FAILURE';
    throw error;
  };
  manager.invalidateAppTargetCache();

  try {
    await assert.rejects(
      () => manager.sendAppPrompt({
        targetId: TARGET_ID, requestId: 'failure', text: 'fail', emit() {}
      }),
      (error) => error?.code === 'SYNTHETIC_APP_FAILURE'
    );
    assert.equal(manager.appTargetBusy(TARGET_ID), false,
      'failed native dispatch must not permanently lock the target');
  } finally {
    adapter.listTargets = originalList;
    adapter.sendPrompt = originalSend;
    manager.invalidateAppTargetCache();
  }
});


test('App-Origin manager publishes active native-turn identity for passive dedupe', async () => {
  const targetId = 'app-chatgpt-windows';
  const adapter = manager.adapterForTarget(targetId);
  const originalList = adapter.listTargets;
  const originalSend = adapter.sendPrompt;
  const originalCompleted = adapter.completedTurns;
  const fingerprint = 'a'.repeat(64);
  const observed = [];
  const nativeTarget = {
    id: targetId,
    title: 'ChatGPT · Test response',
    providerId: 'chatgpt-desktop',
    providerName: 'ChatGPT App',
    targetTypeId: 'desktop-app',
    pid: 118148,
    windowHandle: 4473474,
    concreteTargetIdentity: {
      kind: 'windows-app-window',
      processId: 118148,
      windowHandle: 4473474,
      conversationAnchor: 'b'.repeat(64),
      conversationAnchors: ['b'.repeat(64)]
    }
  };
  const unsubscribe = manager.onAppTurnFinal((event) => observed.push(event));
  adapter.listTargets = async () => [nativeTarget];
  adapter.completedTurns = () => [{ fingerprint, text: 'same native final' }];
  adapter.sendPrompt = async () => ({ text: 'same native final', snapshot: {} });
  manager.invalidateAppTargetCache();

  try {
    await manager.sendAppPrompt({
      targetId, requestId: 'active-native-turn', text: 'hello', emit() {}
    });
    assert.equal(observed.length, 1);
    assert.equal(observed[0].source, 'active');
    assert.equal(observed[0].turn.fingerprint, fingerprint);
  } finally {
    unsubscribe();
    adapter.listTargets = originalList;
    adapter.sendPrompt = originalSend;
    adapter.completedTurns = originalCompleted;
    manager.invalidateAppTargetCache();
  }
});


test('App-Origin conversation continuity accepts rolling anchor overlap and rejects unrelated chats', () => {
  const a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64);
  const d = 'd'.repeat(64), x = 'f'.repeat(64);
  const bound = {
    id: TARGET_ID,
    providerId: 'chatgpt-desktop',
    concreteTargetIdentity: {
      processId: 118148,
      windowHandle: 4473474,
      conversationAnchor: c,
      conversationAnchors: [a, b, c]
    }
  };
  const appended = {
    id: TARGET_ID,
    providerId: 'chatgpt-desktop',
    concreteTargetIdentity: {
      processId: 118148,
      windowHandle: 4473474,
      conversationAnchor: d,
      conversationAnchors: [b, c, d]
    }
  };
  assert.equal(manager.exactAppTargetMatch(bound, appended), true);
  const advanced = manager.advanceAppTargetBinding(bound, appended);
  assert.ok(advanced);
  assert.deepEqual(advanced.concreteTargetIdentity.conversationAnchors, [a, b, c, d]);

  const unrelated = {
    ...appended,
    concreteTargetIdentity: {
      processId: 118148,
      windowHandle: 4473474,
      conversationAnchor: x,
      conversationAnchors: [x]
    }
  };
  assert.equal(manager.exactAppTargetMatch(advanced, unrelated), false);
  assert.equal(manager.advanceAppTargetBinding(advanced, unrelated), null);
});
