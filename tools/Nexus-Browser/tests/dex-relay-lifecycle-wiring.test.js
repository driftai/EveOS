'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('ChatGPT tool status heartbeats are scoped to the exact active prompt', () => {
  const chat = read('extension/content/chatgpt.js');
  const page = read('extension/content/chatgpt-page-state.js');
  const content = read('extension/content/dex-provider-control.js');
  assert.match(chat, /answer\.responseTextForUserPrompt\(watcher\.prompt, watcher\.userBaselineCount\)/);
  assert.match(chat, /reportGenerationActivity\(watcher, requestId, reportedGenerating \|\| transientOnly\)/);
  assert.match(page, /function transientStatusLine\(value\)/);
  assert.match(chat, /responsePending: \(\) => active\.size > 0/);
  assert.match(content, /BrowserAiBridgeChatGptRuntime\?\.responsePending\?\.\(\)/);
  assert.match(read('extension/content/provider-adapter-revision.js'), /ADAPTER_REVISION = 35/);
});

test('recovered DONE notifications are committed before dispatch is resumed', () => {
  const scheduler = read('dex/server-scheduler.js');
  const recovery = read('dex/server-scheduler-recovery.js');
  assert.match(scheduler, /onRecovered: \(\{ room, member, message, parsed \}\) =>/);
  assert.match(scheduler, /if \(parsed\.done\) doneWatchApi\.consume\(room/);
  assert.match(recovery, /onRecovered\(\{ room, member, message, parsed \}\)/);
  assert.match(recovery, /save\(snapshot\);\s*processSoon\(0\);\s*try \{ onTurnSettled\(\); \}/);
  assert.match(read('dex/provider-control-receipt.js'), /room\?\.recovery\?\.passiveAt/);
});

test('scheduler fast path, size headroom and absolute lease are preserved', () => {
  const scheduler = read('dex/server-scheduler.js');
  assert.match(scheduler, /save\(snapshot\);\s*processSoon\(0\);\s*try \{ onTurnSettled\(\); \}/);
  for (const filename of [
    'dex/server-scheduler.js', 'dex/server-scheduler-recovery.js',
    'extension/content/chatgpt.js', 'public/dex-provider-control.js'
  ]) {
    const lines = read(filename).replace(/\r?\n$/, '').split(/\r?\n/).length;
    assert.ok(lines <= 440, filename + ' grew past the headroom guard: ' + lines);
  }
  assert.match(read('dex/server-turn-lease.js'), /TURN_ABSOLUTE_TIMEOUT_MS = 30 \* 60 \* 1000/);
});
