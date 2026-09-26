'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const protocol = require('../public/dex-protocol');
const ui = require('../public/dex-provider-control');
const providerContent = require('../extension/content/dex-provider-control');
const routing = require('../dex/provider-control-routing');
const revision = require('../extension/content/provider-adapter-revision');

test('DONE-watch commands are shared by relay, UI, content, and localhost route', () => {
  const names = ['watch_done', 'unwatch_done'];
  for (const name of names) {
    assert.equal(protocol.PROVIDER_CONTROL_ACTIONS.has(name), true);
    assert.equal(ui.ACTIONS.has(name), true);
    assert.equal(providerContent.ACTIONS.has(name), true);
    assert.equal(ui.MUTATING_ACTIONS.has(name), true);
    assert.equal(routing.MUTATING_ACTIONS.has(name), true);
  }
  assert.equal(revision.ADAPTER_REVISION, 46);
});

test('browser loads DONE watch before provider-control and the runtime owns completion consumption', () => {
  const html = read('public/index.html');
  const helper = html.indexOf('/dex-done-watch.js');
  const controller = html.indexOf('/dex-provider-control.js');
  assert.ok(helper > 0 && controller > helper);
  const scheduler = read('dex/server-scheduler.js');
  assert.match(scheduler, /doneWatchApi\.consume\(room, \{ completedMemberId: member\.id, message, at: now\(\) \}\)/);
  assert.match(scheduler, /onTurnSettled\(\)/);
  const server = read('server.js');
  assert.match(server, /createDoneWatchDelivery/);
  assert.match(server, /doneWatchDelivery\.handleAck\(ws, msg\)/);
  assert.match(server, /doneWatchDelivery\.flush\(\)/);
  assert.match(server, /doneWatchControlSocket === ws/);
  assert.match(server, /doneWatchVersion === 1/);
  assert.match(read('extension/dex-provider-control-bridge.js'), /doneWatchVersion: 1/);
});

test('server-owned one-shot delivery cannot be reset by stale UI and does not count as a relay turn', () => {
  const merge = read('dex/server-state-merge.js');
  const delivery = read('dex/done-watch-delivery.js');
  const bridge = read('extension/dex-provider-control-bridge.js');
  assert.match(merge, /doneWatchRevision/);
  assert.match(merge, /doneWatchEvents/);
  assert.match(delivery, /sent-unconfirmed/);
  assert.match(delivery, /event\.delivery !== 'pending'/);
  assert.match(delivery, /busy/);
  assert.match(bridge, /type: 'dex_done_watch_ack'/);
  assert.match(bridge, /msg\.kind === 'heads-up' \? 'dex-heads-up' : 'dex-done-watch'/);
  assert.match(bridge, /delivery: \{ kind, eventId: msg\.eventId \}/);
  assert.match(read('extension/content/chatgpt.js'), /'dex-done-watch'/);
});

test('the relay prompt advertises whether its exact recipient has a DONE watcher', () => {
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const room = {
    id: 'room-1', name: 'Bridge',
    settings: { contextMessages: 8 }, messages: [],
    members: [
      { id: 'eve', name: 'Eve', binding: { targetClassId: 'online-origin', providerName: 'ChatGPT' } },
      { id: 'astro', name: 'Astro', binding: { targetClassId: 'local-origin', providerName: 'Antigravity CLI' } }
    ],
    doneWatches: [{ id: 'w', watcherMemberId: 'eve', targetMemberId: 'astro', expiresAt }]
  };
  const prompt = protocol.buildRelayPrompt({
    room, recipient: room.members[1],
    sourceMessage: { id: 'm1', senderKind: 'agent', senderId: 'eve', senderName: 'Eve', text: 'Complete the task' },
    requestId: 'turn-1'
  });
  assert.match(prompt, /Active one-shot DONE subscribers for your response: 1/);
  assert.match(prompt, /not another Dex relay turn/);
  assert.deepEqual(protocol.relayDisposition(protocol.parseAgentReply('Done. [[DEX:DONE]]'),
    'Astro', false, { active: true, remaining: 2 }),
    { action: 'stop', kind: 'done', reason: 'Astro marked the room complete' });
});
