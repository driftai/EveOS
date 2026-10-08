'use strict';

const { cleanCommand, commandDigest } = require('./approval-broker');

const ACTIONS = new Set(['job_prepare', 'job_status', 'job_list']);

function machineError(code, message) { return Object.assign(new Error(message), { code }); }
function normalized(value) { return String(value ?? '').trim(); }

function createSupervisedJobProviderControl({ jobs, commandStore, broker, getState, findSpace } = {}) {
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
    const command = cleanCommand(String(input.command?.command || ''));
    if (!command) throw machineError('MACHINE_COMMAND_REQUIRED', 'Supervised job command is empty.');
    const digest = commandDigest(command);
    const job = jobs.create({
      requestId: input.requestId,
      kind: 'terminal-supervised',
      roomId: room.id,
      spaceId: space.id,
      ownerMemberId: input.origin.executorMemberId,
      targetId,
      processEpoch: target.processEpoch,
      commandDigest: digest
    });
    const prior = commandStore.get(job.jobId);
    if (prior && prior.commandDigest !== digest)
      throw machineError('MACHINE_JOB_REQUEST_CONFLICT', 'This supervised job already owns a different immutable command.');
    if (!prior) commandStore.set(job.jobId, {
      command,
      commandDigest: digest,
      actorMemberId: input.origin.executorMemberId,
      actorName: input.origin.executorName || 'Agent',
      sourceMessageId: input.origin.agentMessageId,
      createdAt: job.createdAt
    });
    return { ...job, commandAvailable: true,
      commandPreview: command.length > 180 ? `${command.slice(0, 177)}...` : command };
  }

  function visibleJobs(input) {
    const { room, space } = roomSpace(input);
    return jobs.snapshot().jobs.filter((job) => job.roomId === room.id && job.spaceId === space.id)
      .map((job) => ({ ...job, commandAvailable: commandStore.has(job.jobId) }));
  }

  function route(input, helpers = {}) {
    const action = String(input?.command?.action || '').toLowerCase();
    let result;
    try {
      if (action === 'job_prepare') {
        const data = prepare(input);
        result = { ok: true, action, message: `Prepared supervised job ${data.jobId}; local owner approval is required before launch.`, data };
      } else if (action === 'job_status') {
        const data = jobs.status(input.command?.jobId);
        const { room } = roomSpace(input);
        if (data.roomId !== room.id) throw machineError('MACHINE_JOB_NOT_AUTHORIZED', 'That supervised job is outside this authorized room.');
        result = { ok: true, action, message: `Supervised job ${data.jobId} is ${data.state}.`,
          data: { ...data, commandAvailable: commandStore.has(data.jobId) } };
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
