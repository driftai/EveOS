'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const returnApi = require('../extension/content/chatgpt-return.js');
const manualCommitApi = require('../extension/content/chatgpt-manual-commit.js');
const chatgptAnswer = require('../extension/content/chatgpt-answer.js');
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
function headed({ hasSend = false, commitAfterClick = false, clearWithoutCommit = false,
  readyTimeout = false, prompt = 'Astro qualified relay payload', renderedPrompt = null } = {}) {
  let clock = 0, clicks = 0, enters = 0, confirmation = false;
  const waits = [], gestures = [], finishes = [], userNodes = [], intervals = [], timeouts = [], emits = [];
  const field = { tagName: 'TEXTAREA', value: prompt, isConnected: true,
    closest: () => null, dispatchEvent() { enters++; } };
  const button = { isConnected: true, click() {
    clicks++;
    if (commitAfterClick) { confirmation = true; userNodes.push({ text: renderedPrompt || field.value }); field.value = ''; }
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
    ready: async (_composer, _text, timeout) => { waits.push(timeout); return { composer: field, control: hasSend ? button : null, timedOut: readyTimeout }; },
    checkpoint() {}, gesture: (_id, kind) => gestures.push(kind),
    finish: (_id, success, reason) => finishes.push({ success, reason }),
    diagnostics: () => ({ last: null })
  };
  const context = {
    module: { exports: {} }, BrowserAiBridgeChatGptInput: input,
    BrowserAiBridgeChatGptManualCommit: manualCommitApi,
    BrowserAiBridgeChatGptDeliveryWatchdog: { createDeliveryWatchdog: () => guard },
    BrowserAiBridgeChatGptAnswer: {
      assistantNodes: () => [], userNodes: () => userNodes,
      getTurnAssistantText: () => '', getTurnUserText: (nodes, baseline) =>
        nodes.slice(baseline).map(n => n.text).join('\n'),
      normalizeText: value => String(value || '').replace(/\s+/g, ' ').trim(),
      promptMatchesUserText: chatgptAnswer.promptMatchesUserText,
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
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: (m) => { emits.push(m); return Promise.resolve({ ok: true }); } } },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, clearInterval() {}, clearTimeout() {},
    setTimeout(fn, delay) {
      if (delay === 40) { Promise.resolve().then(fn); return 1; }
      timeouts.push({ fn, delay }); return 1; // Do not start real watcher deadlines in this isolated test.
    }
  };
  vm.runInNewContext(chatSource, context);
  return { chat: context.module.exports, field, waits, gestures, finishes, intervals, timeouts, emits, userNodes,
    pending: () => context.BrowserAiBridgeChatGptRuntime.responsePending(),
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
test('a Dex pre-gesture readiness timeout cannot click a stale Send control', async () => {
  const h = headed({ hasSend: true, readyTimeout: true });
  await assert.rejects(h.chat.submitPrompt(TURN, h.field.value),
    /pre-gesture readiness timed out; draft preserved; no submission attempted/);
  assert.equal(h.waits[0], 30000);
  assert.equal(h.clicks, 0);
  assert.equal(h.enters, 0);
  assert.deepEqual(h.gestures, []);
  assert.equal(h.field.value, 'Astro qualified relay payload');
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
test('Dex control result confirms one click from exact request ID after rendered text normalization', async () => {
  const id = 'provider-control-ca441440-0fa2-4ea1-8c50-9a86bf8dc1b6';
  const prompt = `[DEX TOOL RESULT]\nOK: Current durable relay budget and room state.\nControl request: ${id}\nDelivery: Control result committed by Dex.\nData: {"configuredTurns":1}`;
  const renderedPrompt = `[DEX TOOL RESULT]\nOK: Current durable relay budget and room state.\nControl request: ${id}\nDelivery: Control result committed by Dex.`;
  const h = headed({ hasSend: true, commitAfterClick: true, prompt, renderedPrompt });
  assert.equal(await h.chat.submitPrompt(`dex-control-result-${id}`, prompt,
    { delivery: { kind: 'dex-control-result' } }), 'click');
  assert.equal(h.clicks, 1);
  assert.equal(h.enters, 0);
  assert.deepEqual(h.gestures, ['click']);
});
test('editor clearing alone does NOT acknowledge a Dex relay or trigger fallback Enter', async () => {
  const h = headed({ hasSend: true, clearWithoutCommit: true });
  await assert.rejects(h.chat.submitPrompt(TURN, h.field.value),
    /Send click unconfirmed; draft preserved; no automatic replay/);
  assert.equal(h.clicks, 1);
  assert.equal(h.enters, 0);
  assert.equal(h.finishes[0].success, false);
});

test('manual-commit timer functions preserve their browser host receiver', () => {
  const requestId = 'dex-turn-timer-receiver';
  const watcher = {}, active = new Map([[requestId, watcher]]), calls = [];
  const timers = {
    setInterval: function (_fn, ms) { assert.equal(this, globalThis); calls.push(['setInterval', ms]); return 17; },
    clearInterval: function (id) { assert.equal(this, globalThis); calls.push(['clearInterval', id]); },
    setTimeout: function (_fn, ms) { assert.equal(this, globalThis); calls.push(['setTimeout', ms]); return 23; },
    clearTimeout: function (id) { assert.equal(this, globalThis); calls.push(['clearTimeout', id]); }
  };
  const manual = manualCommitApi.create({ active, stopWatcher() {}, emit() {}, timers });
  assert.equal(manual.arm(requestId, () => false), true);
  manual.release(watcher);
  assert.deepEqual(calls, [
    ['setInterval', manualCommitApi.POLL_MS],
    ['setTimeout', manualCommitApi.MANUAL_COMMIT_WINDOW_MS],
    ['clearInterval', 17],
    ['clearTimeout', 23]
  ]);
});

test('unconfirmed Dex click keeps the watcher for a later manual Enter without a second gesture', async () => {
  const h = headed({ hasSend: true });
  const error = await h.chat.submitPrompt(TURN, h.field.value).catch((e) => e);
  assert.match(error.message, /Send click unconfirmed; draft preserved; no automatic replay/);
  assert.equal(error.awaitingManualCommit, true);
  assert.equal(error.sendDiagnostics.controlConnected, true);
  assert.equal(error.sendDiagnostics.controlDisabled, false);
  assert.equal(error.sendDiagnostics.composerTextLength, h.field.value.length);
  const poll = h.intervals.find((entry) => entry.ms === 500);
  assert.ok(poll, 'manual-commit poll armed');
  assert.ok(h.timeouts.some((entry) => entry.delay === 5 * 60 * 1000), 'bounded five-minute manual window');
  poll.fn();
  assert.equal(h.emits.some((m) => m.submissionMode === 'manual'), false, 'no acceptance before the user turn exists');
  h.userNodes.push({ text: h.field.value }); // Drift presses Enter by hand.
  poll.fn();
  const accepted = h.emits.find((m) => m.submissionMode === 'manual');
  assert.equal(accepted?.requestId, TURN);
  assert.equal(h.clicks, 1, 'never a second click');
  assert.equal(h.enters, 0, 'never a synthetic Enter');
  h.chat.stopWatcher(TURN);
});
test('manual-commit window expiry releases the watcher', async () => {
  const h = headed({ hasSend: true });
  await h.chat.submitPrompt(TURN, h.field.value).catch(() => {});
  const expiry = h.timeouts.find((entry) => entry.delay === 5 * 60 * 1000);
  assert.ok(expiry, 'manual window armed');
  assert.equal(h.pending(), true, 'watcher still held inside the window');
  expiry.fn();
  assert.equal(h.pending(), false, 'watcher released after the window');
});
test('pre-gesture failures still stop the watcher immediately', async () => {
  const h = headed({ hasSend: true, readyTimeout: true });
  const error = await h.chat.submitPrompt(TURN, h.field.value).catch((e) => e);
  assert.notEqual(error.awaitingManualCommit, true);
  assert.equal(h.intervals.some((entry) => entry.ms === 500), false);
});
