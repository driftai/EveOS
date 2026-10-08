'use strict';

const crypto = require('node:crypto');

const DEFAULT_IDENTITIES = Object.freeze({
  eve: Object.freeze({ agent: 'Eve', provider: 'chatgpt' }),
  nova: Object.freeze({ agent: 'Nova', provider: 'codex' }),
  vera: Object.freeze({ agent: 'Vera', provider: 'hark' })
});

function normalize(value) {
  return String(value ?? '').trim().toLowerCase();
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function makeError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function createAgentQuorumCoordinator(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const defaultTtlMs = Math.max(1000, Number(options.defaultTtlMs) || 120000);
  const identities = new Map();
  const presence = new Map();
  const presenceEvidence = new Map();
  const workflows = new Map();
  const events = [];
  let eventSequence = 0;

  for (const [key, identity] of Object.entries(options.identities || DEFAULT_IDENTITIES)) {
    identities.set(normalize(key), {
      key: normalize(key),
      agent: String(identity.agent || key),
      provider: normalize(identity.provider)
    });
  }

  function event(type, data = {}) {
    const entry = {
      sequence: ++eventSequence,
      type,
      at: new Date(now()).toISOString(),
      ...clone(data)
    };
    events.push(entry);
    if (events.length > 1000) events.splice(0, events.length - 1000);
    return entry;
  }

  function identityFor(agent) {
    const key = normalize(agent);
    const identity = identities.get(key);
    if (!identity) throw makeError('MACHINE_AGENT_UNKNOWN', `Unknown Machine Spaces agent: ${agent}`);
    return identity;
  }

  function verifyIdentity(input = {}) {
    const identity = identityFor(input.agent || input.agentKey);
    const provider = normalize(input.provider);
    if (!provider || provider !== identity.provider) {
      throw makeError('MACHINE_AGENT_PROVIDER_MISMATCH', `${identity.agent} must originate from provider ${identity.provider}.`, {
        expectedProvider: identity.provider,
        receivedProvider: provider || null,
        agent: identity.agent
      });
    }
    return identity;
  }

  function reportPresence(input = {}) {
    const identity = verifyIdentity(input);
    const ttlMs = Math.max(1000, Number(input.ttlMs) || defaultTtlMs);
    const observedAtMs = Number.isFinite(Number(input.observedAtMs)) ? Number(input.observedAtMs) : now();
    const available = input.available !== false;
    const evidenceId = input.evidenceId ? String(input.evidenceId) : null;
    const record = {
      agentKey: identity.key,
      agent: identity.agent,
      provider: identity.provider,
      available,
      observedAt: new Date(observedAtMs).toISOString(),
      expiresAt: new Date(observedAtMs + ttlMs).toISOString(),
      roomId: input.roomId ? String(input.roomId) : null,
      memberId: input.memberId ? String(input.memberId) : null,
      evidenceId,
      source: input.source ? String(input.source) : null
    };
    const evidenceKey = evidenceId ? `${identity.key}|${evidenceId}` : null;
    if (evidenceKey && presenceEvidence.has(evidenceKey)) {
      const prior = presenceEvidence.get(evidenceKey);
      const same = prior.available === record.available
        && prior.roomId === record.roomId
        && prior.memberId === record.memberId
        && prior.source === record.source;
      if (!same) {
        throw makeError('MACHINE_AGENT_PRESENCE_EVIDENCE_CONFLICT',
          `Presence evidence ${evidenceId} was already used with different provenance for ${identity.agent}.`, {
            agent: identity.agent,
            evidenceId,
            prior: clone(prior),
            received: clone(record)
          });
      }
      return clone(prior);
    }
    presence.set(identity.key, record);
    if (evidenceKey) presenceEvidence.set(evidenceKey, clone(record));
    event('presence', record);
    return clone(record);
  }

  function presenceFor(agentKey, atMs = now()) {
    const record = presence.get(normalize(agentKey));
    if (!record) return null;
    const fresh = Date.parse(record.expiresAt) > atMs;
    return { ...clone(record), fresh, eligible: record.available === true && fresh };
  }

  function listPresence() {
    return [...identities.keys()].map((key) => presenceFor(key)).filter(Boolean);
  }

  function openWorkflow(input = {}) {
    const workflowId = String(input.workflowId || '').trim();
    if (!workflowId) throw makeError('MACHINE_QUORUM_WORKFLOW_REQUIRED', 'workflowId is required.');
    if (workflows.has(workflowId)) return snapshotWorkflow(workflowId);

    const expectedAgents = [...new Set((input.expectedAgents || [...identities.keys()]).map(normalize))];
    for (const key of expectedAgents) identityFor(key);
    const requiredAgents = [...new Set((input.requiredAgents || []).map(normalize))];
    for (const key of requiredAgents) {
      identityFor(key);
      if (!expectedAgents.includes(key)) throw makeError('MACHINE_QUORUM_REQUIRED_AGENT_NOT_EXPECTED', `${key} is required but not expected.`);
    }

    const record = {
      workflowId,
      topic: input.topic ? String(input.topic) : null,
      roomId: input.roomId ? String(input.roomId) : null,
      expectedAgents,
      requiredAgents,
      minVotes: Number.isInteger(input.minVotes) && input.minVotes > 0 ? input.minVotes : null,
      votes: new Map(),
      controls: new Map(),
      openedAt: new Date(now()).toISOString(),
      closedAt: null,
      finalDecision: null
    };
    workflows.set(workflowId, record);
    event('workflow-opened', { workflowId, expectedAgents, requiredAgents, minVotes: record.minVotes, roomId: record.roomId });
    return snapshotWorkflow(workflowId);
  }

  function getWorkflow(workflowId) {
    const record = workflows.get(String(workflowId || '').trim());
    if (!record) throw makeError('MACHINE_QUORUM_WORKFLOW_UNKNOWN', `Unknown quorum workflow: ${workflowId}`);
    return record;
  }

  function eligibleAgents(record, atMs = now()) {
    return record.expectedAgents.filter((key) => presenceFor(key, atMs)?.eligible === true);
  }

  function compute(record, atMs = now()) {
    const eligible = eligibleAgents(record, atMs);
    const eligibleSet = new Set(eligible);
    const votes = [...record.votes.values()].filter((vote) => eligibleSet.has(vote.agentKey));
    const yes = votes.filter((vote) => vote.decision === 'approve').length;
    const no = votes.filter((vote) => vote.decision === 'deny').length;
    const abstain = votes.filter((vote) => vote.decision === 'abstain').length;
    const threshold = record.minVotes || Math.floor(eligible.length / 2) + 1;
    const missingRequired = record.requiredAgents.filter((key) => !eligibleSet.has(key) || !record.votes.has(key));
    const quorumMet = eligible.length > 0 && yes >= threshold && missingRequired.length === 0;
    return { eligibleAgents: eligible, threshold, yes, no, abstain, votesCast: votes.length, missingRequired, quorumMet };
  }

  function castVote(input = {}) {
    const record = getWorkflow(input.workflowId);
    if (record.closedAt) throw makeError('MACHINE_QUORUM_WORKFLOW_CLOSED', `Workflow ${record.workflowId} is already closed.`);
    const identity = verifyIdentity(input);
    if (!record.expectedAgents.includes(identity.key)) {
      throw makeError('MACHINE_QUORUM_AGENT_NOT_ELIGIBLE', `${identity.agent} is not eligible for workflow ${record.workflowId}.`);
    }
    if (!presenceFor(identity.key)?.eligible) {
      throw makeError('MACHINE_QUORUM_PRESENCE_REQUIRED', `${identity.agent} does not have fresh availability evidence.`);
    }

    const decision = normalize(input.decision);
    if (!['approve', 'deny', 'abstain'].includes(decision)) {
      throw makeError('MACHINE_QUORUM_DECISION_INVALID', 'decision must be approve, deny, or abstain.');
    }
    const controlId = String(input.controlId || '').trim();
    if (!controlId) throw makeError('MACHINE_QUORUM_CONTROL_REQUIRED', 'controlId is required for exact-once vote attribution.');

    const priorControl = record.controls.get(controlId);
    if (priorControl) {
      if (priorControl.agentKey !== identity.key || priorControl.decision !== decision) {
        throw makeError('MACHINE_QUORUM_CONTROL_CONFLICT', `controlId ${controlId} was already used for a different vote.`);
      }
      return snapshotWorkflow(record.workflowId);
    }
    const priorVote = record.votes.get(identity.key);
    if (priorVote) {
      throw makeError('MACHINE_QUORUM_DUPLICATE_AGENT_VOTE', `${identity.agent} already voted in workflow ${record.workflowId}.`);
    }

    const vote = {
      agentKey: identity.key,
      agent: identity.agent,
      provider: identity.provider,
      decision,
      controlId,
      requestId: input.requestId ? String(input.requestId) : null,
      roomId: input.roomId ? String(input.roomId) : record.roomId,
      memberId: input.memberId ? String(input.memberId) : null,
      messageId: input.messageId ? String(input.messageId) : null,
      at: new Date(now()).toISOString()
    };
    record.votes.set(identity.key, vote);
    record.controls.set(controlId, vote);
    event('vote', { workflowId: record.workflowId, ...vote });
    return snapshotWorkflow(record.workflowId);
  }

  function closeWorkflow(workflowId, input = {}) {
    const record = getWorkflow(workflowId);
    if (record.closedAt) return snapshotWorkflow(record.workflowId);
    const result = compute(record);
    if (!result.quorumMet && input.force !== true) {
      throw makeError('MACHINE_QUORUM_NOT_MET', `Workflow ${record.workflowId} has not reached approval quorum.`, { result });
    }
    record.closedAt = new Date(now()).toISOString();
    record.finalDecision = input.decision ? String(input.decision) : (result.quorumMet ? 'approved' : 'forced');
    event('workflow-closed', { workflowId: record.workflowId, finalDecision: record.finalDecision, result });
    return snapshotWorkflow(record.workflowId);
  }

  function snapshotWorkflow(workflowId) {
    const record = getWorkflow(workflowId);
    return {
      workflowId: record.workflowId,
      topic: record.topic,
      roomId: record.roomId,
      expectedAgents: [...record.expectedAgents],
      requiredAgents: [...record.requiredAgents],
      minVotes: record.minVotes,
      openedAt: record.openedAt,
      closedAt: record.closedAt,
      finalDecision: record.finalDecision,
      votes: [...record.votes.values()].map(clone),
      result: compute(record)
    };
  }

  function snapshot() {
    return {
      version: 1,
      identities: [...identities.values()].map(clone),
      presence: listPresence(),
      workflows: [...workflows.keys()].map(snapshotWorkflow),
      events: events.map(clone)
    };
  }

  return {
    reportPresence,
    listPresence,
    openWorkflow,
    castVote,
    closeWorkflow,
    snapshotWorkflow,
    snapshot,
    verifyIdentity
  };
}

module.exports = {
  DEFAULT_IDENTITIES,
  createAgentQuorumCoordinator
};