const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { server, HOST } = require('../server');

function waitMessage(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for message after ${timeoutMs}ms`));
    }, timeoutMs);

    function onMessage(raw) {
      let message;
      try { message = JSON.parse(String(raw)); }
      catch { return; }
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    }

    function cleanup() {
      clearTimeout(timer);
      ws.off('message', onMessage);
    }

    ws.on('message', onMessage);
  });
}

test('UI handshake advertises Online, Local and App-Origin without waiting for native discovery', async () => {
  await new Promise((resolve) => server.listen(0, HOST, resolve));
  const port = server.address().port;
  const ws = new WebSocket(`ws://${HOST}:${port}/ws`);

  try {
    await new Promise((resolve) => ws.once('open', resolve));
    const classesPromise = waitMessage(ws, (message) => message.type === 'target_classes_update');
    const localTargetsPromise = waitMessage(ws, (message) => message.type === 'local_targets_update');
    const appTargetsPromise = waitMessage(ws, (message) => message.type === 'app_targets_update', 1500);
    ws.send(JSON.stringify({ type: 'hello', role: 'ui' }));

    const classes = await classesPromise;
    assert.deepEqual(classes.classes.map((entry) => entry.id), ['online-origin', 'local-origin', 'app-origin']);
    assert.deepEqual(classes.localTargetTypes.map((entry) => entry.id), ['terminal-agent']);
    assert.deepEqual(classes.appTargetTypes.map((entry) => entry.id), ['desktop-app']);

    const localTargets = await localTargetsPromise;
    assert.ok(Array.isArray(localTargets.targets));
    assert.ok('target' in localTargets);

    const appTargets = await appTargetsPromise;
    assert.ok(Array.isArray(appTargets.targets));
    assert.deepEqual(appTargets.types.map((entry) => entry.id), ['desktop-app']);
    assert.ok('diagnostics' in appTargets);
    assert.equal(appTargets.refreshing, true);
  } finally {
    ws.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
