const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const chatgpt = require('../extension/content/chatgpt.js');
const muse = require('../extension/content/muse.js');

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('relay finalization keeps fragment guards while shortening safe complete-answer waits', () => {
  assert.equal(chatgpt.RELIABLE_GENERATION_SETTLE_MS, 1500);
  assert.ok(chatgpt.STATUS_SIGNAL_SETTLE_MS <= 3000);
  assert.ok(chatgpt.NO_SIGNAL_SETTLE_MS <= 5000);
  assert.ok(chatgpt.INCOMPLETE_NO_SIGNAL_SETTLE_MS >= 60000);

  assert.ok(muse.RELIABLE_GENERATION_SETTLE_MS <= 1500);
  assert.ok(muse.COMPLETE_NO_SIGNAL_SETTLE_MS <= 5000);
  assert.ok(muse.NO_SIGNAL_SETTLE_MS >= muse.COMPLETE_NO_SIGNAL_SETTLE_MS);
  assert.equal(muse.looksCompleteAssistantText('Finished cleanly.'), true);
  assert.equal(muse.looksCompleteAssistantText('Progress (not final): still working.'), false);
});

test('provider final events expose adapter settle timing for diagnostics', () => {
  const chatgptSource = source('extension/content/chatgpt.js');
  const museSource = source('extension/content/muse.js');
  for (const value of [chatgptSource, museSource]) {
    assert.match(value, /observedAt/);
    assert.match(value, /adapterSettleMs/);
    assert.match(value, /stableForMs/);
  }
});

test('warm adapter readiness cache prevents duplicate full-stack verification within the TTL', () => {
  const worker = source('extension/service-worker.js');
  const ensureStart = worker.indexOf('async function ensureProviderAdapter');
  const ensureEnd = worker.indexOf('\n}', ensureStart);
  const ensureBody = worker.slice(ensureStart, ensureEnd + 2);
  assert.match(ensureBody, /if \(adapterReadiness\.fresh\(tabId, provider\.id\)\) return;/);
  assert.match(ensureBody, /await adapterFreshnessApi\.ensure\(tabId, provider, chrome\);/);
  assert.ok(
    ensureBody.indexOf('adapterReadiness.fresh') < ensureBody.indexOf('adapterFreshnessApi.ensure'),
    'readiness cache must short-circuit before another full adapter verification'
  );
});

test('Dex diagnostics report provider settle and cross-provider handoff timing', () => {
  const worker = source('extension/service-worker.js');
  const dex = source('public/dex-mode.js');
  const timing = source('public/dex-relay-timing.js');
  assert.match(worker, /prompt_accepted[^\n]+observedAt: Date\.now\(\)/);
  assert.match(dex, /relayTiming\.onFinal\(msg\)/);
  assert.match(dex, /relayTiming\.onAccepted\(msg\)/);
  assert.match(timing, /Relay timing:/);
  assert.match(timing, /adapterSettleMs/);
  assert.match(timing, /accepted in \$\{handoffMs\} ms/);
});
