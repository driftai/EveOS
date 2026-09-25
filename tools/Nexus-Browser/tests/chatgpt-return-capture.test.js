'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const returnApi = require('../extension/content/chatgpt-return');
const pageState = require('../extension/content/chatgpt-page-state');
const source = fs.readFileSync(path.resolve(__dirname, '../extension/content/chatgpt.js'), 'utf8');
const ID = 'dex-turn-9a8c763f-ec15-43b4-833d-da5aac447fb6';

function headed({ taggedId = ID, addNewTurn = true } = {}) {
  let now = 1000, tick, listener;
  const events = [];
  const old = { text: 'Old reply.', getAttribute: (name) =>
    name === 'data-chatgpt-selection-message-id' ? 'msg-old' : null };
  const fresh = { text: 'ASTRO_QUAL_ACK.\n[[DEX:RETURN:' + taggedId + ']]',
    getAttribute: (name) => name === 'data-chatgpt-selection-message-id' ? 'msg-new' : null };
  const nodes = [old];
  const answer = {
    assistantNodes: () => nodes,
    assistantText: (node) => node.text,
    latestAssistantText: () => nodes.at(-1).text,
    responseTextForUserPrompt: () => '', // the observed DIL user-node failure
    userNodes: () => [], normalizeText: String
  };
  const ctx = {
    module: { exports: {} }, BrowserAiBridgeChatGptInput: { generationLooksActive: () => false },
    BrowserAiBridgeChatGptAnswer: answer, BrowserAiBridgeChatGptReturn: returnApi,
    BrowserAiBridgeChatGptPageState: pageState,
    BrowserAiBridgeResponseDeadline: {
      DEFAULT_RESPONSE_DEADLINES: { idleTimeoutMs: 240000 },
      nextResponseDeadline: () => ({ action: 'wait', delayMs: 240000 }), minutes: () => 4
    },
    Date: { now: () => now },
    MutationObserver: class { observe() {} disconnect() {} },
    chrome: { runtime: {
      onMessage: { addListener(fn) { listener = fn; } },
      sendMessage(event) { events.push(event); return Promise.resolve({ ok: true, queued: true }); }
    } },
    document: { body: {} },
    setInterval(fn) { tick = fn; return 1; }, clearInterval() {},
    setTimeout() { return 1; }, clearTimeout() {}
  };
  vm.runInNewContext(source, ctx);
  const watcher = ctx.module.exports.watchResponse(ID, {
    count: 1, text: '', userCount: 0, prompt: 'Astro qualification report',
    assistantBaseline: returnApi.baseline(nodes)
  });
  watcher.promptCommitted = true;
  if (addNewTurn) nodes.push(fresh);
  return { ctx, events, nodes, answer, sample() { tick(); },
    advance(ms) { now += ms; }, capture(requestId) {
      let response = null;
      listener({ type: 'capture_latest', expectedPrompt: 'Astro qualification report',
        originalTurnRequestId: requestId }, null, (value) => { response = value; });
      return response;
    } };
}

test('RETURN finalizes the exact newly rendered DIL assistant turn without a discoverable user node', async () => {
  const h = headed();
  h.sample();
  h.advance(1600);
  h.sample();
  await Promise.resolve();
  const result = h.events.filter((event) => event.type === 'response_final');
  assert.equal(result.length, 1);
  assert.equal(result[0].requestId, ID);
  assert.equal(result[0].detail.returnRequested, true);
  assert.match(result[0].text, /ASTRO_QUAL_ACK/);
  assert.equal(h.ctx.BrowserAiBridgeChatGptRuntime.responsePending(), false);
  assert.match(h.capture(ID).text, /ASTRO_QUAL_ACK/);
  assert.equal(h.capture('dex-turn-wrong12345678').text, '');
});

test('wrong exact-turn return marker or unchanged historical reply never finalizes a new turn', () => {
  for (const h of [headed({ taggedId: 'dex-turn-wrong12345678' }), headed({ addNewTurn: false })]) {
    h.sample(); h.advance(10000); h.sample();
    assert.equal(h.events.some((event) => event.type === 'response_final'), false);
  }
});
