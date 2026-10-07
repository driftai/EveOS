'use strict';

const { randomUUID } = require('node:crypto');
const { createManagedTerminalBroker } = require('./managed-terminal-broker');
const { createApprovalBroker, commandDigest } = require('./approval-broker');
const { createOutputSpool } = require('./output-spool');
const ledgerApi = require('./operation-ledger');

const PROVIDER_ACTIONS = new Set(['terminal_targets', 'terminal_exec', 'terminal_status', 'terminal_output']);
const MAX_SPACES = 12, MAX_REQUESTS = 64;

function machineError(code, message) { return Object.assign(new Error(message), { code }); }
function cleanName(value, fallback, max = 80) {
  return String(value || fallback).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) || fallback;
}
function id(prefix) { return `${prefix}-${randomUUID()}`; }
function machineState(room) {
  if (!room.machineSpaces || typeof room.machineSpaces !== 'object') {
    room.machineSpaces = { version: 1, spaces: [] };
  }
  room.machineSpaces.spaces = Array.isArray(room.machineSpaces.spaces) ? room.machineSpaces.spaces : [];
  return room.machineSpaces;
}
function findSpace(room, reference = '') {
  const spaces = machineState(room).spaces.filter((space) => space.archived !== true);
  if (!reference) return spaces.length === 1 ? spaces[0] : null;
  const wanted = String(reference).trim().toLowerCase();
  return spaces.find((space) => space.id === reference)
    || spaces.find((space) => String(space.name || '').trim().toLowerCase() === wanted) || null;
}
function publicRequest(request = {}) {
  return {
    requestId: request.requestId,
    actorMemberId: request.actorMemberId || null,
    actorName: request.actorName || 'Agent',
    sourceMessageId: request.sourceMessageId || null,
    terminalId: request.terminalId,
    commandSummary: request.commandSummary || '',
    commandDigest: request.commandDigest || '',
    approvalId: request.approvalId || null,
    risk: request.risk || null,
    challenge: request.challenge || '',
    state: request.state || 'approval-required',
    outputId: request.outputId || null,
    preview: request.preview || '',
    bytes: Number.isSafeInteger(request.bytes) ? request.bytes : null,
    exitCode: Number.isInteger(request.exitCode) ? request.exitCode : null,
    reason: request.reason || null,
    createdAt: request.createdAt || null,
    finishedAt: request.finishedAt || null
  };
}
function ownerRequest(request = {}) { return { ...publicRequest(request), command: String(request.command || '') }; }

function createMachineSpacesController({
  safeSend,
  uiSockets = new Set(),
  getState = () => null,
  saveState = (value) => value,
  broadcastState = () => {},
  broker = createManagedTerminalBroker(),
  approvals = createApprovalBroker(),
  spool = createOutputSpool(),
  now = () => Date.now()
} = {}) {
  const watchers = new Set();
  const ownerIds = new WeakMap();
  const selected = new WeakMap();
  const ownerId = (ws, claim = '') => {
    const candidate = String(claim || '');
    if (candidate && !/^machine-owner-[A-Za-z0-9-]{8,96}$/.test(candidate))
      throw machineError('MACHINE_BAD_OWNER', 'Invalid local Machine Spaces owner identity.');
    if (!ownerIds.has(ws)) ownerIds.set(ws, candidate || id('machine-owner'));
    if (candidate && ownerIds.get(ws) !== candidate)
      throw machineError('MACHINE_OWNER_CHANGED', 'Machine Spaces owner identity cannot change on one connection.');
    return ownerIds.get(ws);
  };
  const send = (ws, payload) => safeSend?.(ws, payload);
  const shellTypes = broker.availableTypes().map((type) => ({ id: type, name: type === 'cmd' ? 'Command Prompt'
    : type === 'powershell' ? 'Windows PowerShell' : type === 'pwsh' ? 'PowerShell 7' : 'WSL Bash' }));

  function targetSnapshot(ws = null) {
    const targets = broker.listTargets();
    const selectedId = ws ? selected.get(ws) || null : null;
    return { type: 'machine_targets_update', targetClassId: 'terminal-origin', targetTypes: shellTypes,
      targets, selectedTarget: targets.find((target) => target.id === selectedId) || null };
  }
  function broadcastTargets() {
    for (const ws of [...watchers]) {
      if (!uiSockets.has(ws)) { watchers.delete(ws); continue; }
      send(ws, targetSnapshot(ws));
    }
  }
  function mutateRoom(roomId, action) {
    const snapshot = getState();
    const room = (snapshot?.rooms || []).find((entry) => entry.id === roomId);
    if (!room) throw machineError('MACHINE_ROOM_NOT_FOUND', 'Dex room no longer exists.');
    const value = action(room, snapshot);
    const saved = saveState(snapshot);
    broadcastState(saved);
    return value;
  }
  function createSpace(room, name) {
    const machine = machineState(room);
    if (machine.spaces.filter((space) => space.archived !== true).length >= MAX_SPACES)
      throw machineError('MACHINE_SPACE_LIMIT', 'Archive another Machine Space before creating a new one.');
    const space = { id: id('machine-space'), name: cleanName(name, `Machine Space ${machine.spaces.length + 1}`),
      archived: false, resourceIds: [], requests: [], ledger: null, createdAt: new Date(now()).toISOString() };
    machine.spaces.push(space);
    return space;
  }
  function resolveRoomSpace(room, reference, { createDefault = false } = {}) {
    let space = findSpace(room, reference);
    if (!space && createDefault && machineState(room).spaces.filter((entry) => entry.archived !== true).length === 0) {
      space = createSpace(room, 'Machine Space');
    }
    if (!space) throw machineError('MACHINE_SPACE_REQUIRED', 'Choose one exact active Machine Space.');
    return space;
  }
  function roomView(room) {
    return {
      roomId: room.id,
      roomName: room.name,
      spaces: machineState(room).spaces.map((space) => ({
        id: space.id,
        name: space.name,
        archived: space.archived === true,
        resources: (space.resourceIds || []).map((terminalId) => {
          const target = broker.target(terminalId);
          return target ? { ...target, available: true } : { id: terminalId, targetId: terminalId, available: false };
        }),
        requests: (space.requests || []).slice(-MAX_REQUESTS).map(ownerRequest)
      }))
    };
  }
  function sendRoomSnapshot(ws, roomId) {
    const room = (getState()?.rooms || []).find((entry) => entry.id === roomId);
    if (!room) return send(ws, { type: 'machine_room_snapshot', roomId, spaces: [] });
    return send(ws, { type: 'machine_room_snapshot', ...roomView(room) });
  }
  function saveRequest(roomId, spaceId, requestId, change) {
    return mutateRoom(roomId, (room) => {
      const space = resolveRoomSpace(room, spaceId);
      const request = (space.requests || []).find((entry) => entry.requestId === requestId);
      if (!request) throw machineError('MACHINE_REQUEST_NOT_FOUND', 'Machine request no longer exists.');
      Object.assign(request, change);
      return publicRequest(request);
    });
  }
  function executionPreview(result) {
    const text = `${result.stdout || ''}${result.stdout && result.stderr ? '\n' : ''}${result.stderr || ''}`;
    return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, 400);
  }

  async function execute(record, notifyWs = null) {
    const target = broker.target(record.targetId);
    if (!target) throw machineError('MACHINE_TARGET_NOT_FOUND', 'Managed terminal no longer exists.');
    const context = record.context || {};
    const audience = context.kind === 'dex' ? `room:${context.roomId}` : `owner:${record.ownerId}`;
    if (context.kind === 'dex') {
      mutateRoom(context.roomId, (room) => {
        const space = resolveRoomSpace(room, context.spaceId);
        if (!(space.resourceIds || []).includes(record.targetId)) throw machineError('MACHINE_TARGET_NOT_ATTACHED', 'Terminal is not attached to this Machine Space.');
        space.ledger ||= ledgerApi.createLedger({ roomId: room.id, spaceId: space.id });
        ledgerApi.recordRequest(space.ledger, {
          roomId: room.id, spaceId: space.id, requestId: record.requestId,
          actorMemberId: context.actorMemberId, sourceMessageId: context.sourceMessageId,
          terminalId: record.targetId, grantId: record.approvalId,
          capability: 'terminal.exec', operationDigest: record.commandDigest,
          commandSummary: record.commandSummary, createdAt: new Date(record.createdAt).toISOString()
        }, () => true);
        ledgerApi.markRunning(space.ledger, record.requestId);
        const request = (space.requests || []).find((entry) => entry.requestId === record.requestId);
        if (request) { request.state = 'running'; delete request.command; delete request.challenge; }
      });
    }
    send(notifyWs, { type: 'machine_command_started', requestId: record.requestId, targetId: record.targetId });
    broadcastTargets();
    let result;
    try {
      result = await broker.run({ targetId: record.targetId, requestId: record.requestId,
        command: record.command, onStart: ({ pid, startedAt }) => send(notifyWs,
          { type: 'machine_process_started', requestId: record.requestId, targetId: record.targetId, pid, startedAt }) });
    } catch (error) {
      result = { requestId: record.requestId, targetId: record.targetId, stdout: '', stderr: error.message,
        bytes: Buffer.byteLength(error.message), exitCode: null, state: 'failed', reason: error.code || 'spawn-failed',
        startedAt: new Date(now()).toISOString(), finishedAt: new Date(now()).toISOString() };
    }
    const output = spool.store({ ...result, audience });
    const complete = { type: 'machine_command_complete', requestId: record.requestId,
      targetId: record.targetId, outputId: output.outputId, preview: executionPreview(result),
      bytes: output.bytes, exitCode: result.exitCode, state: result.state, reason: result.reason || null,
      finishedAt: result.finishedAt };
    if (context.kind === 'dex') {
      mutateRoom(context.roomId, (room) => {
        const space = resolveRoomSpace(room, context.spaceId);
        ledgerApi.settle(space.ledger, { requestId: record.requestId, state: result.state,
          outputId: output.outputId, preview: complete.preview, bytes: output.bytes,
          exitCode: result.exitCode, finishedAt: result.finishedAt });
        const request = (space.requests || []).find((entry) => entry.requestId === record.requestId);
        if (request) Object.assign(request, complete, { type: undefined });
      });
      for (const ws of watchers) sendRoomSnapshot(ws, context.roomId);
    }
    send(notifyWs, complete);
    broadcastTargets();
    return complete;
  }

  function prepareBase(ws, msg) {
    const targetId = String(msg.targetId || selected.get(ws) || '');
    if (!broker.target(targetId)) throw machineError('MACHINE_TARGET_NOT_FOUND', 'Choose a managed terminal first.');
    const prepared = approvals.prepare({ ownerId: ownerId(ws), targetId,
      requestId: String(msg.requestId || id('machine-request')), command: msg.command,
      context: { kind: 'base', ownerWs: ws } });
    send(ws, { type: 'machine_command_prepared', ...prepared,
      command: approvals.peek(prepared.approvalId).command, cwd: broker.target(targetId).cwd });
  }
  function approve(ws, msg) {
    const pending = approvals.peek(msg.approvalId);
    if (!pending) throw machineError('MACHINE_APPROVAL_INVALID', 'Approval expired; prepare the command again.');
    const context = pending.context || {};
    const expectedOwner = context.kind === 'dex' ? `room:${context.roomId}` : ownerId(ws);
    const decision = approvals.decide({ ownerId: expectedOwner, approvalId: msg.approvalId,
      decision: msg.decision, challenge: msg.challenge });
    if (!decision.allowed) {
      if (context.kind === 'dex') {
        saveRequest(context.roomId, context.spaceId, pending.requestId,
          { state: 'denied', command: undefined, challenge: '', finishedAt: new Date(now()).toISOString(), reason: 'owner-denied' });
        for (const watcher of watchers) sendRoomSnapshot(watcher, context.roomId);
      }
      send(ws, { type: 'machine_command_denied', requestId: pending.requestId, targetId: pending.targetId });
      return;
    }
    void execute(decision.record, context.kind === 'base' ? ws : null).catch((error) => {
      send(ws, { type: 'error', requestId: pending.requestId, code: error.code || 'MACHINE_EXEC_FAILED', message: error.message });
    });
  }

  function attach(roomId, spaceRef, targetId) {
    return mutateRoom(roomId, (room) => {
      const target = broker.target(targetId);
      if (!target) throw machineError('MACHINE_TARGET_NOT_FOUND', 'Managed terminal no longer exists.');
      const space = resolveRoomSpace(room, spaceRef, { createDefault: true });
      space.resourceIds = Array.isArray(space.resourceIds) ? space.resourceIds : [];
      if (!space.resourceIds.includes(target.id)) space.resourceIds.push(target.id);
      return { roomId: room.id, spaceId: space.id, target };
    });
  }
  function stopTarget(targetId) {
    const stopped = broker.stopSession(targetId);
    if (!stopped) throw machineError('MACHINE_TARGET_NOT_FOUND', 'Managed terminal no longer exists.');
    const snapshot = getState();
    for (const room of snapshot?.rooms || []) for (const space of machineState(room).spaces) {
      space.resourceIds = (space.resourceIds || []).filter((idValue) => idValue !== targetId);
    }
    if (snapshot) { const saved = saveState(snapshot); broadcastState(saved); }
    for (const ws of watchers) if (selected.get(ws) === targetId) selected.delete(ws);
    broadcastTargets();
  }

  async function handle(ws, msg = {}) {
    const type = String(msg.type || '');
    if (!type.startsWith('machine_') && type !== 'request_machine_targets') return false;
    try {
      if (type === 'request_machine_targets') { ownerId(ws, msg.ownerId); watchers.add(ws); send(ws, targetSnapshot(ws)); return true; }
      if (type === 'machine_create_target') {
        const target = broker.createSession({ type: msg.targetType, label: msg.label, cwd: msg.cwd });
        selected.set(ws, target.id); watchers.add(ws); broadcastTargets(); return true;
      }
      if (type === 'machine_select_target') {
        const target = broker.target(msg.targetId);
        if (!target) throw machineError('MACHINE_TARGET_NOT_FOUND', 'Managed terminal no longer exists.');
        selected.set(ws, target.id); watchers.add(ws); send(ws, targetSnapshot(ws)); return true;
      }
      if (type === 'machine_stop_target') { stopTarget(String(msg.targetId || selected.get(ws) || '')); return true; }
      if (type === 'machine_interrupt') {
        if (!broker.interrupt(String(msg.targetId || selected.get(ws) || '')))
          throw machineError('MACHINE_NOT_RUNNING', 'No command is currently running on this terminal.');
        return true;
      }
      if (type === 'machine_prepare_command') { prepareBase(ws, msg); return true; }
      if (type === 'machine_approve_command') { approve(ws, msg); return true; }
      if (type === 'machine_output_page') {
        const roomAudience = msg.roomId ? `room:${msg.roomId}` : `owner:${ownerId(ws)}`;
        send(ws, { type: 'machine_output_page', ...spool.page(msg.outputId,
          { audience: roomAudience, stream: msg.stream, offset: msg.offset, limit: msg.limit }) });
        return true;
      }
      if (type === 'machine_room_snapshot') { watchers.add(ws); sendRoomSnapshot(ws, String(msg.roomId || '')); return true; }
      if (type === 'machine_create_space') {
        const value = mutateRoom(String(msg.roomId || ''), (room) => createSpace(room, msg.name));
        send(ws, { type: 'machine_space_created', roomId: msg.roomId, space: value });
        sendRoomSnapshot(ws, String(msg.roomId || '')); return true;
      }
      if (type === 'machine_archive_space') {
        mutateRoom(String(msg.roomId || ''), (room) => {
          const space = resolveRoomSpace(room, msg.spaceId);
          if ((space.requests || []).some((entry) => ['approval-required', 'running'].includes(entry.state)))
            throw machineError('MACHINE_SPACE_BUSY', 'Wait for pending/running terminal requests before archiving.');
          space.archived = true;
        });
        sendRoomSnapshot(ws, String(msg.roomId || '')); return true;
      }
      if (type === 'machine_attach_target') {
        attach(String(msg.roomId || ''), msg.spaceId, String(msg.targetId || ''));
        sendRoomSnapshot(ws, String(msg.roomId || '')); return true;
      }
      if (type === 'machine_detach_target') {
        mutateRoom(String(msg.roomId || ''), (room) => {
          const space = resolveRoomSpace(room, msg.spaceId);
          if ((space.requests || []).some((entry) => entry.terminalId === msg.targetId && entry.state === 'running'))
            throw machineError('MACHINE_TARGET_BUSY', 'A running command still owns this resource.');
          space.resourceIds = (space.resourceIds || []).filter((value) => value !== msg.targetId);
        });
        sendRoomSnapshot(ws, String(msg.roomId || '')); return true;
      }
      return false;
    } catch (error) {
      send(ws, { type: 'error', requestId: msg.requestId || null,
        code: error.code || 'MACHINE_COMMAND_FAILED', message: error.message });
      return true;
    }
  }

  const providerControl = {
    owns: (action) => PROVIDER_ACTIONS.has(String(action || '').toLowerCase()),
    route({ source, command, requestId, ws, origin, boundRoomId = null }, { sendResult, commitOriginReceipt }) {
      let result;
      try {
        const snapshot = getState();
        const action = String(command.action || '').toLowerCase();
        // terminal_exec needs a relay-turn origin for its audit provenance; read-only
        // lookups outside a relay turn use the caller's one exact bound room.
        if (!origin?.roomId && action === 'terminal_exec')
          throw machineError('MACHINE_ORIGIN_REQUIRED', 'terminal_exec must trail a reply to a Dex relay turn so the request has an exact originating message.');
        const roomId = origin?.roomId || boundRoomId;
        if (!roomId) throw machineError('MACHINE_ROOM_REQUIRED', 'Name one exact authorized room with "room".');
        const room = (snapshot?.rooms || []).find((entry) => entry.id === roomId);
        if (!room) throw machineError('MACHINE_ROOM_NOT_FOUND', 'Originating Dex room no longer exists.');
        const space = resolveRoomSpace(room, command.space);
        if (action === 'terminal_targets') {
          result = { ok: true, action, message: `Machine Space ${space.name} has ${(space.resourceIds || []).length} terminal resource(s).`,
            data: { roomId: room.id, spaceId: space.id, targets: (space.resourceIds || []).map((targetId) => {
              const target = broker.target(targetId); return target ? { id: target.id, title: target.title, type: target.type, busy: target.busy } : { id: targetId, available: false };
            }) } };
        } else if (action === 'terminal_exec') {
          const targetId = String(command.terminal || command.terminalId || '');
          if (!(space.resourceIds || []).includes(targetId) || !broker.target(targetId))
            throw machineError('MACHINE_TARGET_NOT_ATTACHED', 'Choose an available terminal attached to this exact Machine Space.');
          const existing = (space.requests || []).find((entry) => entry.requestId === requestId);
          if (existing) {
            if (existing.commandDigest !== commandDigest(String(command.command || '')))
              throw machineError('MACHINE_REQUEST_ID_CONFLICT', 'This request ID already owns another terminal command.');
            result = { ok: true, action, message: `Terminal request already exists in state ${existing.state}.`, data: publicRequest(existing) };
          } else {
            const prepared = approvals.prepare({ ownerId: `room:${room.id}`, targetId, requestId,
              command: command.command, context: { kind: 'dex', roomId: room.id, spaceId: space.id,
                actorMemberId: origin.executorMemberId, actorName: origin.executorName,
                sourceMessageId: origin.agentMessageId } });
            const request = { ...prepared, command: approvals.peek(prepared.approvalId).command,
              actorMemberId: origin.executorMemberId,
              actorName: origin.executorName, sourceMessageId: origin.agentMessageId,
              terminalId: targetId, state: 'approval-required', createdAt: new Date(now()).toISOString() };
            space.requests = Array.isArray(space.requests) ? space.requests : [];
            space.requests.push(request);
            if (space.requests.length > MAX_REQUESTS) space.requests.splice(0, space.requests.length - MAX_REQUESTS);
            const saved = saveState(snapshot); broadcastState(saved);
            for (const watcher of watchers) sendRoomSnapshot(watcher, room.id);
            result = { ok: true, action, message: 'Terminal command is pending one-time approval from Drift; nothing executed yet.',
              data: { roomId: room.id, spaceId: space.id, request: publicRequest(request) } };
          }
        } else if (action === 'terminal_status') {
          const wanted = String(command.requestId || '');
          const request = (space.requests || []).find((entry) => entry.requestId === wanted);
          if (!request) throw machineError('MACHINE_REQUEST_NOT_FOUND', 'No terminal request with that ID exists in this Machine Space.');
          result = { ok: true, action, message: `Terminal request is ${request.state}.`, data: publicRequest(request) };
        } else {
          const page = spool.page(String(command.outputId || ''), { audience: `room:${room.id}`,
            stream: command.stream, offset: command.offset, limit: Math.min(8000, Number(command.limit) || 4000) });
          result = { ok: true, action, message: 'Returned a bounded terminal output page.', data: page };
        }
        const receipt = commitOriginReceipt(origin, result, requestId);
        sendResult({ sourceSocket: ws, requestId, source }, result, receipt);
      } catch (error) {
        result = { ok: false, code: error.code || 'MACHINE_CONTROL_FAILED', message: error.message };
        const receipt = commitOriginReceipt(origin, result, requestId);
        sendResult({ sourceSocket: ws, requestId, source }, result, receipt);
      }
      return true;
    }
  };

  return {
    handle,
    providerControl,
    publicTargetClasses: () => [{ id: 'terminal-origin', name: 'Terminal Targets' }],
    publicTargetTypes: () => shellTypes,
    snapshot: targetSnapshot,
    stop() { broker.stopAll(); watchers.clear(); },
    broker,
    approvals,
    spool
  };
}

module.exports = {
  PROVIDER_ACTIONS,
  MAX_SPACES,
  MAX_REQUESTS,
  machineState,
  findSpace,
  publicRequest,
  createMachineSpacesController
};
