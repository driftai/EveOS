'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createDeliveryWatchdog } = require('../extension/content/chatgpt-delivery-watchdog.js');

function rig({ initial = '', available = false, generatingUntil = 0,
  mutateOnWait = null, buttonAfterSeeds = Infinity } = {}) {
  let time = 0, draft = initial, seeds = 0;
  const composer = { tagName: 'TEXTAREA', closest: () => null }, send = { click() {} };
  const input = {
    findComposer: () => composer,
    composerText: () => draft,
    composerContainsText: (_element, text) => draft === text,
    setComposerText: (_element, text) => { draft = text; seeds++; },
    findSendControl: () => available || seeds >= buttonAfterSeeds ? send : null,
    generationLooksActive: () => time < generatingUntil
  };
  const guard = createDeliveryWatchdog({ input, now: () => time,
    wait: async (ms) => { time += ms; mutateOnWait?.({ time, setDraft: (value) => { draft = value; } }); },
    pollMs: 120, staleAfterMs: 240, maxReseeds: 2 });
  return { guard, composer, send, get draft() { return draft; }, get seeds() { return seeds; } };
}
test('stalled exact Dex draft is reseeded safely before gesture, then scoped Send appears', async () => {
  const h = rig({ buttonAfterSeeds: 2 });
  const ready = await h.guard.ready(h.composer, 'Dex payload', 1000, 'r-safe');
  assert.equal(ready.control, h.send);
  assert.equal(h.seeds, 2);
  assert.equal(h.guard.diagnostics().safeReseeds, 1);
  assert.equal(h.guard.diagnostics().staleDrafts, 1);
  assert.equal(h.guard.diagnostics().pending[0].gesture, null);
});
test('active ChatGPT generation defers delivery without clicking or reseeding', async () => {
  const h = rig({ available: true, generatingUntil: 360 });
  const ready = await h.guard.ready(h.composer, 'Dex payload', 1000, 'r-generation');
  assert.equal(ready.control, h.send);
  assert.equal(h.seeds, 1);
  assert.equal(h.guard.diagnostics().pending[0].gesture, null);
});
test('a changed or foreign draft is preserved instead of overwritten', async () => {
  const h = rig({ initial: 'Dex payload',
    mutateOnWait: ({ setDraft }) => setDraft('Human draft') });
  await assert.rejects(h.guard.ready(h.composer, 'Dex payload', 1000, 'r-foreign'),
    /different draft/);
  assert.equal(h.draft, 'Human draft');
  assert.equal(h.seeds, 0);
  assert.equal(h.guard.diagnostics().foreignDrafts, 1);
});
test('an uncertain Send click is terminal for this request, not an automatic retry', async () => {
  const h = rig({ available: true });
  await h.guard.ready(h.composer, 'Dex payload', 1000, 'r-uncertain');
  h.guard.gesture('r-uncertain', 'click');
  h.guard.finish('r-uncertain', false, 'click-unconfirmed');
  await assert.rejects(h.guard.ready(h.composer, 'Dex payload', 1000, 'r-uncertain'),
    /never replay/);
  assert.equal(h.guard.diagnostics().uncertain, 1);
  assert.equal(h.guard.diagnostics().terminalCount, 1);
});
test('committed user turn cancels pre-gesture resend and rejects duplicate request', async () => {
  const h = rig();
  const result = await h.guard.ready(h.composer, 'Dex payload', 1000,
    'r-already', () => true);
  assert.equal(result.committed, true);
  assert.equal(h.seeds, 0);
  await assert.rejects(h.guard.ready(h.composer, 'Dex payload', 1000, 'r-already'),
    /never replay/);
});
test('exhausted preflight reports blockage and keeps exact draft without a gesture', async () => {
  const h = rig({ buttonAfterSeeds: Infinity });
  const result = await h.guard.ready(h.composer, 'Dex payload', 480, 'r-blocked');
  assert.equal(result.timedOut, true);
  assert.equal(h.draft, 'Dex payload');
  assert.equal(h.guard.diagnostics().blocked, 1);
  assert.equal(h.guard.diagnostics().last.reason, 'pre-gesture-timeout');
  assert.equal(h.guard.diagnostics().last.gesture, null);
});
test('extension registers watchdog before ChatGPT adapter in both script paths', () => {
  const root = path.join(__dirname, '..'), read = (file) =>
    fs.readFileSync(path.join(root, file), 'utf8');
  const manifest = JSON.parse(read('extension/manifest.json'));
  const files = manifest.content_scripts.find((g) => g.matches.includes('https://chatgpt.com/*')).js;
  const dynamic = require('../extension/providers.js').getProvider('chatgpt').contentScripts;
  for (const group of [files, dynamic]) {
    assert.ok(group.indexOf('content/chatgpt-delivery-watchdog.js') >
      group.indexOf('content/chatgpt-input.js'));
    assert.ok(group.indexOf('content/chatgpt-delivery-watchdog.js') <
      group.indexOf('content/chatgpt.js'));
  }
  const adapter = read('extension/content/chatgpt.js');
  assert.match(adapter, /deliveryGuard\.gesture\(requestId, kind\)/);
  assert.match(adapter, /deliveryGuard\.finish\(requestId, false/);
  assert.match(adapter, /30000 : 5000/);
});
