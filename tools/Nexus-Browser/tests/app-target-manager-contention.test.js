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
