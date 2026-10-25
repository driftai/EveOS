'use strict';

const { cleanCommand, commandDigest } = require('./approval-broker');
const { registeredPlan } = require('./playwright-job-plan');
const { relativeFile } = require('./engineering-recovery-job-plan');
const { createChatApproval, publicChatApproval } = require('./supervised-chat-approval');
const { workflowEligible } = require('./engineering-workflow-authorization');

const ACTIONS = new Set(['job_prepare', 'playwright_prepare', 'governor_prepare', 'job_status', 'job_list']);

function machineError(code, message) { return Object.assign(new Error(message), { code }); }
function normalized(value) { return String(value ?? '').trim(); }

function createSupervisedJobProviderControl({ jobs, commandStore, broker, getState, findSpace, repoRoot,
  prepareGovernor = null, now = () => Date.now() } = {}) {
  if (!jobs || !commandStore || !broker || typeof getState !== 'function' || typeof findSpace !== 'function')
    throw new TypeError('supervised job provider control requires jobs, commandStore, broker, getState and findSpace');

  function roomSpace(input) {
    const roomId = String(input.origin?.roomId || input.boundRoomId || '');
    if (!roomId) throw machineError('MACHINE_ROOM_REQUIRED', 'Supervised jobs require one exact authorized room.');
    const snapshot = getState();
    const room = (snapshot?.rooms || []).find((entry) => entry.id === roomId);
    if (!room) throw machineError('MACHINE_ROOM_NOT_FOUND', 'Originating Dex room no longer exists.');
    const space = findSpace(room, input.command?.space);
    if (!space) throw machineError('MACHINE_SPACE_REQUIRED', 'Choose one exact active Machine Space.');
    return { room, space };
  }

  function prepare(input) {
    if (!input.origin?.roomId || !input.origin?.executorMemberId || !input.origin?.agentMessageId)
      throw machineError('MACHINE_JOB_ORIGIN_REQUIRED', 'job_prepare must trail an exact committed Dex relay reply.');
    const { room, space } = roomSpace(input);
    const targetId = normalized(input.command?.terminal || input.command?.terminalId);
    const target = broker.target(targetId);
    if (!target || !(space.resourceIds || []).includes(targetId))
      throw machineError('MACHINE_TARGET_NOT_ATTACHED', 'Supervised job target must be attached to this exact Machine Space.');
    // Agents select a registered Playwright scenario; the server, not the agent,
    // supplies the exact command. Execution still requires a separate local Start.
    const playwright = input.command.action === 'playwright_prepare';
    const plan = playwright ? registeredPlan({ command: input.command, target, repoRoot }) : null;
    const command = playwright ? plan.command : cleanCommand(String(input.command?.command || ''));
    if (!command) throw machineError('MACHINE_COMMAND_REQUIRED', 'Supervised job command is empty.');
    const digest = commandDigest(command);
    const kind = playwright ? 'playwright-acceptance' : 'terminal-supervised';
    const retrySafety = normalized(input.command?.retrySafety || 'never');
    if (!['never', 'idempotent'].includes(retrySafety))
      throw machineError('MACHINE_JOB_RETRY_SAFETY_INVALID', 'retrySafety must be never or idempotent.');
    const repairFiles = Array.isArray(input.command?.repairFiles)
      ? input.command.repairFiles.slice(0, 16).map((item) => relativeFile(item, repoRoot)) : [];
    if (retrySafety === 'idempotent' && !repairFiles.length)
      throw machineError('MACHINE_JOB_REPAIR_FILES_REQUIRED', 'Idempotent engineering recovery requires exact repairFiles.');
    const contextFiles = Array.isArray(input.command?.contextFiles) && input.command.contextFiles.length
      ? input.command.contextFiles.slice(0, 24).map((item) => relativeFile(item, repoRoot)) : repairFiles;
    const invariants = Array.isArray(input.command?.invariants)
      ? input.command.invariants.slice(0, 12).map(normalized).filter(Boolean) : [];
    const job = jobs.create({
      requestId: input.requestId,
      kind,
      roomId: room.id,
      spaceId: space.id,
      ownerMemberId: input.origin.executorMemberId,
      targetId,
      processEpoch: target.processEpoch,
      commandDigest: digest
    });
    const prior = commandStore.get(job.jobId);
    if (job.kind !== kind || job.roomId !== room.id || job.spaceId !== space.id
        || job.ownerMemberId !== input.origin.executorMemberId
        || (prior && (prior.commandDigest !== digest || prior.kind !== (playwright ? 'playwright-acceptance' : undefined)
          || prior.retrySafety !== retrySafety || JSON.stringify(prior.repairFiles) !== JSON.stringify(repairFiles)
          || JSON.stringify(prior.contextFiles) !== JSON.stringify(contextFiles)
          || JSON.stringify(prior.invariants) !== JSON.stringify(invariants))))
      throw machineError('MACHINE_JOB_REQUEST_CONFLICT', 'This request ID already owns a different immutable supervised job.');
    if (!prior) {
      const stored = {
        ...(playwright ? { kind, scenario: plan.scenario, runnerSha256: plan.runnerSha256,
          evidenceSha256: plan.evidenceSha256, mode: plan.mode } : {}),
        command,
        commandDigest: digest,
        actorMemberId: input.origin.executorMemberId,
        actorName: input.origin.executorName || 'Agent',
        sourceMessageId: input.origin.agentMessageId,
        retrySafety, repairFiles, contextFiles, invariants,
        createdAt: job.createdAt
      };
      if (playwright || workflowEligible(job, stored)) {
        stored.chatApproval = createChatApproval({ jobId: job.jobId, commandDigest: digest, kind, now });
      }
      commandStore.set(job.jobId, stored);
    }
    const stored = commandStore.get(job.jobId);
    return { ...job, commandAvailable: true, workflowEligible: workflowEligible(job, stored),
      commandPreview: command.length > 180 ? `${command.slice(0, 177)}...` : command,
      chatApproval: publicChatApproval(stored, now) };
  }

  function visibleJobs(input) {
    const { room, space } = roomSpace(input);
    return jobs.snapshot().jobs.filter((job) => job.roomId === room.id && job.spaceId === space.id)
      .map((job) => {
        const stored = commandStore.get(job.jobId);
        return { ...job, commandAvailable: !!stored, workflowEligible: workflowEligible(job, stored),
          commandPreview: stored?.command ? (stored.command.length > 180 ? `${stored.command.slice(0, 177)}...` : stored.command) : null,
          chatApproval: publicChatApproval(stored, now) };
      });
  }

  function route(input, helpers = {}) {
    const action = String(input?.command?.action || '').toLowerCase();
    let result;
    try {
      if (action === 'job_prepare' || action === 'playwright_prepare') {
        const data = prepare(input);
        result = { ok: true, action, message: `Prepared supervised job ${data.jobId}; local owner approval is required before launch.`, data };
      } else if (action === 'governor_prepare') {
        if (typeof prepareGovernor !== 'function')
          throw machineError('MACHINE_GOVERNOR_UNAVAILABLE', 'Governed engineering preparation is unavailable on this Nexus runtime.');
        const job = prepareGovernor(input);
        const stored = commandStore.get(job.jobId);
        if (!stored?.chatApproval) stored.chatApproval = createChatApproval({
          jobId: job.jobId, commandDigest: job.commandDigest, kind: 'governor', now });
        const data = { ...job, workflowEligible: workflowEligible(job, stored),
          chatApproval: publicChatApproval(stored, now) };
        result = { ok: true, action,
          message: `Prepared governed engineering job ${data.jobId}; one local workflow approval is required before launch.`, data };
      } else if (action === 'job_status') {
        const data = jobs.status(input.command?.jobId);
        const { room, space } = roomSpace(input);
        if (data.roomId !== room.id || data.spaceId !== space.id)
          throw machineError('MACHINE_JOB_NOT_AUTHORIZED', 'That supervised job is outside this authorized room and Machine Space.');
        const stored = commandStore.get(data.jobId);
        result = { ok: true, action, message: `Supervised job ${data.jobId} is ${data.state}.`,
          data: { ...data, commandAvailable: !!stored, workflowEligible: workflowEligible(data, stored),
            chatApproval: publicChatApproval(stored, now) } };
      } else if (action === 'job_list') {
        const data = visibleJobs(input);
        result = { ok: true, action, message: `${data.length} supervised job(s) are visible in this Machine Space.`, data };
      } else {
        throw machineError('MACHINE_JOB_ACTION_UNKNOWN', 'Unknown supervised job provider action.');
      }
    } catch (error) {
      result = { ok: false, action, code: error.code || 'MACHINE_JOB_CONTROL_FAILED', message: error.message || 'Supervised job control failed.' };
    }
    const receipt = typeof helpers.commitOriginReceipt === 'function' && input.origin
      ? helpers.commitOriginReceipt(input.origin, result, input.requestId) : null;
    if (typeof helpers.sendResult === 'function') {
      helpers.sendResult({ sourceSocket: input.ws, requestId: input.requestId, source: input.source }, result, receipt);
      return true;
    }
    return result;
  }

  return { owns: (action) => ACTIONS.has(String(action || '').toLowerCase()), route };
}

module.exports = { ACTIONS, createSupervisedJobProviderControl };
