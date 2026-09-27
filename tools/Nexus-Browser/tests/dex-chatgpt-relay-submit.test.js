'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const returnApi = require('../extension/content/chatgpt-return.js');
const chatSource = fs.readFileSync(path.join(__dirname, '../extension/content/chatgpt.js'), 'utf8');
const TURN = 'dex-turn-3da28dc8-2509-4751-b8c5-32b68d0dde8b';
function node(messageId, content) {
  const owner = { getAttribute: key => key === 'data-chatgpt-selection-message-id' ? messageId : null };
  return { content, closest: () => owner, getAttribute: () => null };
}
test('one split DIL assistant turn with a trailing CMD or RETURN finalizes as ONE response', () => {
  const previous = [node('prior', 'Earlier completed answer')], baseline = returnApi.baseline(previous);
  const newNodes = [node('fresh-turn', 'Dex relay received.'),
    node('fresh-turn', '[[DEX:CMD {"action":"status","room":"room-eve"}]]')];
  const answer = { assistantNodes: () => [...previous, ...newNodes],
    assistantText: value => value.content };
  assert.match(returnApi.freshReply(answer, baseline), /Dex relay received\./);
  assert.match(returnApi.freshReply(answer, baseline), /\[\[DEX:CMD/);
  newNodes[1].content = '[[DEX:RETURN:' + TURN + ']]';
  assert.equal(returnApi.exactReturn(returnApi.freshReply(answer, baseline), TURN), true);
});
test('freshReply rejects multiple assistant IDs and reflowed old IDs', () => {
  const prior = node('previous', 'Old answer');
  const before = returnApi.baseline([prior]);
  const assistantText = value => value.content;
  assert.equal(returnApi.freshReply({ assistantNodes: () => [
    prior, node('one', 'First turn'), node('two', 'Different turn')], assistantText }, before), '');
  assert.equal(returnApi.freshReply({ assistantNodes: () => [
    prior, node('previous', 'Reflowed old block')], assistantText }, before), '');
  assert.equal(returnApi.freshReply({ assistantNodes: () => [
    prior, node(null, 'Anonymous fragment'), node(null, 'Anonymous fragment')], assistantText }, before), '');
});
function headed({ hasSend = false, commitAfterClick = false, clearWithoutCommit = false } = {}) {
  let clock = 0, clicks = 0, enters = 0, confirmation = false;
  const waits = [], gestures = [], finishes = [], userNodes = [];
  const field = { tagName: 'TEXTAREA', value: 'Astro qualified relay payload', isConnected: true,
    closest: () => null, dispatchEvent() { enters++; } };
  const button = { isConnected: true, click() {
    clicks++;
    if (commitAfterClick) { confirmation = true; userNodes.push({ text: field.value }); field.value = ''; }
    else if (clearWithoutCommit) field.value = '';
  } };
  const input = {
    findComposer: () => field, composerText: c => c.value,
    composerContainsText: (c, payload) => c.value === payload,
    findSendControl: () => hasSend ? button : null,
    generationLooksActive: () => false,
    isDisabledControl: () => false, isUnsafeSendControl: () => false
  };
  const guard = {
    ready: async (_composer, _text, timeout) => { waits.push(timeout); return { composer: field, control: hasSend ? button : null }; },
    checkpoint() {}, gesture: (_id, kind) => gestures.push(kind),
    finish: (_id, success, reason) => finishes.push({ success, reason }),
    diagnostics: () => ({ last: null })
  };
  const context = {
    module: { exports: {} }, BrowserAiBridgeChatGptInput: input,
    BrowserAiBridgeChatGptDeliveryWatchdog: { createDeliveryWatchdog: () => guard },
    BrowserAiBridgeChatGptAnswer: {
      assistantNodes: () => [], userNodes: () => userNodes,
      getTurnAssistantText: () => '', getTurnUserText: (nodes, baseline) =>
        nodes.slice(baseline).map(n => n.text).join('\n'),
      normalizeText: value => String(value || '').replace(/\s+/g, ' ').trim(),
      responseTextForUserPrompt: () => ''
    },
    BrowserAiBridgeChatGptReturn: { baseline: () => ({ count: 0, refs: new Set(), ids: new Set() }) },
    BrowserAiBridgeChatGptPageState: {
      issueSnapshot: () => new Map(), transientStatusLine: () => false,
      substantiveAssistantText: value => String(value || ''),
      looksCompleteAssistantText: () => true, obviouslyPartialAssistantText: () => false,
      generationSettleMs: () => 1000
    },
    BrowserAiBridgeResponseDeadline: {
      DEFAULT_RESPONSE_DEADLINES: { idleTimeoutMs: 240000 },
      nextResponseDeadline: () => ({ action: 'wait', delayMs: 240000 }),
      minutes: count => count * 60000
    },
    Date: { now: () => clock += 1000 },
    document: { body: {} }, MutationObserver: class { observe() {} disconnect() {} },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: () => Promise.resolve({ ok: true }) } },
    setInterval: () => 1, clearInterval() {}, clearTimeout() {},
    setTimeout(fn, delay) {
      if (delay === 40) { Promise.resolve().then(fn); return 1; }
      return 1; // Do not start real watcher deadlines in this isolated test.
    }
  };
  vm.runInNewContext(chatSource, context);
  return { chat: context.module.exports, field, waits, gestures, finishes,
    get clicks() { return clicks; }, get enters() { return enters; },
    get confirmed() { return confirmation; } };
}
test('bare dex-turn prompt without delivery.kind refuses unreliable synthetic Enter before any gesture', async () => {
  const h = headed();
  await assert.rejects(h.chat.submitPrompt(TURN, h.field.value),
    /scoped Send button unavailable; preserving Dex draft/);
  assert.equal(h.waits[0], 30000, 'the bare Dex relay gets the same extended hydration window');
  assert.deepEqual(h.gestures, []);
  assert.equal(h.enters, 0);
  assert.equal(h.field.value, 'Astro qualified relay payload');
  assert.equal(h.finishes[0].success, false);
});
test('bare dex-turn requires the actual committed user turn after exactly one Send click', async () => {
  const h = headed({ hasSend: true, commitAfterClick: true });
  assert.equal(await h.chat.submitPrompt(TURN, h.field.value), 'click');
  assert.equal(h.waits[0], 30000);
  assert.equal(h.clicks, 1);
  assert.equal(h.enters, 0);
  assert.deepEqual(h.gestures, ['click']);
  assert.equal(h.finishes[0].success, true);
  h.chat.stopWatcher(TURN);
});
test('editor clearing alone does NOT acknowledge a Dex relay or trigger fallback Enter', async () => {
  const h = headed({ hasSend: true, clearWithoutCommit: true });
  await assert.rejects(h.chat.submitPrompt(TURN, h.field.value),
    /Send click unconfirmed; draft preserved; no automatic replay/);
  assert.equal(h.clicks, 1);
  assert.equal(h.enters, 0);
  assert.equal(h.finishes[0].success, false);
});
