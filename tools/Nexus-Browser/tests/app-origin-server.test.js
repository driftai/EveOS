const test = require('node:test');
const assert = require('node:assert/strict');

const { createAppTargetServerController } = require('../app-targets/server-controller');

function harness() {
  const target = {
    id: 'app-chatgpt-windows',
    title: 'ChatGPT',
    providerId: 'chatgpt-desktop',
    providerName: 'ChatGPT App',
    targetClassId: 'app-origin',
    targetTypeId: 'desktop-app'
  };
  const messages = [];
  const observed = [];
  const ws = { clientKind: 'browser', appTargetId: null };
  const durability = {
    async beforeDispatch(msg, meta) {
      observed.push({ kind: 'before', requestId: msg.requestId, meta });
      return { ok: true };
    },
    async observe(payload, meta) {
      observed.push({ kind: 'observe', type: payload.type, meta });
    },
    async markFailed() {}
  };
  const appTargets = {
    async listAppTargets() { return [target]; },
    publicAppTargetTypes() { return [{ id: 'desktop-app', name: 'Desktop App' }]; },
    discoveryDiagnostics() { return { 'chatgpt-desktop': { available: true } }; },
    async getAppTarget(id) { return id === target.id ? target : null; },
    getAppTargetStatus() { return { phase: 'idle' }; },
    async captureAppLatest() { return { text: 'captured app reply', target }; },
    async sendAppPrompt({ requestId, emit }) {
      for (const payload of [
        { type: 'prompt_accepted', requestId },
        { type: 'response_partial', requestId, text: 'app par' },
        { type: 'response_final', requestId, text: 'app final' }
      ]) emit(payload);
      return { text: 'app final' };
    },
    stopAppTargets() {}
  };
  const controller = createAppTargetServerController({
    appTargets,
    safeSend(peer, payload) {
      messages.push({ peer, payload });
      return true;
    },
    uiSockets: new Set([ws]),
    getDurability: () => durability
  });
  return { controller, appTargets, durability, target, ws, messages, observed };
}

test('App-Origin discovery and selection stay independent from browser tabs', async () => {
  const h = harness();
  await h.controller.refresh(h.ws, { force: true });
  assert.equal(h.messages.at(-1).payload.type, 'app_targets_update');
  assert.equal(h.messages.at(-1).payload.targets[0].providerId, 'chatgpt-desktop');

  await h.controller.handle(h.ws, { type: 'select_app_target', targetId: h.target.id });
  assert.equal(h.ws.appTargetId, h.target.id);
  assert.equal(h.messages.at(-1).payload.type, 'app_target_selected');
});

test('Base Mode App-Origin send flows through durability and returns app response events', async () => {
  const h = harness();
  h.ws.appTargetId = h.target.id;
  const handled = await h.controller.handle(h.ws, {
    type: 'send_prompt',
    requestId: 'app-send-1',
    text: 'hello native app',
    targetClassId: 'app-origin',
    targetId: h.target.id
  });
  assert.equal(handled, true);
  assert.equal(h.observed[0].kind, 'before');
  assert.equal(h.observed[0].meta.targetClassId, 'app-origin');
  assert.ok(h.observed.some((entry) => entry.type === 'prompt_accepted'));
  assert.ok(h.observed.some((entry) => entry.type === 'response_final'));
  assert.ok(h.messages.some((entry) =>
    entry.payload.type === 'response_final' && entry.payload.text === 'app final'));
});

test('Base Mode can capture the latest native app reply', async () => {
  const h = harness();
  h.ws.appTargetId = h.target.id;
  await h.controller.handle(h.ws, {
    type: 'capture_latest',
    requestId: 'capture-app-1',
    targetClassId: 'app-origin',
    targetId: h.target.id
  });
  const capture = h.messages.find((entry) => entry.payload.type === 'capture_result');
  assert.equal(capture.payload.text, 'captured app reply');
  assert.equal(capture.payload.providerName, 'ChatGPT App');
});

test('Dex transport cannot silently use unqualified App-Origin targets yet', async () => {
  const h = harness();
  const dex = { clientKind: 'dex', appTargetId: h.target.id };
  await h.controller.handle(dex, {
    type: 'send_prompt',
    requestId: 'dex-app-1',
    text: 'no',
    targetClassId: 'app-origin',
    targetId: h.target.id
  });
  const error = h.messages.find((entry) => entry.peer === dex && entry.payload.type === 'error');
  assert.equal(error.payload.code, 'APP_ORIGIN_BASE_MODE_ONLY');
});
