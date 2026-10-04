'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const manager = require('../app-targets/manager');
const chatgpt = require('../app-targets/chatgpt-windows');

const target = {
  id: 'app-chatgpt-windows',
  providerId: 'chatgpt-desktop',
  providerName: 'ChatGPT App',
  pid: 10,
  windowHandle: 20,
  concreteTargetIdentity: {
    processId: 10,
    windowHandle: 20,
    conversationAnchor: 'anchor-a',
    conversationAnchors: ['anchor-a']
  }
};

function saveAdapter() {
  return {
    listTargets: chatgpt.listTargets,
    sendPrompt: chatgpt.sendPrompt,
    captureLatest: chatgpt.captureLatest,
    probeActiveCompletion: chatgpt.probeActiveCompletion,
    status: chatgpt.status
  };
}

function restoreAdapter(saved) {
  Object.assign(chatgpt, saved);
  manager.invalidateAppTargetCache();
}

test('failed native send overrides stale adapter waiting state and recovery capture clears it', async () => {
  const saved = saveAdapter();
  try {
    chatgpt.listTargets = async () => [target];
    chatgpt.status = () => ({ phase: 'waiting', requestId: 'failed-send' });
    chatgpt.sendPrompt = async () => {
      const error = new Error('Native inspect timed out.');
      error.code = 'APP_UIA_INSPECT_TIMEOUT';
      throw error;
    };
    chatgpt.captureLatest = async () => ({ text: 'Recovered final reply.' });
    manager.invalidateAppTargetCache();
    await assert.rejects(manager.sendAppPrompt({
      targetId: target.id,
      requestId: 'failed-send',
      text: 'hello'
    }), (error) => error.code === 'APP_UIA_INSPECT_TIMEOUT');
    let status = manager.getAppTargetStatus(target.id);
    assert.equal(status.phase, 'error');
    assert.equal(status.code, 'APP_UIA_INSPECT_TIMEOUT');
    assert.match(status.error, /timed out/i);

    const capture = await manager.captureAppLatest({ targetId: target.id });
    assert.equal(capture.text, 'Recovered final reply.');
    status = manager.getAppTargetStatus(target.id);
    assert.equal(status.phase, 'idle');
  } finally {
    restoreAdapter(saved);
  }
});

test('active send reuses cached discovery and blocks competing explicit capture', async () => {
  const saved = saveAdapter();
  let listCalls = 0;
  let releaseSend;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const release = new Promise((resolve) => { releaseSend = resolve; });
  try {
    chatgpt.listTargets = async () => { listCalls += 1; return [target]; };
    chatgpt.status = () => ({ phase: 'streaming' });
    chatgpt.sendPrompt = async () => {
      markStarted();
      await release;
      return { text: 'done' };
    };
    chatgpt.captureLatest = async () => ({ text: 'capture' });
    manager.invalidateAppTargetCache();
    await manager.listAppTargets({ force: true });
    assert.equal(listCalls, 1);

    const send = manager.sendAppPrompt({
      targetId: target.id,
      requestId: 'active-send',
      text: 'hello'
    });
    await started;
    assert.equal(listCalls, 2, 'send resolves the live target once before taking the lease');

    await manager.listAppTargets({ force: true });
    assert.equal(listCalls, 2, 'forced discovery reuses cache while the native send owns UIA');
    await assert.rejects(
      manager.captureAppLatest({ targetId: target.id }),
      (error) => error.code === 'APP_TARGET_BUSY'
    );

    releaseSend();
    const result = await send;
    assert.equal(result.text, 'done');
  } finally {
    releaseSend?.();
    restoreAdapter(saved);
  }
});

test('busy recovery probes the active request read-only without releasing its send lease', async () => {
  const saved = saveAdapter();
  let releaseSend;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const release = new Promise((resolve) => { releaseSend = resolve; });
  const probes = [];
  try {
    chatgpt.listTargets = async () => [target];
    chatgpt.status = () => ({ phase: 'streaming', requestId: 'busy-recover-1' });
    chatgpt.sendPrompt = async () => {
      markStarted();
      await release;
      return { text: 'recovered final' };
    };
    chatgpt.probeActiveCompletion = async ({ target: probedTarget, requestId }) => {
      probes.push({ target: probedTarget, requestId });
      return { recovered: true, requestId, reason: 'busy-recovered-stable' };
    };
    manager.invalidateAppTargetCache();

    const send = manager.sendAppPrompt({
      targetId: target.id,
      requestId: 'busy-recover-1',
      text: 'first prompt'
    });
    await started;
    assert.equal(manager.appTargetBusy(target.id), true);

    const mismatch = await manager.recoverBusyAppTarget({
      targetId: target.id,
      requestId: 'different-request'
    });
    assert.equal(mismatch.recovered, false);
    assert.equal(mismatch.reason, 'request-mismatch');
    assert.equal(probes.length, 0);

    const recovered = await manager.recoverBusyAppTarget({
      targetId: target.id,
      requestId: 'busy-recover-1'
    });
    assert.equal(recovered.recovered, true);
    assert.equal(probes.length, 1);
    assert.equal(probes[0].requestId, 'busy-recover-1');
    assert.equal(probes[0].target.windowHandle, 20);
    assert.equal(manager.appTargetBusy(target.id), true,
      'read-only recovery must not release the original exact-once send lease');

    releaseSend();
    await send;
    assert.equal(manager.appTargetBusy(target.id), false);
  } finally {
    releaseSend?.();
    restoreAdapter(saved);
  }
});

test('non-forced discovery keeps a recent proven target through one transient empty probe', async () => {
  const saved = saveAdapter();
  let listCalls = 0;
  try {
    chatgpt.listTargets = async () => {
      listCalls += 1;
      return listCalls === 1 ? [target] : [];
    };
    manager.invalidateAppTargetCache();

    const initial = await manager.listAppTargets({ force: true });
    assert.equal(initial.length, 1);
    assert.equal(listCalls, 1);

    const smoothed = await manager.listAppTargets({
      now: Date.now() + manager.CACHE_MS + 100
    });
    assert.equal(listCalls, 2);
    assert.equal(smoothed.length, 1);
    assert.equal(smoothed[0].id, target.id);

    const forced = await manager.listAppTargets({ force: true });
    assert.equal(listCalls, 3);
    assert.deepEqual(forced, [], 'forced verification must bypass discovery grace and fail closed');
  } finally {
    restoreAdapter(saved);
  }
});
