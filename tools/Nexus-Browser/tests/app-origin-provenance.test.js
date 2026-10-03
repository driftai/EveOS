const test = require('node:test');
const assert = require('node:assert/strict');

const { createAppTargetServerController } = require('../app-targets/server-controller');

function provenanceHarness() {
  const target = {
    id: 'app-chatgpt-windows',
    title: 'ChatGPT',
    providerId: 'chatgpt-desktop',
    providerName: 'ChatGPT App',
    targetClassId: 'app-origin',
    targetTypeId: 'desktop-app'
  };
  const ws = { clientKind: 'browser', appTargetId: target.id, closed: false };
  const uiSockets = new Set([ws]);
  const messages = [];
  const acked = [];
  let passiveOptions = null;

  const passiveWatcher = {
    watch() { return true; },
    unwatch() { return true; },
    async ack(payload) { acked.push(payload); return true; },
    diagnostics() { return {}; },
    stop() {}
  };

  const appTargets = {
    async listAppTargets() { return [target]; },
    publicAppTargetTypes() { return [{ id: 'desktop-app', name: 'Desktop App' }]; },
    discoveryDiagnostics() { return { 'chatgpt-desktop': { available: true } }; },
    async getAppTarget(id) { return id === target.id ? target : null; },
    getAppTargetStatus() { return { phase: 'idle' }; },
    async sendAppPrompt({ requestId, emit, beforeSend }) {
      await beforeSend?.(target);
      emit({ type: 'prompt_accepted', requestId });
      emit({ type: 'response_final', requestId, text: 'nexus scoped reply' });
      return { text: 'nexus scoped reply' };
    },
    stopAppTargets() {}
  };

  const durability = {
    async beforeDispatch() { return { ok: true }; },
    async observe() {},
    async markFailed() {}
  };

  const controller = createAppTargetServerController({
    appTargets,
    uiSockets,
    getDurability: () => durability,
    safeSend(peer, payload) {
      if (peer?.closed) return false;
      messages.push({ peer, payload });
      return true;
    },
    passiveWatcherFactory(options) {
      passiveOptions = options;
      return passiveWatcher;
    },
    terminalRelayStorage: {
      readTargetSelection() { return { available: false }; },
      writeTargetSelection() {},
      clearTargetSelection() {},
      refreshTargetSelection() {}
    }
  });

  return { target, ws, messages, acked, controller, passive: () => passiveOptions };
}

test('app-local passive turns are consumed without entering the Nexus transcript', async () => {
  const h = provenanceHarness();
  const payload = {
    type: 'native_app_turn',
    targetId: h.target.id,
    providerId: h.target.providerId,
    fingerprint: 'app-local-turn-1',
    text: 'typed directly in the ChatGPT app'
  };

  const consumed = h.passive().emit(payload);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(consumed, 1, 'the passive ledger should treat the app-local turn as consumed');
  assert.deepEqual(h.acked, [{ targetId: h.target.id, fingerprint: payload.fingerprint }]);
  assert.equal(h.messages.some((entry) => entry.payload.type === 'native_app_turn'), false,
    'passive app-local observation must never be broadcast into Nexus');
});

test('Nexus-origin App-Origin replies still return exactly once through the request-scoped path', async () => {
  const h = provenanceHarness();

  const handled = await h.controller.handle(h.ws, {
    type: 'send_prompt',
    requestId: 'nexus-origin-1',
    text: 'sent from Nexus',
    targetClassId: 'app-origin',
    targetId: h.target.id
  });

  assert.equal(handled, true);
  const finals = h.messages.filter((entry) =>
    entry.payload.type === 'response_final' && entry.payload.requestId === 'nexus-origin-1');
  assert.equal(finals.length, 1);
  assert.equal(finals[0].payload.text, 'nexus scoped reply');
});
