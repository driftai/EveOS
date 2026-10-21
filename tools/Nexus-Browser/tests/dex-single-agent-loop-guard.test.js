'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../public/dex-protocol');

test('one unmarked single-agent response safe-stops without claiming DONE', () => {
  const parsed = protocol.parseAgentReply('I am ready to proceed.');
  const result = protocol.relayDisposition(parsed, 'TLO', false,
    { active: true, remaining: 7, singleAgentIdle: true });
  assert.deepEqual(result, { action: 'stop', kind: 'single-agent',
    reason: 'TLO completed one readiness-only turn · awaiting new input or an authenticated tool result' });
  assert.equal(parsed.done, false);
});

test('explicit control semantics outrank the single-agent guard', () => {
  const command = protocol.parseAgentReply('Checking. [[DEX:CMD {"action":"status"}]]');
  assert.equal(protocol.relayDisposition(command, 'TLO', false,
    { active: true, remaining: 7, singleAgentIdle: true }).kind, 'control');
  const user = protocol.parseAgentReply('Need approval. [[DEX:USER]]');
  assert.equal(protocol.relayDisposition(user, 'TLO', false,
    { active: true, remaining: 7, singleAgentIdle: true }).kind, 'user');
  const done = protocol.parseAgentReply('Verified. [[DEX:DONE]]');
  assert.equal(protocol.relayDisposition(done, 'TLO', false,
    { active: true, remaining: 7, singleAgentIdle: true }).kind, 'done');
});
