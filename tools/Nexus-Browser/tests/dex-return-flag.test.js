'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../public/dex-protocol');
const returns = require('../extension/content/chatgpt-return');
const ID = 'dex-turn-9a8c763f-ec15-43b4-833d-da5aac447fb6';

test('exact trailing RETURN is transport-only and does not stop a two-agent relay', () => {
  const parsed = protocol.parseAgentReply('ACK received.\n[[DEX:RETURN:' + ID + ']]');
  assert.equal(parsed.returnRequestId, ID);
  assert.equal(parsed.text, 'ACK received.');
  assert.equal(parsed.done, false);
  assert.equal(protocol.relayDisposition(parsed, 'Eve', false,
    { active: true, remaining: 1 }).action, 'continue');
  assert.equal(returns.exactReturn('ACK received. [[DEX:RETURN:' + ID + ']]', ID), true);
});

test('RETURN plus DONE stops the relay without losing the return receipt identity', () => {
  const input = 'Completed.\n[[DEX:RETURN:' + ID + ']] [[DEX:DONE]]';
  const parsed = protocol.parseAgentReply(input);
  assert.equal(parsed.returnRequestId, ID);
  assert.equal(parsed.done, true);
  assert.equal(parsed.text, 'Completed.');
  assert.equal(protocol.relayDisposition(parsed, 'Astro', false,
    { active: true, remaining: 1 }).action, 'stop');
  assert.equal(returns.exactReturn(input, ID), true);
  assert.equal(returns.exactReturn(input, 'dex-turn-unknown12345678'), false);
});

test('wrong, partial, interior and unbound markers never form an exact capture receipt', () => {
  for (const input of [
    'I discussed [[DEX:RETURN:' + ID + ']] in prose, then continued.',
    'Finished [[DEX:RETURN]]',
    'Finished [[DEX:RETURN:' + ID + ']'
  ]) {
    assert.equal(returns.trailingReturn(input), null);
    assert.equal(protocol.parseAgentReply(input).returnRequestId, undefined);
  }
  const tagged = 'Finished [[DEX:RETURN:' + ID + ']]';
  assert.equal(returns.exactReturn(tagged, 'dex-turn-unrelated12345678'), false);
});

test('baseline fallback captures exactly one new assistant turn, ignoring old DIL reflow', () => {
  const old = { getAttribute(name) {
    return name === 'data-chatgpt-selection-message-id' ? 'msg-old' : null;
  }, text: 'Previous reply.' };
  const oldReflow = { ...old };
  const fresh = { getAttribute(name) {
    return name === 'data-chatgpt-selection-message-id' ? 'msg-new' : null;
  }, text: 'ACK. [[DEX:RETURN:' + ID + ']]' };
  let nodes = [old];
  const api = { assistantNodes: () => nodes, assistantText: (node) => node.text,
    responseTextForUserPrompt: () => '' };
  const before = returns.baseline(nodes);
  nodes = [oldReflow, fresh];
  assert.equal(returns.freshReply(api, before), fresh.text);
  assert.equal(returns.scopedResponse(api, 'unreadable DIL user turn', 0, before, false).text, '');
  assert.equal(returns.scopedResponse(api, 'unreadable DIL user turn', 0, before, true).text, fresh.text);
  nodes.push({ ...fresh });
  assert.equal(returns.freshReply(api, before), '', 'ambiguous multiple new turn surfaces fail closed');
});
