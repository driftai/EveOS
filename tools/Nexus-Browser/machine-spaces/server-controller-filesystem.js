'use strict';

const { resolveRepoRoot } = require('./repo-safe-grant');
const { createCapabilityGrant, publicCapabilityGrant, revokeCapabilityGrant } = require('./capability-grant');
const { createFilesystemBroker } = require('./filesystem-broker');
const { FILE_ACTIONS, fileRequestProjection } = require('./provider-control');
const { createFilesystemProviderControl } = require('./filesystem-provider-control');

const MAX_FILE_GRANTS = 32;
const MAX_FILE_REQUESTS = 64;

function machineError(code, message) { return Object.assign(new Error(message), { code }); }
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
function ensureSpaceShape(space) {
  if (!space || typeof space !== 'object') return space;
  space.resourceIds = Array.isArray(space.resourceIds) ? space.resourceIds : [];
  space.fileGrants = Array.isArray(space.fileGrants) ? space.fileGrants : [];
  space.fileRequests = Array.isArray(space.fileRequests) ? space.fileRequests : [];
  return space;
}
function augmentedRoomSnapshot(base, state, broker) {
  if (!base || base.type !== 'machine_room_snapshot') return base;
  const room = (state?.rooms || []).find((entry) => entry.id === base.roomId);
  if (!room) return base;
  const baseById = new Map((base.spaces || []).map((space) => [space.id, space]));
  return { ...base, spaces: machineState(room).spaces.map((space) => {
    ensureSpaceShape(space);
    const current = baseById.get(space.id) || { id: space.id, name: space.name, archived: space.archived === true,
      grant: null, resources: space.resourceIds.map((terminalId) => {
        const target = broker.target(terminalId);
        return target ? { ...target, available: true } : { id: terminalId, targetId: terminalId, available: false };
      }), requests: [] };
    return { ...current, fileGrants: space.fileGrants.map(publicCapabilityGrant),
      fileRequests: space.fileRequests.slice(-MAX_FILE_REQUESTS).map(fileRequestProjection) };
  }) };
}

function enhanceMachineSpacesController(createBaseController, options = {}) {
  const originalSafeSend = options.safeSend;
  const uiSockets = options.uiSockets || new Set();
  const getState = options.getState || (() => null);
  const saveState = options.saveState || ((value) => value);
  const broadcastState = options.broadcastState || (() => {});
  const now = options.now || (() => Date.now());
  const repoRootResolver = options.repoRootResolver || resolveRepoRoot;
  const filesystemBroker = options.filesystemBroker || createFilesystemBroker();
  let base = null;
  const safeSend = (ws, payload) => originalSafeSend?.(ws, base ? augmentedRoomSnapshot(payload, getState(), base.broker) : payload);
  base = createBaseController({ ...options, safeSend });

  function persist(snapshot, roomId = null) {
    const saved = saveState(snapshot); broadcastState(saved);
    if (roomId) {
      const room = (saved?.rooms || []).find((entry) => entry.id === roomId);
      if (room) {
        const payload = augmentedRoomSnapshot({ type: 'machine_room_snapshot', roomId, roomName: room.name, spaces: [] }, saved, base.broker);
        for (const ws of uiSockets) originalSafeSend?.(ws, payload);
      }
    }
    return saved;
  }
  function roomAndSpace(roomId, spaceRef) {
    const snapshot = getState();
    const room = (snapshot?.rooms || []).find((entry) => entry.id === String(roomId || ''));
    if (!room) throw machineError('MACHINE_ROOM_NOT_FOUND', 'Dex room no longer exists.');
    const space = findSpace(room, spaceRef);
    if (!space) throw machineError('MACHINE_SPACE_REQUIRED', 'Choose one exact active Machine Space.');
    ensureSpaceShape(space);
    return { snapshot, room, space };
  }
  function requireLocal(ws) {
    if (!uiSockets.has(ws)) throw machineError('MACHINE_LOCAL_OWNER_REQUIRED', 'Only the local Machine Spaces panel can change filesystem grants.');
  }
  function createFileGrant(ws, msg) {
    requireLocal(ws);
    const { snapshot, room, space } = roomAndSpace(msg.roomId, msg.spaceId);
    const targetId = String(msg.targetId || '');
    if (!space.resourceIds.includes(targetId)) throw machineError('MACHINE_TARGET_NOT_ATTACHED', 'Filesystem grant target must be attached to this Machine Space.');
    const target = base.broker.target(targetId);
    if (!target) throw machineError('MACHINE_TARGET_NOT_FOUND', 'Managed terminal no longer exists.');
    if (space.fileGrants.filter((grant) => grant?.enabled === true).length >= MAX_FILE_GRANTS)
      throw machineError('MACHINE_FILE_GRANT_LIMIT', 'Revoke an active filesystem grant before creating another.');
    const grant = createCapabilityGrant({ repoRoot: repoRootResolver(target.cwd), targetId,
      ownerId: String(msg.ownerId || 'machine-owner-local'), capabilities: msg.capabilities,
      mode: msg.mode || 'once', ttlMs: msg.ttlMs, now });
    space.fileGrants.push(grant); persist(snapshot, room.id); return publicCapabilityGrant(grant);
  }
  function revokeFileGrant(ws, msg) {
    requireLocal(ws);
    const { snapshot, room, space } = roomAndSpace(msg.roomId, msg.spaceId);
    const grant = space.fileGrants.find((entry) => entry.id === String(msg.grantId || ''));
    if (!grant) throw machineError('MACHINE_FILE_GRANT_NOT_FOUND', 'Filesystem grant no longer exists.');
    const projection = revokeCapabilityGrant(grant, { reason: 'owner-revoked', now });
    persist(snapshot, room.id); return projection;
  }
  function cleanupForTarget(targetId, reason) {
    if (!targetId) return;
    const snapshot = getState(); let changed = false;
    for (const room of snapshot?.rooms || []) for (const space of machineState(room).spaces) {
      ensureSpaceShape(space);
      for (const grant of space.fileGrants) if (grant.targetId === targetId && grant.enabled === true) {
        revokeCapabilityGrant(grant, { reason, now }); changed = true;
      }
    }
    if (changed) persist(snapshot);
  }
  function cleanupArchivedSpace(roomId, spaceId) {
    const snapshot = getState();
    const room = (snapshot?.rooms || []).find((entry) => entry.id === roomId);
    const space = room && machineState(room).spaces.find((entry) => entry.id === spaceId);
    if (!space?.archived) return;
    ensureSpaceShape(space); let changed = false;
    for (const grant of space.fileGrants) if (grant.enabled === true) {
      revokeCapabilityGrant(grant, { reason: 'space-archived', now }); changed = true;
    }
    if (changed) persist(snapshot, roomId);
  }

  const fileControl = createFilesystemProviderControl({ getState, saveState, broadcastState,
    broker: base.broker, filesystemBroker, repoRootResolver, now, maxRequests: MAX_FILE_REQUESTS,
    notifyRoom(roomId) {
      const snapshot = getState(), room = (snapshot?.rooms || []).find((entry) => entry.id === roomId);
      if (!room) return;
      const payload = augmentedRoomSnapshot({ type: 'machine_room_snapshot', roomId, roomName: room.name, spaces: [] }, snapshot, base.broker);
      for (const ws of uiSockets) originalSafeSend?.(ws, payload);
    } });
  const providerControl = {
    owns(action) { const value = String(action || '').toLowerCase(); return FILE_ACTIONS.has(value) || base.providerControl.owns(value); },
    route(input, helpers) {
      const action = String(input?.command?.action || '').toLowerCase();
      return FILE_ACTIONS.has(action) ? fileControl.route(input, helpers) : base.providerControl.route(input, helpers);
    }
  };
  async function handle(ws, msg = {}) {
    const type = String(msg.type || '');
    try {
      if (type === 'machine_enable_file_grant') {
        const grant = createFileGrant(ws, msg);
        originalSafeSend?.(ws, { type: 'machine_file_grant_changed', action: 'created', roomId: msg.roomId, spaceId: msg.spaceId, grant });
        return true;
      }
      if (type === 'machine_revoke_file_grant') {
        const grant = revokeFileGrant(ws, msg);
        originalSafeSend?.(ws, { type: 'machine_file_grant_changed', action: 'revoked', roomId: msg.roomId, spaceId: msg.spaceId, grant });
        return true;
      }
      const targetId = type === 'machine_stop_target' || type === 'machine_detach_target' ? String(msg.targetId || '') : '';
      const roomId = String(msg.roomId || ''), spaceId = String(msg.spaceId || '');
      const handled = await base.handle(ws, msg);
      if (handled && targetId) cleanupForTarget(targetId, type === 'machine_stop_target' ? 'target-stopped' : 'target-detached');
      if (handled && type === 'machine_archive_space') cleanupArchivedSpace(roomId, spaceId);
      return handled;
    } catch (error) {
      originalSafeSend?.(ws, { type: 'error', requestId: msg.requestId || null,
        code: error.code || 'MACHINE_FILE_CONTROL_FAILED', message: error.message });
      return true;
    }
  }
  return { ...base, handle, providerControl, filesystemBroker, fileControl };
}

module.exports = { MAX_FILE_GRANTS, MAX_FILE_REQUESTS, machineState, findSpace, ensureSpaceShape,
  augmentedRoomSnapshot, enhanceMachineSpacesController };
