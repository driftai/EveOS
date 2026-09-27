'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const p = require('../dex/prompt-send-recovery'), policy = require('../public/dex-failure-policy');
const TURN = 'dex-turn-test-1234';
const fixture = () => ({ rooms: [{ id: 'room-one', relay: { active: false, remaining: 0 },
  recovery: { requestId: TURN, memberId: 'eve', relayRemaining: 2,
    relayActive: true, dispatched: true } }] });
test('failed pre-gesture browser dispatch retains original journal and capture-only policy', () => {
  const state = fixture(), j = state.rooms[0].recovery;
  p.noteFailure(j, { code: 'PROMPT_SEND_FAILED', detail: { deliveryEvidence: {
    requestId: TURN, phase: 'blocked', gestureAttempted: false,
    prompt: 'sensitive-contents-never-persisted' } } }, TURN, 1000);
  assert.equal(j.promptSendFailure.classification, 'pre-gesture-reported');
  assert.doesNotMatch(JSON.stringify(j), /sensitive-contents/);
  assert.equal(policy.decision('PROMPT_SEND_FAILED', { dispatched: true }).retry, false);
  assert.equal(p.summary(j).heldTurns, 2);
  assert.equal(state.rooms[0].relay.remaining, 0);
});
test('mismatched evidence cannot clear uncertainty; later gesture evidence has precedence', () => {
  const j = fixture().rooms[0].recovery;
  p.noteFailure(j, { code: 'PROMPT_SEND_FAILED', detail: { deliveryEvidence:
    { requestId: 'wrong', phase: 'blocked', gestureAttempted: false } } }, TURN, 1000);
  assert.equal(j.promptSendFailure.classification, 'submission-unknown');
  p.noteFailure(j, { code: 'PROMPT_SEND_FAILED', detail: { deliveryEvidence:
    { requestId: TURN, phase: 'blocked', gestureAttempted: false } } }, TURN, 1001);
  p.noteFailure(j, { code: 'PROMPT_SEND_FAILED', detail: { deliveryEvidence:
    { requestId: TURN, phase: 'uncertain', gestureAttempted: true } } }, TURN, 1002);
  assert.equal(j.promptSendFailure.classification, 'gesture-outcome-unknown');
  assert.equal(p.noteFailure(j, { code: 'PROMPT_SEND_FAILED' }, 'wrong', 1003), false);
});
test('one-shot delayed human attention does not consume a relay turn or resend prompt', () => {
  const state = fixture(), j = state.rooms[0].recovery, events = [], saves = [];
  p.noteFailure(j, { code: 'PROMPT_SEND_FAILED' }, TURN, 1000);
  let delay; p.scheduleAttention(j, 1000, x => { delay = x; });
  assert.equal(delay, p.ATTENTION_MS);
  assert.equal(p.flagAttention(state, 1000 + p.ATTENTION_MS - 1,
    s => saves.push(structuredClone(s)), x => events.push(x)), 0);
  assert.equal(p.flagAttention(state, 1000 + p.ATTENTION_MS,
    s => saves.push(structuredClone(s)), x => events.push(x)), 1);
  assert.equal(p.flagAttention(state, 1000 + p.ATTENTION_MS + 5000,
    s => saves.push(structuredClone(s)), x => events.push(x)), 0);
  assert.equal(saves.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].evidence.promptResent, false);
  assert.equal(p.summary(j).nextStep, 'inspect-exact-bound-tab-no-replay');
  assert.equal(j.requestId, TURN);
});
test('passive archived request remains isolated from active attention', () => {
  const j = fixture().rooms[0].recovery;
  p.noteFailure(j, { code: 'PROMPT_SEND_FAILED' }, TURN, 1000);
  j.passiveAt = '2026-09-26T00:00:00.000Z';
  assert.equal(p.attentionDue(j, 1000 + p.ATTENTION_MS), false);
  assert.equal(p.summary(j).nextStep, 'await-passive-archive');
});
