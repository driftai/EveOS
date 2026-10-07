'use strict';

const { cleanCommand, commandDigest } = require('./approval-broker');
const { POLICY_ID, publicGrant } = require('./repo-safe-grant');

const PROVIDER_ACTIONS = new Set(['terminal_targets', 'terminal_exec', 'terminal_status', 'terminal_output']);

function createMachineSpacesProviderControl({
  getState,
  broker,
  approvals,
  spool,
  resolveRoomSpace,
  grantRecord,
  saveState,
  broadcastState,
  watchers,
  sendRoomSnapshot,
  execute,
  saveRequest,
  publicRequest,
  machineError,
  now,
  maxRequests = 64
}) {
  return {
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
            data: { roomId: room.id, spaceId: space.id, grant: publicGrant(space.grant), targets: (space.resourceIds || []).map((targetId) => {
              const target = broker.target(targetId); return target ? { id: target.id, title: target.title, type: target.type, busy: target.busy } : { id: targetId, available: false };
            }) } };
        } else if (action === 'terminal_exec') {
          const targetId = String(command.terminal || command.terminalId || '');
          const target = broker.target(targetId);
          if (!(space.resourceIds || []).includes(targetId) || !target)
            throw machineError('MACHINE_TARGET_NOT_ATTACHED', 'Choose an available terminal attached to this exact Machine Space.');
          const exactDigest = commandDigest(cleanCommand(String(command.command || '')));
          const existing = (space.requests || []).find((entry) => entry.requestId === requestId);
          if (existing) {
            if (existing.commandDigest !== exactDigest)
              throw machineError('MACHINE_REQUEST_ID_CONFLICT', 'This request ID already owns another terminal command.');
            result = { ok: true, action, message: `Terminal request already exists in state ${existing.state}.`, data: publicRequest(existing) };
          } else {
            const granted = grantRecord(space, target, command.command, requestId, room, origin);
            if (granted) {
              const request = {
                requestId,
                actorMemberId: origin.executorMemberId,
                actorName: origin.executorName,
                sourceMessageId: origin.agentMessageId,
                terminalId: targetId,
                command: granted.command,
                commandSummary: granted.commandSummary,
                commandDigest: granted.commandDigest,
                approvalId: null,
                grantId: granted.grantId,
                approvalMode: granted.approvalMode,
                approvedByMemberId: granted.approvedByMemberId,
                approvedByName: granted.approvedByName,
                risk: granted.risk,
                state: 'queued',
                createdAt: new Date(granted.createdAt).toISOString()
              };
              space.requests = Array.isArray(space.requests) ? space.requests : [];
              space.requests.push(request);
              if (space.requests.length > maxRequests) space.requests.splice(0, space.requests.length - maxRequests);
              const saved = saveState(snapshot); broadcastState(saved);
              for (const watcher of watchers) sendRoomSnapshot(watcher, room.id);
              void execute(granted).catch((error) => {
                try {
                  saveRequest(room.id, space.id, requestId, { state: 'failed', command: undefined,
                    finishedAt: new Date(now()).toISOString(), reason: error.code || 'grant-exec-failed' });
                  for (const watcher of watchers) sendRoomSnapshot(watcher, room.id);
                } catch {}
              });
              result = { ok: true, action, message: `Terminal command auto-approved by ${POLICY_ID}; use terminal_status for completion.`,
                data: { roomId: room.id, spaceId: space.id, request: publicRequest(request), grant: publicGrant(space.grant) } };
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
              if (space.requests.length > maxRequests) space.requests.splice(0, space.requests.length - maxRequests);
              const saved = saveState(snapshot); broadcastState(saved);
              for (const watcher of watchers) sendRoomSnapshot(watcher, room.id);
              result = { ok: true, action, message: 'Terminal command is pending one-time approval from Drift; nothing executed yet.',
                data: { roomId: room.id, spaceId: space.id, request: publicRequest(request) } };
            }
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
}

module.exports = { PROVIDER_ACTIONS, createMachineSpacesProviderControl };
