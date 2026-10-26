'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAgentLiveContext, readinessOnlyReply } = require('../dex/agent-live-context');

test('live context binds the exact room, transport and provider-control schemas', () => {
  const value = buildAgentLiveContext({
    room: { id: 'room-exact', name: 'Fresh Engineering' },
    member: { id: 'agent-tlo', name: 'TLO', binding: {
      targetClassId: 'local-origin', transport: 'search-monitor-workspace'
    } }
  });
  assert.match(value, /Current room: Fresh Engineering \(room-exact\)/);
  assert.match(value, /Search Monitor carries this local-agent chat/);
  assert.match(value, /"action":"use_room","room":/);
  assert.doesNotMatch(value, /"action":"use_room","roomId":/);
  for (const marker of ['DEX:DONE', 'DEX:NOTE', 'DEX:USER', 'DEX:CMD']) assert.match(value, new RegExp(marker));
  for (const action of ['onboard', 'workspace_ensure', 'terminal_status', 'terminal_output', 'governor_prepare', 'job_status']) {
    assert.match(value, new RegExp(action));
  }
  assert.match(value, /Label unverified explanations as hypotheses/);
  assert.match(value, /BUDGET:\+1/);
  assert.match(value, /receipt-processing turn/);
});

test('middle-agent trace guidance is injected only for the room-selected participant', () => {
  const room = { id: 'room-exact', name: 'Engineering', settings: {
    middleAgentMode: 'manual', middleAgentMemberId: 'tlo' }, members: [
    { id: 'tlo', relayEnabled: true, binding: { targetClassId: 'local-origin' } },
    { id: 'worker', relayEnabled: true, binding: { targetClassId: 'online-origin' } }
  ] };
  const middle = buildAgentLiveContext({ room, member: room.members[0] });
  const worker = buildAgentLiveContext({ room, member: room.members[1] });
  assert.match(middle, /MIDDLE-AGENT PUBLIC DECISION TRACE/);
  assert.match(middle, /private hidden chain-of-thought/);
  assert.doesNotMatch(worker, /MIDDLE-AGENT PUBLIC DECISION TRACE/);
});

test('readiness guard is narrow and never consumes meaningful work', () => {
  assert.equal(readinessOnlyReply("I'm ready."), true);
  assert.equal(readinessOnlyReply('I am ready to proceed.'), true);
  assert.equal(readinessOnlyReply('Standing by.'), true);
  assert.equal(readinessOnlyReply('I ran the test and it passed.'), false);
  assert.equal(readinessOnlyReply('Ready: the workspace is provisioned and job is queued.'), false);
});
