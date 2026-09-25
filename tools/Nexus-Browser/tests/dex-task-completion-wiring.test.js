'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
test('completion API accepts only the owner-local credential from its exact existing target', () => {
  const server = read('server.js'), runtime = read('dex/server-task-completion.js');
  const cli = read('scripts/task-completion-runner.js');
  const auth = read('dex/task-completion-local-auth.js');
  assert.match(runtime, /localAuthMatches\(message\.auth, localSecret\)/);
  assert.match(runtime, /source\.targetId.*existing|target\.sessionOrigin === 'existing'/);
  assert.match(server, /ws\.clientKind === 'maintenance' && await taskCompletion\.handleCommand/);
  assert.match(cli, /auth = readLocalAuth\(\)/);
  assert.match(cli, /requestId: id, \.\.\.payload, auth/);
  assert.match(auth, /io\.openSync\(file, 'wx', 0o600\)/);
  assert.match(auth, /timingSafeEqual/);
  assert.doesNotMatch(read('extension/task-completion-bridge.js'), /local-api-credential/);
});
test('fsynced result is captured and claimed before one exact-tab notification', () => {
  const journal = read('dex/task-completion-journal.js');
  const delivery = read('dex/task-completion-delivery.js');
  const extension = read('extension/task-completion-bridge.js');
  const bridge = read('extension/dex-provider-control-bridge.js');
  assert.match(journal, /job\.state = 'ready'; job\.readyAt = stamp\(\); save\(\)/);
  assert.match(journal, /job\.state = 'sent-unconfirmed'; job\.claimedAt = stamp\(\); save\(\)/);
  assert.match(journal, /job\.state = 'outcome-unknown'/);
  assert.match(delivery, /if \(!journal\.claim\(job\.id\)\) continue/);
  assert.match(delivery, /String\(entry\.id\) === String\(job\.requesterTarget\.targetId\)/);
  assert.match(extension, /liveTab\?\.url !== source\.url/);
  assert.match(extension, /kind: 'dex-task-completion'/);
  assert.match(bridge, /taskCompletionBridge\?\.handle\(msg\)/);
});
test('new production and test modules obey 440-line changed-source headroom', () => {
  for (const name of [
    'dex/task-completion-local-auth.js',
    'dex/task-completion-journal.js',
    'dex/task-completion-delivery.js',
    'dex/server-task-completion.js',
    'scripts/task-completion-runner.js',
    'extension/task-completion-bridge.js',
    'dex/server-stream-nudge-auth.js'
  ]) {
    const lines = read(name).replace(/\r?\n$/, '').split(/\r?\n/).length;
    assert.ok(lines <= 440, name + ' grew past the 440-line soft cap: ' + lines);
  }
});
