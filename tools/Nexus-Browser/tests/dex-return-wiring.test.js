'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('RETURN helper is loaded in both headed and dynamically injected ChatGPT adapters', () => {
  const manifest = JSON.parse(read('extension/manifest.json'));
  const scripts = manifest.content_scripts.find((item) => item.matches.includes('https://chatgpt.com/*')).js;
  const dynamic = require('../extension/providers').getProvider('chatgpt').contentScripts;
  for (const files of [scripts, dynamic]) {
    assert.ok(files.indexOf('content/chatgpt-return.js') > files.indexOf('content/chatgpt-answer.js'));
    assert.ok(files.indexOf('content/chatgpt-return.js') < files.indexOf('content/chatgpt.js'));
  }
  assert.match(read('extension/content/provider-adapter-revision.js'), /ADAPTER_REVISION = 39/);
});

test('returned final text is durably queued before delivery and only acknowledged after localhost commit', () => {
  const entry = read('extension/service-worker-entry.js');
  const worker = read('extension/service-worker.js');
  const server = read('server.js');
  const scheduler = read('dex/server-scheduler.js');
  const recovery = read('dex/server-scheduler-recovery.js');
  assert.match(entry, /importScripts\('dex-final-receipt\.js'\)/);
  assert.match(entry, /importScripts\('dex-final-delivery-wiring\.js'\)/);
  assert.match(worker, /finalDelivery\.onFinal\(msg, sender, sendResponse, provider\)/);
  assert.match(worker, /finalDelivery\.onReceipt\(msg\)/);
  assert.match(server, /finalState\.findFinalReceipt\(dexStateStore\.load\(\), msg\.requestId\)/);
  assert.match(server, /type: 'dex_turn_receipt'/);
  assert.match(scheduler, /rememberFinalReceipt\(room, current\.requestId, message\.id/);
  assert.match(recovery, /rememberFinalReceipt\(room, recovery\.requestId, message\.id/);
  assert.match(recovery, /originalTurnRequestId: recovery\.requestId/);
  assert.match(worker, /originalTurnRequestId: msg\.originalTurnRequestId/);
});

test('first-party source headroom and non-replay invariants remain intact', () => {
  for (const file of ['server.js', 'dex/server-scheduler.js', 'dex/server-scheduler-recovery.js',
    'extension/service-worker.js', 'extension/content/chatgpt.js', 'public/dex-protocol.js']) {
    const count = read(file).split(/\r?\n/).length;
    assert.ok(count <= 440, file + ' exceeded growth guard: ' + count);
  }
  const outbox = read('extension/dex-final-receipt.js');
  assert.doesNotMatch(outbox, /type:\s*'send_prompt'/);
  assert.match(outbox, /type !== 'response_final'/);
});
