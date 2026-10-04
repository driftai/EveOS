const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const recovery = require('../extension/chatgpt-navigation-recovery.js');

test('ChatGPT navigation recovery only arms from a fresh root conversation', () => {
  assert.equal(recovery.isFreshChatGptUrl('https://chatgpt.com/'), true);
  assert.equal(recovery.isFreshChatGptUrl('https://chatgpt.com/c/abc'), false);
  assert.equal(recovery.isConversationUrl('https://chatgpt.com/c/abc'), true);
  assert.equal(recovery.isConversationUrl('https://chatgpt.com/'), false);
});

test('ChatGPT navigation recovery waits for complete-looking no-signal text before finalizing', async () => {
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const originalNow = Date.now;
  let intervalFn = null;
  let now = 1000;
  let capture = { ok: true, text: 'SOAK', isGenerating: false, generationState: 'idle', completenessHint: 'unknown' };
  global.setInterval = (fn) => { intervalFn = fn; return 1; };
  global.clearInterval = () => {};
  Date.now = () => now;

  const sent = [];
  const completed = new Set();
  const chromeApi = {
    tabs: {
      async get() { return { id: 42, url: 'https://chatgpt.com/c/abc' }; },
      async sendMessage() { return capture; }
    }
  };

  try {
    assert.equal(recovery.start({
      requestId: 'req-1',
      tabId: 42,
      initialUrl: 'https://chatgpt.com/',
      chromeApi,
      send(payload) { sent.push(payload); return true; },
      completed: (id) => completed.has(id),
      rememberCompleted: (id) => completed.add(id)
    }), true);

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 0);

    now += recovery.COMPLETE_NO_SIGNAL_SETTLE_MS + 10;
    await intervalFn();
    assert.equal(sent.length, 0, 'incomplete no-signal text must not finalize on the short settle window');

    capture = { ok: true, text: 'SOAK_PRIME_ACK_x.', isGenerating: false, generationState: 'idle', completenessHint: 'complete' };
    now += 10;
    await intervalFn();
    assert.equal(sent.length, 0);

    now += recovery.COMPLETE_NO_SIGNAL_SETTLE_MS + 10;
    await intervalFn();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'response_final');
    assert.equal(sent[0].requestId, 'req-1');
    assert.equal(sent[0].text, 'SOAK_PRIME_ACK_x.');
    assert.equal(sent[0].detail.navigationCaptureRecovery, true);
    assert.equal(sent[0].detail.completenessHint, 'complete');
    assert.equal(completed.has('req-1'), true);

    now += recovery.COMPLETE_NO_SIGNAL_SETTLE_MS + 10;
    if (intervalFn) await intervalFn();
    assert.equal(sent.length, 1);
  } finally {
    recovery.clear();
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    Date.now = originalNow;
  }
});

test('service worker arms and cancels ChatGPT navigation recovery around normal sends', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../extension/service-worker.js'), 'utf8');
  const entry = fs.readFileSync(path.resolve(__dirname, '../extension/service-worker-entry.js'), 'utf8');
  const returnRouting = fs.readFileSync(path.resolve(__dirname, '../extension/provider-return-routing.js'), 'utf8');
  assert.match(entry, /importScripts\('chatgpt-navigation-recovery\.js'\)/);
  assert.match(source, /chatgptNavigationRecoveryApi\.start\(/);
  assert.match(source, /!qualificationClaim && provider\.id === 'chatgpt'/);
  assert.match(source, /stopNavigation: chatgptNavigationRecoveryApi\.stop/);
  assert.match(returnRouting, /stopNavigation\(message\.requestId\)/);
});
