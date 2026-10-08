'use strict';

const ACTIONS = new Set(['quorum_presence', 'quorum_open', 'quorum_vote', 'quorum_status', 'quorum_close']);

function normalized(value) { return String(value ?? '').trim().toLowerCase(); }

function inferAgent(origin = {}) {
  const value = normalized(origin.executorName || origin.agentName || '');
  if (/\beve\b/.test(value) || value.startsWith('eve-')) return 'Eve';
  if (/\bnova\b/.test(value) || value.startsWith('nova-')) return 'Nova';
  if (/\bvera\b/.test(value) || value.startsWith('vera-')) return 'Vera';
  return '';
}

function inferProvider(source = {}) {
  const value = normalized(source.providerId || source.provider || source.targetId || '');
  if (value.includes('chatgpt')) return 'chatgpt';
  if (value.includes('codex')) return 'codex';
  if (value.includes('hark')) return 'hark';
  return '';
}

function createAgentQuorumProviderControl({ quorum, machineError = (code, message) => Object.assign(new Error(message), { code }) } = {}) {
  if (!quorum) throw new TypeError('quorum coordinator is required');

  function provenance(input) {
    const origin = input.origin || {};
    const agent = inferAgent(origin);
    const provider = inferProvider(input.source || {});
    if (!origin.roomId || !origin.executorMemberId || !origin.agentMessageId)
      throw machineError('MACHINE_QUORUM_ORIGIN_REQUIRED', 'Agent quorum mutations require an exact committed Dex relay origin.');
    if (!agent) throw machineError('MACHINE_QUORUM_AGENT_UNKNOWN', 'The originating Dex member is not a recognized Eve, Nova, or Vera agent.');
    if (!provider) throw machineError('MACHINE_QUORUM_PROVIDER_UNKNOWN', 'The originating provider could not be identified from the authenticated source binding.');
    return {
      agent, provider,
      roomId: String(origin.roomId),
      memberId: String(origin.executorMemberId),
      messageId: String(origin.agentMessageId),
      requestId: String(input.requestId || '')
    };
  }

  function route(input, helpers = {}) {
    const action = normalized(input?.command?.action);
    const command = input?.command || {};
    let result;
    try {
      if (action === 'quorum_status') {
        const data = command.workflowId ? quorum.snapshotWorkflow(command.workflowId) : quorum.snapshot();
        result = { ok: true, action, message: command.workflowId ? `Quorum workflow ${command.workflowId} inspected.` : 'Agent quorum state inspected.', data };
      } else {
        const actor = provenance(input);
        // Any exact agent-origin mutation refreshes its availability evidence. This is
        // evidence of a live bound turn, not a user-supplied claim.
        quorum.reportPresence({ ...actor, available: true, evidenceId: actor.messageId, source: 'dex-provider-control' });
        if (action === 'quorum_presence') {
          result = { ok: true, action, message: `${actor.agent} availability evidence recorded.`, data: quorum.snapshot() };
        } else if (action === 'quorum_open') {
          const workflow = quorum.openWorkflow({
            workflowId: command.workflowId || input.requestId,
            topic: command.topic,
            roomId: actor.roomId,
            expectedAgents: command.expectedAgents,
            requiredAgents: command.requiredAgents,
            minVotes: Number.isInteger(command.minVotes) ? command.minVotes : undefined
          });
          result = { ok: true, action, message: `Opened quorum workflow ${workflow.workflowId}.`, data: workflow };
        } else if (action === 'quorum_vote') {
          const workflow = quorum.castVote({
            workflowId: command.workflowId,
            agent: actor.agent,
            provider: actor.provider,
            decision: command.decision,
            controlId: command.controlId || input.requestId,
            requestId: input.requestId,
            roomId: actor.roomId,
            memberId: actor.memberId,
            messageId: actor.messageId
          });
          result = { ok: true, action, message: `${actor.agent} vote recorded exactly once.`, data: workflow };
        } else if (action === 'quorum_close') {
          const workflow = quorum.closeWorkflow(command.workflowId, { decision: command.decision, force: command.force === true });
          result = { ok: true, action, message: `Closed quorum workflow ${workflow.workflowId} as ${workflow.finalDecision}.`, data: workflow };
        } else {
          throw machineError('MACHINE_QUORUM_ACTION_UNKNOWN', 'Unknown agent quorum action.');
        }
      }
    } catch (error) {
      result = { ok: false, action, code: error.code || 'MACHINE_QUORUM_FAILED', message: error.message || 'Agent quorum operation failed.' };
    }
    const receipt = typeof helpers.commitOriginReceipt === 'function' && input.origin
      ? helpers.commitOriginReceipt(input.origin, result, input.requestId) : null;
    if (typeof helpers.sendResult === 'function') {
      helpers.sendResult({ sourceSocket: input.ws, requestId: input.requestId, source: input.source }, result, receipt);
      return true;
    }
    return result;
  }

  return { owns: (action) => ACTIONS.has(normalized(action)), route };
}

module.exports = { ACTIONS, inferAgent, inferProvider, createAgentQuorumProviderControl };
