'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const baseApi = require('../public/workspace-base-state');
const dexApi = require('../public/workspace-dex-state');

test('Base handoff restores the saved App-Origin target immediately before socket rebind', () => {
  const state = {
    selectedTargetClassId: 'online-origin',
    selectedProviderId: 'deepseek',
    selectedLocalTypeId: 'terminal-agent',
    onlineTarget: null,
    localTarget: null
  };
  const restored = [];
  const el = {
    prompt: { value: '' },
    transcript: { replaceChildren() {}, querySelectorAll() { return []; }, scrollTop: 0 }
  };
  const workspace = baseApi.create({
    state, el,
    restoreAppTarget: (target, binding) => restored.push({ target, binding })
  });
  const target = { id: 'app-chatgpt-windows', providerId: 'chatgpt-desktop',
    concreteTargetIdentity: { processId: 10, windowHandle: 20 } };
  const binding = { ...target.concreteTargetIdentity, deliveryScope: 'a'.repeat(64) };
  workspace.restore({
    selectedTargetClassId: 'app-origin',
    selectedProviderId: 'chatgpt',
    appTarget: target,
    appBindingIdentity: binding,
    transcript: []
  });
  assert.equal(state.selectedTargetClassId, 'app-origin');
  assert.equal(restored.length, 1);
  assert.equal(restored[0].target.id, target.id);
  assert.equal(restored[0].binding.deliveryScope, binding.deliveryScope);
});

test('Dex handoff defers active-room restoration until authoritative rooms arrive', () => {
  const previousDocument = global.document;
  global.document = { body: { dataset: { bridgeMode: 'base' } } };
  try {
    const state = { rooms: [], activeRoomId: null };
    let renders = 0, mode = '';
    const workspace = dexApi.create({
      state,
      el: { dexPrompt: { value: '' }, dexTranscript: { scrollTop: 0 } },
      setMode: (value) => { mode = value; },
      renderAll: () => { renders += 1; }
    });
    workspace.restore({ activeRoomId: 'room-detached', mode: 'dex', draft: 'still here' });
    assert.equal(state.activeRoomId, null);
    assert.equal(mode, 'dex');
    state.rooms = [{ id: 'room-detached' }, { id: 'room-other' }];
    assert.equal(workspace.afterStateSync(), true);
    assert.equal(state.activeRoomId, 'room-detached');
    assert.ok(renders >= 2);
  } finally {
    global.document = previousDocument;
  }
});


test('App-Origin restore path does not treat a restore acknowledgement as a new transcript event', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app-targets-ui.js'), 'utf8');
  assert.match(source, /if \(!restoring && \(selectedTarget\?\.id \|\| null\) !== previousTargetId\)/);
});


test('a new Nexus server session clears Base transcript and target state but same-session handoff does not', () => {
  const previousDocument = global.document;
  const previousRequestAnimationFrame = global.requestAnimationFrame;
  global.document = {
    createElement() {
      return {
        className: '', dataset: {}, classList: { add() {} },
        append() {}, querySelector() { return { textContent: '' }; }
      };
    }
  };
  global.requestAnimationFrame = (fn) => fn();
  try {
    let cleared = 0, restoredApp = 'unset', renders = 0;
    const transcript = {
      scrollTop: 0,
      querySelectorAll() { return []; },
      replaceChildren() { cleared += 1; }
    };
    const state = {
      serverSessionId: 'session-old',
      selectedTargetClassId: 'app-origin',
      selectedProviderId: 'chatgpt',
      selectedLocalTypeId: 'terminal-agent',
      onlineTarget: { id: 1 },
      localTarget: { id: 'local-1' },
      pending: new Map([['req', {}]])
    };
    const workspace = baseApi.create({
      state,
      el: { prompt: { value: 'draft' }, transcript },
      restoreAppTarget: (target) => { restoredApp = target; },
      render: () => { renders += 1; }
    });

    assert.equal(workspace.onServerSession('session-old'), false);
    assert.equal(cleared, 0);

    assert.equal(workspace.onServerSession('session-new'), true);
    assert.equal(state.serverSessionId, 'session-new');
    assert.equal(state.onlineTarget, null);
    assert.equal(state.localTarget, null);
    assert.equal(state.pending.size, 0);
    assert.equal(restoredApp, null);
    assert.equal(cleared, 1);
    assert.ok(renders >= 1);
  } finally {
    global.document = previousDocument;
    global.requestAnimationFrame = previousRequestAnimationFrame;
  }
});
