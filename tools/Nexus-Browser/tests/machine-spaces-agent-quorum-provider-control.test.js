'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentQuorumCoordinator } = require('../machine-spaces/agent-quorum');
const { inferAgent, inferProvider, createAgentQuorumProviderControl } = require('../machine-spaces/agent-quorum-provider-control');

function exactInput(action, extra = {}) {
  return {
    source: { providerId: 'hark', targetClassId: 'online-origin' },
    command: { action, ...extra.command },
    requestId: extra.requestId || `req-${action}`,
    ws: {},
    origin: extra.origin === undefined ? {
      roomId: 'room-one', executorMemberId: 'member-vera', executorName: 'Vera-Hark-Agent', agentMessageId: `msg-${action}`
    } : extra.origin
  };
}

function routed(control, input) {
  let delivered = null;
  let receiptCalls = 0;
  control.route(input, {
    commitOriginReceipt(origin, result, requestId) {
      receiptCalls++;
      assert.equal(origin, input.origin);
      assert.equal(requestId, input.requestId);
      return { id: `receipt-${requestId}`, ok: result.ok };
    },
    sendResult(_waiter, result, receipt) { delivered = { result, receipt }; }
  });
  return { ...delivered, receiptCalls };
}

test('quorum provider identity is inferred only from exact member/provider provenance', () => {
  assert.equal(inferAgent({ executorName: 'Eve-Main-Agent' }), 'Eve');
  assert.equal(inferAgent({ executorName: 'Nova-Codex-Agent' }), 'Nova');
  assert.equal(inferAgent({ executorName: 'Vera-Hark-Agent' }), 'Vera');
  assert.equal(inferAgent({ executorName: 'Human User' }), '');
  assert.equal(inferProvider({ providerId: 'chatgpt' }), 'chatgpt');
  assert.equal(inferProvider({ providerId: 'codex-local' }), 'codex');
  assert.equal(inferProvider({ providerId: 'hark' }), 'hark');
});

test('mutating quorum command refuses missing exact Dex origin', () => {
  const quorum = createAgentQuorumCoordinator();
  const control = createAgentQuorumProviderControl({ quorum });
  const outcome = routed(control, exactInput('quorum_presence', { origin: null }));
  assert.equal(outcome.result.ok, false);
  assert.equal(outcome.result.code, 'MACHINE_QUORUM_ORIGIN_REQUIRED');
  assert.equal(outcome.receiptCalls, 0);
});

test('authenticated provider mismatch cannot impersonate another named agent', () => {
  const quorum = createAgentQuorumCoordinator();
  const control = createAgentQuorumProviderControl({ quorum });
  const input = exactInput('quorum_presence');
  input.source.providerId = 'chatgpt';
  const outcome = routed(control, input);
  assert.equal(outcome.result.ok, false);
  assert.equal(outcome.result.code, 'MACHINE_AGENT_PROVIDER_MISMATCH');
  assert.equal(outcome.receiptCalls, 1);
});

test('provider flow opens, votes, inspects and closes an exact-origin workflow', () => {
  const quorum = createAgentQuorumCoordinator();
  const control = createAgentQuorumProviderControl({ quorum });
  const opened = routed(control, exactInput('quorum_open', {
    requestId: 'req-open', command: { workflowId: 'wf-one', expectedAgents: ['vera'], minVotes: 1 }
  }));
  assert.equal(opened.result.ok, true);
  assert.equal(opened.result.data.workflowId, 'wf-one');

  const voted = routed(control, exactInput('quorum_vote', {
    requestId: 'req-vote', command: { workflowId: 'wf-one', decision: 'approve', controlId: 'control-vera' }
  }));
  assert.equal(voted.result.ok, true);
  assert.equal(voted.result.data.result.quorumMet, true);
  assert.equal(voted.result.data.votes[0].messageId, 'msg-quorum_vote');

  const status = routed(control, { source: {}, command: { action: 'quorum_status', workflowId: 'wf-one' }, requestId: 'req-status', ws: {}, origin: null });
  assert.equal(status.result.ok, true);
  assert.equal(status.result.data.result.quorumMet, true);
  assert.equal(status.receiptCalls, 0);

  const closed = routed(control, exactInput('quorum_close', {
    requestId: 'req-close', command: { workflowId: 'wf-one' }
  }));
  assert.equal(closed.result.ok, true);
  assert.equal(closed.result.data.finalDecision, 'approved');
});
