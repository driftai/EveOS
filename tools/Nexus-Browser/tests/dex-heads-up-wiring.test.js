'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
test('HEADSUP requires an explicit DONE and only authorized target selection', () => {
  const protocol = read('public/dex-protocol.js');
  const scheduler = read('dex/server-scheduler.js');
  const watch = read('public/dex-done-watch.js');
  assert.match(protocol, /HEADSUP:/);
  assert.match(protocol, /headsUpInvalid/);
  assert.match(scheduler, /parsed\.headsUpTarget \|\| parsed\.headsUpInvalid/);
  assert.match(scheduler, /done: parsed\.done/);
  assert.match(watch, /DEX_HEADSUP_DONE_REQUIRED/);
  assert.match(watch, /DEX_HEADSUP_TARGET_AMBIGUOUS/);
  assert.match(watch, /DEX_HEADSUP_ONLINE_ONLY/);
  assert.match(watch, /HEADSUP_COOLDOWN_MS/);
});
test('both normal and capture-only recovered completions persist heads-ups with no new relay turn', () => {
  const scheduler = read('dex/server-scheduler.js');
  const recovery = read('dex/server-scheduler-recovery.js');
  assert.equal((scheduler.match(/doneWatchApi\.emitHeadsUp\(room/g) || []).length, 2);
  assert.match(recovery, /onRecovered\(\{ room, member, message, parsed \}\)/);
  assert.match(scheduler, /if \(disposition\.action === 'stop'\) setStopped\(room, disposition\.reason\)/);
  assert.match(scheduler, /save\(snapshot\);\s*processSoon\(0\)/);
  assert.match(read('dex/server-state-merge.js'), /lastHeadsUp: serverRoom\.lastHeadsUp/);
});
test('the existing one-shot notification transport recognizes only explicit out-of-band HEADSUP packets', () => {
  const delivery = read('dex/done-watch-delivery.js');
  const bridge = read('extension/dex-provider-control-bridge.js');
  const worker = read('extension/service-worker.js');
  const chat = read('extension/content/chatgpt.js');
  assert.match(delivery, /event\.kind === 'heads-up'/);
  assert.match(delivery, /kind: event\.kind \|\| 'done-watch'/);
  assert.match(bridge, /msg\.kind === 'heads-up' \? 'dex-heads-up' : 'dex-done-watch'/);
  assert.match(worker, /\^dex-\(\?:done-watch\|heads-up\)-/);
  assert.match(chat, /'dex-heads-up'/);
  assert.match(read('extension/content/chatgpt-return.js'), /HEADSUP:/);
  assert.match(read('extension/content/provider-adapter-revision.js'), /ADAPTER_REVISION = 37/);
});
test('heads-up is opt-in and documented as a single recipient ping, not a subscription or model loop', () => {
  const docs = read('DEX-MODE.md');
  assert.match(docs, /HEADSUP:Eve/);
  assert.match(docs, /not a Dex relay turn/i);
  assert.match(docs, /no automatic/i);
});
