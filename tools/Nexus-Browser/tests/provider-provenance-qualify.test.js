'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  chooseTarget,
  addOnlineAgentCommand,
  parseArgs
} = require('../scripts/provider-provenance-qualify');

test('provider qualifier pins the requested real ChatGPT Online-Origin target', () => {
  const targets = [
    { id: 11, providerId: 'chatgpt' },
    { id: 22, providerId: 'chatgpt' },
    { id: 33, providerId: 'hark' }
  ];
  assert.deepEqual(chooseTarget(targets, 'chatgpt', '22'), targets[1]);
  assert.equal(chooseTarget(targets, 'chatgpt', '33'), null);
});

test('provider qualifier attaches an existing Online-Origin parent instead of locally spawning it', () => {
  const command = addOnlineAgentCommand(
    'room-proof',
    { id: 116817255, providerId: 'chatgpt' },
    'chatgpt',
    'Eve-Main-Agent-Qualification'
  );
  assert.deepEqual(command, {
    action: 'add_agent',
    room: 'room-proof',
    targetClassId: 'online-origin',
    targetId: 116817255,
    providerId: 'chatgpt',
    name: 'Eve-Main-Agent-Qualification'
  });
  assert.notEqual(command.action, 'spawn_agent');
});

test('provider qualifier accepts explicit ChatGPT and Hark target pins', () => {
  const options = parseArgs([
    '--source-target-id', 'local-2',
    '--chatgpt-tab-id', '116817255',
    '--hark-tab-id', '116817427',
    '--timeout-ms', '240000'
  ]);
  assert.equal(options.sourceTargetId, 'local-2');
  assert.equal(options.chatgptTabId, '116817255');
  assert.equal(options.harkTabId, '116817427');
  assert.equal(options.timeoutMs, 240000);
  assert.equal(options.skipQuorum, false);
});
