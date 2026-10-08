'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentQuorumCoordinator } = require('../machine-spaces/agent-quorum');

function coordinator() {
  let clock = Date.parse('2026-10-08T08:00:00.000Z');
  const quorum = createAgentQuorumCoordinator({ now: () => clock, defaultTtlMs: 60000 });
  return { quorum, advance(ms) { clock += ms; } };
}

function online(quorum, agent, provider, suffix = agent.toLowerCase()) {
  return quorum.reportPresence({
    agent,
    provider,
    available: true,
    roomId: 'room-machine-spaces',
    memberId: `member-${suffix}`,
    evidenceId: `presence-${suffix}`,
    source: 'dex-room-membership'
  });
}

test('provider identity is pinned to Eve=ChatGPT, Nova=Codex, Vera=Hark', () => {
  const { quorum } = coordinator();
  online(quorum, 'Eve', 'chatgpt');
  online(quorum, 'Nova', 'codex');
  online(quorum, 'Vera', 'hark');
  assert.throws(() => online(quorum, 'Eve', 'hark'), { code: 'MACHINE_AGENT_PROVIDER_MISMATCH' });
  assert.throws(() => online(quorum, 'Unknown', 'chatgpt'), { code: 'MACHINE_AGENT_UNKNOWN' });
});

test('fresh availability evidence controls quorum eligibility', () => {
  const { quorum, advance } = coordinator();
  online(quorum, 'Eve', 'chatgpt');
  online(quorum, 'Nova', 'codex');
  quorum.openWorkflow({ workflowId: 'wf-fresh', expectedAgents: ['eve', 'nova', 'vera'] });
  let snapshot = quorum.snapshotWorkflow('wf-fresh');
  assert.deepEqual(snapshot.result.eligibleAgents, ['eve', 'nova']);
  assert.equal(snapshot.result.threshold, 2);

  advance(61000);
  snapshot = quorum.snapshotWorkflow('wf-fresh');
  assert.deepEqual(snapshot.result.eligibleAgents, []);
  assert.equal(snapshot.result.quorumMet, false);
  assert.throws(() => quorum.castVote({ workflowId: 'wf-fresh', agent: 'Eve', provider: 'chatgpt', decision: 'approve', controlId: 'ctl-stale' }), {
    code: 'MACHINE_QUORUM_PRESENCE_REQUIRED'
  });
});

test('majority quorum only counts currently eligible agents and required agents must vote', () => {
  const { quorum } = coordinator();
  online(quorum, 'Eve', 'chatgpt');
  online(quorum, 'Nova', 'codex');
  online(quorum, 'Vera', 'hark');
  quorum.openWorkflow({
    workflowId: 'wf-majority',
    topic: 'approve supervised agent-only operation',
    expectedAgents: ['eve', 'nova', 'vera'],
    requiredAgents: ['vera']
  });

  let snapshot = quorum.castVote({ workflowId: 'wf-majority', agent: 'Eve', provider: 'chatgpt', decision: 'approve', controlId: 'ctl-eve' });
  assert.equal(snapshot.result.threshold, 2);
  assert.equal(snapshot.result.quorumMet, false);
  assert.deepEqual(snapshot.result.missingRequired, ['vera']);

  snapshot = quorum.castVote({ workflowId: 'wf-majority', agent: 'Vera', provider: 'hark', decision: 'approve', controlId: 'ctl-vera' });
  assert.equal(snapshot.result.yes, 2);
  assert.equal(snapshot.result.quorumMet, true);
  assert.equal(quorum.closeWorkflow('wf-majority').finalDecision, 'approved');
});

test('same control id is idempotent but conflicting reuse and second agent vote are rejected', () => {
  const { quorum } = coordinator();
  online(quorum, 'Eve', 'chatgpt');
  quorum.openWorkflow({ workflowId: 'wf-exact-once', expectedAgents: ['eve'], minVotes: 1 });

  const first = quorum.castVote({ workflowId: 'wf-exact-once', agent: 'Eve', provider: 'chatgpt', decision: 'approve', controlId: 'ctl-1', requestId: 'req-1' });
  const retry = quorum.castVote({ workflowId: 'wf-exact-once', agent: 'Eve', provider: 'chatgpt', decision: 'approve', controlId: 'ctl-1', requestId: 'req-1' });
  assert.deepEqual(retry.votes, first.votes);
  assert.equal(retry.votes.length, 1);

  assert.throws(() => quorum.castVote({ workflowId: 'wf-exact-once', agent: 'Eve', provider: 'chatgpt', decision: 'deny', controlId: 'ctl-1' }), {
    code: 'MACHINE_QUORUM_CONTROL_CONFLICT'
  });
  assert.throws(() => quorum.castVote({ workflowId: 'wf-exact-once', agent: 'Eve', provider: 'chatgpt', decision: 'approve', controlId: 'ctl-2' }), {
    code: 'MACHINE_QUORUM_DUPLICATE_AGENT_VOTE'
  });
});

test('human or provider-mismatched votes cannot participate in agent-only quorum', () => {
  const { quorum } = coordinator();
  online(quorum, 'Vera', 'hark');
  quorum.openWorkflow({ workflowId: 'wf-agent-only', expectedAgents: ['vera'], minVotes: 1 });

  assert.throws(() => quorum.castVote({ workflowId: 'wf-agent-only', agent: 'Human', provider: 'human', decision: 'approve', controlId: 'ctl-human' }), {
    code: 'MACHINE_AGENT_UNKNOWN'
  });
  assert.throws(() => quorum.castVote({ workflowId: 'wf-agent-only', agent: 'Vera', provider: 'chatgpt', decision: 'approve', controlId: 'ctl-wrong-provider' }), {
    code: 'MACHINE_AGENT_PROVIDER_MISMATCH'
  });

  const snapshot = quorum.snapshotWorkflow('wf-agent-only');
  assert.equal(snapshot.votes.length, 0);
  assert.equal(snapshot.result.quorumMet, false);
});

test('audit snapshot retains provenance for presence and exact vote control ids', () => {
  const { quorum } = coordinator();
  online(quorum, 'Nova', 'codex');
  quorum.openWorkflow({ workflowId: 'wf-audit', expectedAgents: ['nova'], roomId: 'room-machine-spaces', minVotes: 1 });
  quorum.castVote({
    workflowId: 'wf-audit', agent: 'Nova', provider: 'codex', decision: 'approve', controlId: 'ctl-nova',
    requestId: 'req-nova', roomId: 'room-machine-spaces', memberId: 'member-nova', messageId: 'msg-nova'
  });

  const snapshot = quorum.snapshot();
  const voteEvent = snapshot.events.find((entry) => entry.type === 'vote');
  assert.equal(voteEvent.controlId, 'ctl-nova');
  assert.equal(voteEvent.requestId, 'req-nova');
  assert.equal(voteEvent.roomId, 'room-machine-spaces');
  assert.equal(voteEvent.memberId, 'member-nova');
  assert.equal(voteEvent.messageId, 'msg-nova');
  assert.equal(snapshot.workflows[0].result.quorumMet, true);
});
