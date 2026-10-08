'use strict';

const { cleanCommand, commandDigest } = require('./approval-broker');
const { POLICY_ID, publicGrant } = require('./repo-safe-grant');
const {
  MUTATING_CAPABILITIES,
  authorizeCapabilityGrant,
  publicCapabilityGrant
} = require('./capability-grant');
const { operationDigest } = require('./filesystem-broker');
const ledgerApi = require('./operation-ledger');

const TERMINAL_ACTIONS = new Set(['terminal_targets', 'terminal_exec', 'terminal_status', 'terminal_output']);
const FILE_ACTIONS = new Set([
  'files_grants', 'files_status', 'files_list', 'files_tree', 'files_stat', 'files_read', 'files_search',
  'files_create', 'files_write', 'files_patch', 'files_move', 'files_delete'
]);
const PROVIDER_ACTIONS = new Set([...TERMINAL_ACTIONS, ...FILE_ACTIONS]);
const FILE_CAPABILITY_BY_ACTION = Object.freeze({
  files_list: 'files.list',
  files_tree: 'files.list',
  files_stat: 'files.stat',
  files_read: 'files.read',
  files_search: 'files.search',
  files_create: 'files.create',
  files_write: 'files.write',
  files_patch: 'files.patch',
  files_move: 'files.move',
  files_delete: 'files.delete'
});

function boundedInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}
function fileRequestProjection(request = {}) {
  return {
    requestId: request.requestId || null,
    actorMemberId: request.actorMemberId || null,
    actorName: request.actorName || 'Agent',
    sourceMessageId: request.sourceMessageId || null,
    terminalId: request.terminalId || null,
    grantId: request.grantId || null,
    capability: request.capability || null,
    operationDigest: request.operationDigest || null,
    operationSummary: request.operationSummary || '',
    state: request.state || 'queued',
    resultSummary: request.resultSummary || '',
    errorCode: request.errorCode || null,
    createdAt: request.createdAt || null,
    finishedAt: request.finishedAt || null
  };
}
function fileOperation(action, command = {}) {
  if (action === 'files_list') return { action, path: command.path || '', offset: command.offset || 0, limit: command.limit || 100 };
  if (action === 'files_tree') return { action, path: command.path || '', depth: command.depth || 2, limit: command.limit || 500 };
  if (action === 'files_stat') return { action, path: command.path || '' };
  if (action === 'files_read') return { action, path: command.path || '', offset: command.offset || 0, limit: command.limit || 8000 };
  if (action === 'files_search') return { action, query: command.query || '', path: command.path || '', caseSensitive: command.caseSensitive === true,
    maxFiles: command.maxFiles || 250, maxResults: command.maxResults || 50 };
  if (action === 'files_create') return { action, path: command.path || '', content: String(command.content ?? '') };
  if (action === 'files_write') return { action, path: command.path || '', content: String(command.content ?? ''), expectedSha256: command.expectedSha256 || '' };
  if (action === 'files_patch') return { action, path: command.path || '', before: String(command.before ?? ''), after: String(command.after ?? ''), expectedSha256: command.expectedSha256 || '' };
  if (action === 'files_move') return { action, source: command.source || '', destination: command.destination || '', expectedSha256: command.expectedSha256 || '' };
  if (action === 'files_delete') return { action, path: command.path || '', expectedSha256: command.expectedSha256 || '' };
  return { action };
}
function fileSummary(operation = {}) {
  if (operation.action === 'files_search') return `search ${JSON.stringify(operation.query).slice(0, 80)} in ${operation.path || '.'}`;
  if (operation.action === 'files_move') return `move ${operation.source} -> ${operation.destination}`;
  return `${operation.action.replace(/^files_/, '')} ${operation.path || '.'}`;
}
function runFileOperation(files, root, operation) {
  if (operation.action === 'files_list') return files.list(root, operation.path, { offset: operation.offset, limit: boundedInt(operation.limit, 1, 500, 100) });
  if (operation.action === 'files_tree') return files.tree(root, operation.path, { depth: boundedInt(operation.depth, 0, 6, 2), limit: boundedInt(operation.limit, 1, 2000, 500) });
  if (operation.action === 'files_stat') return files.stat(root, operation.path);
  if (operation.action === 'files_read') return files.read(root, operation.path, { offset: operation.offset, limit: boundedInt(operation.limit, 1, 8000, 8000) });
  if (operation.action === 'files_search') return files.search(root, operation.query, { path: operation.path,
    caseSensitive: operation.caseSensitive, maxFiles: boundedInt(operation.maxFiles, 1, 800, 250), maxResults: boundedInt(operation.maxResults, 1, 50, 50) });
  if (operation.action === 'files_create') return files.create(root, operation.path, operation.content);
  if (operation.action === 'files_write') return files.write(root, operation.path, operation.content, operation.expectedSha256);
  if (operation.action === 'files_patch') return files.patch(root, operation.path, operation.before, operation.after, operation.expectedSha256);
  if (operation.action === 'files_move') return files.move(root, operation.source, operation.destination, operation.expectedSha256);
  if (operation.action === 'files_delete') return files.remove(root, operation.path, operation.expectedSha256);
  throw Object.assign(new Error('Unknown filesystem operation.'), { code: 'MACHINE_FILE_ACTION_UNKNOWN' });
}
function resultSummary(action, data) {
  if (action === 'files_read') return `${data.bytes} byte(s) read from ${data.path}`;
  if (action === 'files_search') return `${data.results.length} match(es) across ${data.scannedFiles} file(s)`;
  if (action === 'files_list' || action === 'files_tree') return `${data.entries.length} entr${data.entries.length === 1 ? 'y' : 'ies'} from ${data.path}`;
  if (action === 'files_stat') return `${data.type} ${data.path}`;
  if (action === 'files_move') return `moved ${data.source} to ${data.destination}`;
  return `${action.replace(/^files_/, '')} ${data.path || ''}`.trim();
}

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
  maxRequests = 64,
  filesystem = null
}) {
  function saveSnapshot(snapshot, roomId) {
    const saved = saveState(snapshot); broadcastState(saved);
    for (const watcher of watchers) sendRoomSnapshot(watcher, roomId);
  }

  function routeFiles({ action, command, requestId, origin, boundRoomId, snapshot }) {
    const roomId = origin?.roomId || boundRoomId;
    if (!roomId) throw machineError('MACHINE_ROOM_REQUIRED', 'Name one exact authorized room with "room".');
    const room = (snapshot?.rooms || []).find((entry) => entry.id === roomId);
    if (!room) throw machineError('MACHINE_ROOM_NOT_FOUND', 'Originating Dex room no longer exists.');
    const space = resolveRoomSpace(room, command.space);
    space.fileGrants = Array.isArray(space.fileGrants) ? space.fileGrants : [];
    space.fileRequests = Array.isArray(space.fileRequests) ? space.fileRequests : [];

    if (action === 'files_grants') {
      return { ok: true, action, message: `Machine Space ${space.name} has ${space.fileGrants.length} filesystem grant record(s).`,
        data: { roomId: room.id, spaceId: space.id, grants: space.fileGrants.map(publicCapabilityGrant) } };
    }
    if (action === 'files_status') {
      const wanted = String(command.requestId || '');
      const request = space.fileRequests.find((entry) => entry.requestId === wanted);
      if (!request) throw machineError('MACHINE_FILE_REQUEST_NOT_FOUND', 'No filesystem request with that ID exists in this Machine Space.');
      return { ok: true, action, message: `Filesystem request is ${request.state}.`, data: fileRequestProjection(request) };
    }
    if (!filesystem?.broker || typeof filesystem.repoRootResolver !== 'function')
      throw machineError('MACHINE_FILES_UNAVAILABLE', 'Filesystem capabilities are not configured on this Nexus runtime.');
    if (!origin?.roomId)
      throw machineError('MACHINE_ORIGIN_REQUIRED', `${action} must trail a reply to a Dex relay turn so the file operation has exact provenance.`);

    const capability = FILE_CAPABILITY_BY_ACTION[action];
    if (!capability) throw machineError('MACHINE_FILE_ACTION_UNKNOWN', 'Unknown filesystem provider action.');
    const targetId = String(command.terminal || command.terminalId || '');
    const target = broker.target(targetId);
    if (!(space.resourceIds || []).includes(targetId) || !target)
      throw machineError('MACHINE_TARGET_NOT_ATTACHED', 'Choose an available terminal attached to this exact Machine Space for filesystem root context.');
    const repoRoot = filesystem.repoRootResolver(target.cwd);
    const operation = fileOperation(action, command);
    const digest = operationDigest(operation);
    const existing = space.fileRequests.find((entry) => entry.requestId === requestId);
    if (existing) {
      if (existing.operationDigest !== digest)
        throw machineError('MACHINE_REQUEST_ID_CONFLICT', 'This request ID already owns another immutable filesystem operation.');
      return { ok: true, action, message: `Filesystem request already exists in state ${existing.state}; it was not replayed.`, data: fileRequestProjection(existing) };
    }

    let grant = null, authorization = null;
    const wantedGrant = String(command.grant || command.grantId || '');
    const candidates = wantedGrant ? space.fileGrants.filter((entry) => entry.id === wantedGrant) : space.fileGrants;
    for (const candidate of candidates) {
      const check = authorizeCapabilityGrant(candidate, { repoRoot, targetId, capability, now, consume: false });
      if (check.allowed) { grant = candidate; authorization = check; break; }
    }
    if (!grant || !authorization?.allowed)
      throw machineError('MACHINE_FILE_GRANT_REQUIRED', `No active local ${capability} grant covers terminal ${targetId} and repository ${repoRoot}.`);

    // Request-ID conflict checks happen before a one-shot grant is consumed. From
    // this point on, one-shot authority is spent even if the filesystem rejects a
    // stale hash or other precondition; never retry an uncertain mutation blindly.
    authorizeCapabilityGrant(grant, { repoRoot, targetId, capability, now, consume: true });
    const request = {
      requestId,
      actorMemberId: origin.executorMemberId,
      actorName: origin.executorName,
      sourceMessageId: origin.agentMessageId,
      terminalId: targetId,
      grantId: grant.id,
      capability,
      operationDigest: digest,
      operationSummary: fileSummary(operation),
      state: 'queued',
      resultSummary: '',
      errorCode: null,
      createdAt: new Date(now()).toISOString(),
      finishedAt: null
    };
    space.fileRequests.push(request);
    if (space.fileRequests.length > maxRequests) space.fileRequests.splice(0, space.fileRequests.length - maxRequests);
    space.ledger ||= ledgerApi.createLedger({ roomId: room.id, spaceId: space.id });
    ledgerApi.recordRequest(space.ledger, {
      roomId: room.id, spaceId: space.id, requestId,
      actorMemberId: origin.executorMemberId, sourceMessageId: origin.agentMessageId,
      terminalId: targetId, grantId: grant.id, capability, operationDigest: digest,
      commandSummary: request.operationSummary, createdAt: request.createdAt
    }, () => true);
    ledgerApi.markRunning(space.ledger, requestId);
    request.state = 'running';
    saveSnapshot(snapshot, room.id);

    try {
      const data = runFileOperation(filesystem.broker, repoRoot, operation);
      request.state = 'completed';
      request.resultSummary = resultSummary(action, data);
      request.finishedAt = new Date(now()).toISOString();
      ledgerApi.settle(space.ledger, { requestId, state: 'completed', outputId: `file-result:${requestId}`,
        preview: request.resultSummary, bytes: Number.isSafeInteger(data.bytes) ? data.bytes : null, finishedAt: request.finishedAt });
      saveSnapshot(snapshot, room.id);
      return { ok: true, action, message: request.resultSummary,
        data: { roomId: room.id, spaceId: space.id, request: fileRequestProjection(request), result: data,
          grant: publicCapabilityGrant(grant) } };
    } catch (error) {
      request.state = 'failed';
      request.errorCode = error.code || 'MACHINE_FILE_OPERATION_FAILED';
      request.resultSummary = String(error.message || 'Filesystem operation failed.').slice(0, 400);
      request.finishedAt = new Date(now()).toISOString();
      ledgerApi.settle(space.ledger, { requestId, state: 'failed', outputId: `file-result:${requestId}`,
        preview: request.resultSummary, finishedAt: request.finishedAt });
      saveSnapshot(snapshot, room.id);
      const wrapped = machineError(request.errorCode, request.resultSummary);
      wrapped.request = fileRequestProjection(request);
      throw wrapped;
    }
  }

  return {
    owns: (action) => PROVIDER_ACTIONS.has(String(action || '').toLowerCase()),
    route({ source, command, requestId, ws, origin, boundRoomId = null }, { sendResult, commitOriginReceipt }) {
      let result;
      try {
        const snapshot = getState();
        const action = String(command.action || '').toLowerCase();
        if (FILE_ACTIONS.has(action)) {
          result = routeFiles({ action, command, requestId, origin, boundRoomId, snapshot });
        } else {
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
        }
        const receipt = commitOriginReceipt(origin, result, requestId);
        sendResult({ sourceSocket: ws, requestId, source }, result, receipt);
      } catch (error) {
        result = { ok: false, code: error.code || 'MACHINE_CONTROL_FAILED', message: error.message,
          ...(error.request ? { data: { request: error.request } } : {}) };
        const receipt = commitOriginReceipt(origin, result, requestId);
        sendResult({ sourceSocket: ws, requestId, source }, result, receipt);
      }
      return true;
    }
  };
}

module.exports = { TERMINAL_ACTIONS, FILE_ACTIONS, PROVIDER_ACTIONS, FILE_CAPABILITY_BY_ACTION, fileRequestProjection, createMachineSpacesProviderControl };
