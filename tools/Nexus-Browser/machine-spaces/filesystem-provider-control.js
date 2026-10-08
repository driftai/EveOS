'use strict';

const { authorizeCapabilityGrant, publicCapabilityGrant } = require('./capability-grant');
const { operationDigest } = require('./filesystem-broker');
const ledgerApi = require('./operation-ledger');

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

function machineError(code, message, data = null) {
  const error = Object.assign(new Error(message), { code });
  if (data) error.data = data;
  return error;
}
function machineState(room) {
  if (!room.machineSpaces || typeof room.machineSpaces !== 'object') room.machineSpaces = { version: 1, spaces: [] };
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
function shape(space) {
  space.resourceIds = Array.isArray(space.resourceIds) ? space.resourceIds : [];
  space.fileGrants = Array.isArray(space.fileGrants) ? space.fileGrants : [];
  space.fileRequests = Array.isArray(space.fileRequests) ? space.fileRequests : [];
  return space;
}
function boundedInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}
function projection(request = {}) {
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
function operationFor(action, command = {}) {
  if (action === 'files_list') return { action, path: command.path || '', offset: command.offset || 0, limit: command.limit || 100 };
  if (action === 'files_tree') return { action, path: command.path || '', depth: command.depth || 2, limit: command.limit || 500 };
  if (action === 'files_stat') return { action, path: command.path || '' };
  if (action === 'files_read') return { action, path: command.path || '', offset: command.offset || 0, limit: command.limit || 8000 };
  if (action === 'files_search') return { action, query: command.query || '', path: command.path || '',
    caseSensitive: command.caseSensitive === true, maxFiles: command.maxFiles || 250, maxResults: command.maxResults || 50 };
  if (action === 'files_create') return { action, path: command.path || '', content: String(command.content ?? '') };
  if (action === 'files_write') return { action, path: command.path || '', content: String(command.content ?? ''), expectedSha256: command.expectedSha256 || '' };
  if (action === 'files_patch') return { action, path: command.path || '', before: String(command.before ?? ''), after: String(command.after ?? ''), expectedSha256: command.expectedSha256 || '' };
  if (action === 'files_move') return { action, source: command.source || '', destination: command.destination || '', expectedSha256: command.expectedSha256 || '' };
  if (action === 'files_delete') return { action, path: command.path || '', expectedSha256: command.expectedSha256 || '' };
  return { action };
}
function operationSummary(operation = {}) {
  if (operation.action === 'files_search') return `search ${JSON.stringify(operation.query).slice(0, 80)} in ${operation.path || '.'}`;
  if (operation.action === 'files_move') return `move ${operation.source} -> ${operation.destination}`;
  return `${String(operation.action || '').replace(/^files_/, '')} ${operation.path || '.'}`.trim();
}
function run(broker, root, operation) {
  switch (operation.action) {
    case 'files_list': return broker.list(root, operation.path, { offset: operation.offset, limit: boundedInt(operation.limit, 1, 500, 100) });
    case 'files_tree': return broker.tree(root, operation.path, { depth: boundedInt(operation.depth, 0, 6, 2), limit: boundedInt(operation.limit, 1, 2000, 500) });
    case 'files_stat': return broker.stat(root, operation.path);
    case 'files_read': return broker.read(root, operation.path, { offset: operation.offset, limit: boundedInt(operation.limit, 1, 8000, 8000) });
    case 'files_search': return broker.search(root, operation.query, { path: operation.path, caseSensitive: operation.caseSensitive,
      maxFiles: boundedInt(operation.maxFiles, 1, 800, 250), maxResults: boundedInt(operation.maxResults, 1, 100, 50) });
    case 'files_create': return broker.create(root, operation.path, operation.content);
    case 'files_write': return broker.write(root, operation.path, operation.content, operation.expectedSha256);
    case 'files_patch': return broker.patch(root, operation.path, operation.before, operation.after, operation.expectedSha256);
    case 'files_move': return broker.move(root, operation.source, operation.destination, operation.expectedSha256);
    case 'files_delete': return broker.remove(root, operation.path, operation.expectedSha256);
    default: throw machineError('MACHINE_FILE_ACTION_UNKNOWN', 'Unknown filesystem operation.');
  }
}
function summarize(action, data) {
  if (action === 'files_read') return `${data.bytes} byte(s) read from ${data.path}`;
  if (action === 'files_search') return `${data.results.length} match(es) across ${data.scannedFiles} file(s)`;
  if (action === 'files_list' || action === 'files_tree') return `${data.entries.length} entr${data.entries.length === 1 ? 'y' : 'ies'} from ${data.path}`;
  if (action === 'files_stat') return `${data.type} ${data.path}`;
  if (action === 'files_move') return `moved ${data.source} to ${data.destination}`;
  return `${action.replace(/^files_/, '')} ${data.path || ''}`.trim();
}
function syntheticOutputId(requestId) {
  const safe = String(requestId || '').replace(/[^A-Za-z0-9:_-]/g, '').slice(0, 96) || 'request';
  return `file-result:${safe}`;
}

function createFilesystemProviderControl({
  getState,
  saveState,
  broadcastState,
  broker,
  filesystemBroker,
  repoRootResolver,
  now = () => Date.now(),
  maxRequests = 64,
  notifyRoom = () => {}
} = {}) {
  function persist(snapshot, roomId) {
    const saved = saveState(snapshot); broadcastState(saved); notifyRoom(roomId); return saved;
  }
  function context(snapshot, roomId, spaceRef) {
    const room = (snapshot?.rooms || []).find((entry) => entry.id === roomId);
    if (!room) throw machineError('MACHINE_ROOM_NOT_FOUND', 'Originating Dex room no longer exists.');
    const space = findSpace(room, spaceRef);
    if (!space) throw machineError('MACHINE_SPACE_REQUIRED', 'Choose one exact active Machine Space.');
    return { room, space: shape(space) };
  }
  function receiptResult(input, helpers, result) {
    const receipt = helpers.commitOriginReceipt(input.origin, result, input.requestId);
    helpers.sendResult({ sourceSocket: input.ws, requestId: input.requestId, source: input.source }, result, receipt);
  }

  return {
    route(input, helpers) {
      let result;
      try {
        const snapshot = getState();
        const action = String(input.command?.action || '').trim().toLowerCase();
        const roomId = input.origin?.roomId || input.boundRoomId;
        if (!roomId) throw machineError('MACHINE_ROOM_REQUIRED', 'Name one exact authorized room with "room".');
        const { room, space } = context(snapshot, roomId, input.command?.space);

        if (action === 'files_grants') {
          result = { ok: true, action, message: `Machine Space ${space.name} has ${space.fileGrants.length} filesystem grant record(s).`,
            data: { roomId: room.id, spaceId: space.id, grants: space.fileGrants.map(publicCapabilityGrant) } };
          receiptResult(input, helpers, result); return true;
        }
        if (action === 'files_status') {
          const wanted = String(input.command?.requestId || '');
          const request = space.fileRequests.find((entry) => entry.requestId === wanted);
          if (!request) throw machineError('MACHINE_FILE_REQUEST_NOT_FOUND', 'No filesystem request with that ID exists in this Machine Space.');
          result = { ok: true, action, message: `Filesystem request is ${request.state}.`, data: projection(request) };
          receiptResult(input, helpers, result); return true;
        }
        if (!input.origin?.roomId)
          throw machineError('MACHINE_ORIGIN_REQUIRED', `${action} must trail a reply to a Dex relay turn so the operation has exact message provenance.`);

        const capability = FILE_CAPABILITY_BY_ACTION[action];
        if (!capability) throw machineError('MACHINE_FILE_ACTION_UNKNOWN', 'Unknown filesystem provider action.');
        const targetId = String(input.command?.terminal || input.command?.terminalId || '');
        const target = broker.target(targetId);
        if (!target || !space.resourceIds.includes(targetId))
          throw machineError('MACHINE_TARGET_NOT_ATTACHED', 'Choose an available terminal attached to this exact Machine Space for repository context.');
        const repoRoot = repoRootResolver(target.cwd);
        const operation = operationFor(action, input.command);
        const digest = operationDigest(operation);
        const existing = space.fileRequests.find((entry) => entry.requestId === input.requestId);
        if (existing) {
          if (existing.operationDigest !== digest)
            throw machineError('MACHINE_REQUEST_ID_CONFLICT', 'This request ID already owns another immutable filesystem operation.');
          result = { ok: true, action, message: `Filesystem request already exists in state ${existing.state}; it was not replayed.`, data: projection(existing) };
          receiptResult(input, helpers, result); return true;
        }

        const requestedGrantId = String(input.command?.grant || input.command?.grantId || '');
        const candidates = requestedGrantId ? space.fileGrants.filter((grant) => grant.id === requestedGrantId) : space.fileGrants;
        let grant = null;
        for (const candidate of candidates) {
          const auth = authorizeCapabilityGrant(candidate, { repoRoot, targetId, capability, now, consume: false });
          if (auth.allowed) { grant = candidate; break; }
        }
        if (!grant)
          throw machineError('MACHINE_FILE_GRANT_REQUIRED', `No active local ${capability} grant covers terminal ${targetId} and repository ${repoRoot}.`);

        // Consume allow-once authority only after request-ID conflict detection.
        // A failed filesystem precondition still consumes it, avoiding blind retry.
        authorizeCapabilityGrant(grant, { repoRoot, targetId, capability, now, consume: true });
        const request = {
          requestId: input.requestId,
          actorMemberId: input.origin.executorMemberId,
          actorName: input.origin.executorName,
          sourceMessageId: input.origin.agentMessageId,
          terminalId: targetId,
          grantId: grant.id,
          capability,
          operationDigest: digest,
          operationSummary: operationSummary(operation),
          state: 'queued', resultSummary: '', errorCode: null,
          createdAt: new Date(now()).toISOString(), finishedAt: null
        };
        space.fileRequests.push(request);
        if (space.fileRequests.length > maxRequests) space.fileRequests.splice(0, space.fileRequests.length - maxRequests);
        space.ledger ||= ledgerApi.createLedger({ roomId: room.id, spaceId: space.id });
        ledgerApi.recordRequest(space.ledger, {
          roomId: room.id, spaceId: space.id, requestId: input.requestId,
          actorMemberId: input.origin.executorMemberId, sourceMessageId: input.origin.agentMessageId,
          terminalId: targetId, grantId: grant.id, capability, operationDigest: digest,
          commandSummary: request.operationSummary, createdAt: request.createdAt
        }, () => true);
        ledgerApi.markRunning(space.ledger, input.requestId);
        request.state = 'running';
        persist(snapshot, room.id);

        try {
          const data = run(filesystemBroker, repoRoot, operation);
          request.state = 'completed'; request.resultSummary = summarize(action, data);
          request.finishedAt = new Date(now()).toISOString();
          ledgerApi.settle(space.ledger, { requestId: input.requestId, state: 'completed',
            outputId: syntheticOutputId(input.requestId), preview: request.resultSummary,
            bytes: Number.isSafeInteger(data.bytes) ? data.bytes : null, finishedAt: request.finishedAt });
          persist(snapshot, room.id);
          result = { ok: true, action, message: request.resultSummary,
            data: { roomId: room.id, spaceId: space.id, request: projection(request), result: data, grant: publicCapabilityGrant(grant) } };
        } catch (error) {
          request.state = 'failed'; request.errorCode = error.code || 'MACHINE_FILE_OPERATION_FAILED';
          request.resultSummary = String(error.message || 'Filesystem operation failed.').slice(0, 400);
          request.finishedAt = new Date(now()).toISOString();
          ledgerApi.settle(space.ledger, { requestId: input.requestId, state: 'failed',
            outputId: syntheticOutputId(input.requestId), preview: request.resultSummary, finishedAt: request.finishedAt });
          persist(snapshot, room.id);
          throw machineError(request.errorCode, request.resultSummary, { request: projection(request) });
        }
        receiptResult(input, helpers, result); return true;
      } catch (error) {
        result = { ok: false, code: error.code || 'MACHINE_FILE_CONTROL_FAILED', message: error.message,
          ...(error.data ? { data: error.data } : {}) };
        receiptResult(input, helpers, result); return true;
      }
    }
  };
}

module.exports = { FILE_CAPABILITY_BY_ACTION, projection, operationFor, createFilesystemProviderControl };
