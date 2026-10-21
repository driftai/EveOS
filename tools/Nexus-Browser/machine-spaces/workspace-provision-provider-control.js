'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { middleAgentFor } = require('../dex/engineering-incident');
const { machineState, samePath } = require('./server-controller-model');

const ACTION = 'workspace_ensure';
const RECEIPT_SCHEMA = 'eveos.machine-spaces.workspace-provision.v1';
const MAX_RECEIPTS = 32;

function machineError(code, message) { return Object.assign(new Error(message), { code }); }
function bounded(value, limit = 96) { return String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, limit); }
function publicReceipt(receipt, broker) {
  const target = broker.target(receipt.targetId);
  return {
    schema: RECEIPT_SCHEMA,
    requestId: receipt.requestId,
    roomId: receipt.roomId,
    spaceId: receipt.spaceId,
    targetId: receipt.targetId,
    processEpoch: receipt.processEpoch,
    cwd: receipt.cwd,
    reused: receipt.reused === true,
    createdAt: receipt.createdAt,
    ready: !!target && target.processEpoch === receipt.processEpoch && samePath(target.cwd, receipt.cwd),
    executionAuthority: 'not-granted',
    publicationAuthority: 'not-granted'
  };
}

function createWorkspaceProvisionProviderControl({ getState, saveState, broadcastState = () => {}, broker,
  repoRoot, now = () => Date.now(), idFactory = randomUUID } = {}) {
  if (typeof getState !== 'function' || typeof saveState !== 'function' || !broker?.createSession || !broker?.target)
    throw new TypeError('workspace provisioning requires state storage and the managed terminal broker');
  let root;
  try { root = fs.realpathSync(path.resolve(repoRoot)); }
  catch { throw new TypeError('workspace provisioning requires an accessible canonical repository root'); }

  function route(input, helpers = {}) {
    const action = String(input?.command?.action || '').toLowerCase();
    let result;
    let createdTarget = null;
    try {
      if (action !== ACTION) throw machineError('MACHINE_WORKSPACE_ACTION_UNKNOWN', 'Unknown workspace provisioning action.');
      if (!input.origin?.roomId || !input.origin?.executorMemberId || !input.origin?.agentMessageId)
        throw machineError('MACHINE_WORKSPACE_ORIGIN_REQUIRED', 'workspace_ensure must trail an exact committed Dex relay reply.');
      const snapshot = getState();
      const room = (snapshot?.rooms || []).find((entry) => entry.id === input.origin.roomId);
      if (!room) throw machineError('MACHINE_ROOM_NOT_FOUND', 'Originating Dex room no longer exists.');
      const middle = middleAgentFor(room);
      if (!middle || middle.id !== input.origin.executorMemberId)
        throw machineError('MACHINE_WORKSPACE_MIDDLE_AGENT_REQUIRED', 'Only this room\'s selected middle agent may request automatic workspace provisioning.');
      const machine = machineState(room);
      machine.provisionReceipts = Array.isArray(machine.provisionReceipts) ? machine.provisionReceipts : [];
      const requestId = bounded(input.requestId, 128);
      if (!requestId) throw machineError('MACHINE_WORKSPACE_REQUEST_REQUIRED', 'A stable request ID is required.');
      const prior = machine.provisionReceipts.find((entry) => entry.requestId === requestId);
      if (prior) {
        if (prior.actorMemberId !== middle.id)
          throw machineError('MACHINE_WORKSPACE_REQUEST_CONFLICT', 'This request ID belongs to another immutable provisioning request.');
        result = { ok: true, action, message: 'The existing workspace provisioning receipt was reused without creating another target.',
          data: { ...publicReceipt(prior, broker), idempotent: true } };
      } else {
        const activeSpaces = machine.spaces.filter((space) => space.archived !== true);
        const compatible = [];
        for (const space of activeSpaces) for (const targetId of (space.resourceIds || [])) {
          const target = broker.target(targetId);
          if (target && ['powershell', 'pwsh'].includes(target.type) && samePath(target.cwd, root)) compatible.push({ space, target });
        }
        if (compatible.length > 1)
          throw machineError('MACHINE_WORKSPACE_AMBIGUOUS', 'More than one EveOS-rooted PowerShell target is attached; choose an exact Machine Space manually.');
        let space, target, reused = false;
        if (compatible.length === 1) {
          ({ space, target } = compatible[0]); reused = true;
        } else {
          if (activeSpaces.length > 1)
            throw machineError('MACHINE_WORKSPACE_AMBIGUOUS', 'More than one active Machine Space exists and none has one reusable EveOS-rooted PowerShell target.');
          space = activeSpaces[0] || {
            id: `machine-space-${idFactory()}`, name: 'Autonomous Engineering', archived: false,
            resourceIds: [], requests: [], ledger: null, grant: null, fileGrants: [],
            createdAt: new Date(now()).toISOString()
          };
          if (!activeSpaces.length) machine.spaces.push(space);
          target = broker.createSession({ type: 'powershell', cwd: root, label: `Dex · ${bounded(room.name, 48) || 'Engineering'}` });
          createdTarget = target;
          space.resourceIds = Array.isArray(space.resourceIds) ? space.resourceIds : [];
          if (space.resourceIds.length)
            throw machineError('MACHINE_WORKSPACE_TARGET_CONFLICT', 'The selected Machine Space already contains a different target; automatic attachment refused.');
          space.resourceIds.push(target.id);
        }
        const receipt = {
          schema: RECEIPT_SCHEMA, requestId, roomId: room.id, spaceId: space.id,
          targetId: target.id, processEpoch: target.processEpoch, cwd: target.cwd,
          actorMemberId: middle.id, sourceMessageId: input.origin.agentMessageId,
          reused, createdAt: new Date(now()).toISOString()
        };
        machine.provisionReceipts.push(receipt);
        if (machine.provisionReceipts.length > MAX_RECEIPTS)
          machine.provisionReceipts.splice(0, machine.provisionReceipts.length - MAX_RECEIPTS);
        const saved = saveState(snapshot); broadcastState(saved);
        result = { ok: true, action,
          message: reused ? 'Reused the room\'s single compatible managed workspace.' : 'Provisioned one non-granted EveOS-rooted managed workspace.',
          data: { ...publicReceipt(receipt, broker), idempotent: false } };
      }
    } catch (error) {
      if (createdTarget?.id) { try { broker.stopSession?.(createdTarget.id); } catch {} }
      result = { ok: false, action, code: error.code || 'MACHINE_WORKSPACE_PROVISION_FAILED', message: error.message || 'Workspace provisioning failed.' };
    }
    const receipt = typeof helpers.commitOriginReceipt === 'function' && input.origin
      ? helpers.commitOriginReceipt(input.origin, result, input.requestId) : null;
    if (typeof helpers.sendResult === 'function') {
      helpers.sendResult({ sourceSocket: input.ws, requestId: input.requestId, source: input.source }, result, receipt);
      return true;
    }
    return result;
  }

  return { owns: (action) => String(action || '').toLowerCase() === ACTION, route };
}

module.exports = { ACTION, RECEIPT_SCHEMA, createWorkspaceProvisionProviderControl };
