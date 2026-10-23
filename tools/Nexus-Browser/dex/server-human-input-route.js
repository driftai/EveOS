'use strict';

const { randomUUID } = require('node:crypto');
const lifecycle = require('./server-room-lifecycle');
const scopedState = require('./server-authorized-state');

const HUMAN_TYPES = new Set([
  'dex_request_primary', 'dex_human_input_request', 'dex_human_input_disable',
  'dex_room_create', 'dex_room_delete', 'dex_state_put',
  'dex_relay_start', 'dex_relay_stop', 'dex_relay_continue'
]);
const PROVIDER_STATE_ACTIONS = new Set([
  'checkpoint', 'rename_room', 'configure_room', 'add_agent', 'spawn_agent', 'despawn_agent',
  'rename_agent', 'set_agent_relay', 'remove_agent', 'rename_self', 'set_self_relay',
  'set_room_budget', 'clear_chat', 'watch_done', 'unwatch_done', 'workspace_ensure',
  'quorum_presence', 'quorum_open', 'quorum_vote', 'quorum_close'
]);

function failure(code, message) { return { ok: false, code, message }; }
function providerOperations(action) {
  const value = String(action || '').trim().toLowerCase();
  if (value === 'create_room') return ['state:create'];
  if (value === 'delete_room') return ['state:delete'];
  if (value === 'stop_relay') return ['relay:stop'];
  if (value === 'continue_relay') return ['relay:start'];
  if (value === 'send') return ['state:edit', 'relay:start'];
  if (value === 'handoff_room') return ['state:edit', 'relay:start', 'relay:stop'];
  return PROVIDER_STATE_ACTIONS.has(value) ? ['state:edit'] : [];
}
function defaultRoom(index, { idFactory = randomUUID, now = () => new Date().toISOString() } = {}) {
  const at = now();
  return {
    id: `room-${idFactory()}`, name: `Dex Room ${index}`, userName: 'User', members: [], messages: [],
    settings: { autoRelay: true, maxTurns: 8, contextMessages: 8, contextDefaultMessages: null,
      middleAgentMode: 'automatic', middleAgentMemberId: null },
    relay: { active: false, remaining: 0, waitingFor: null, lastStopReason: 'Idle' },
    createdAt: at, updatedAt: at
  };
}

function createHumanInputServerRoute({
  authority, dexRouting, stateStore, scheduler, providerControlRouting,
  maintenanceBusy = () => false, broadcastState = () => {}, safeSend = () => false,
  idFactory = randomUUID, now = () => new Date().toISOString()
} = {}) {
  if (!authority?.validate || !dexRouting?.isPrimaryDex || !stateStore?.load || !stateStore?.save || !scheduler)
    throw new TypeError('Human Input routing requires lease, Dex owner, state, and scheduler dependencies.');

  function sendError(ws, msg, result, relay = false) {
    const payload = relay
      ? { type: 'dex_relay_result', requestId: msg.requestId || null, result }
      : { type: 'error', requestId: msg.requestId || null, code: result.code, message: result.message };
    safeSend(ws, payload);
    if (String(result.code || '').startsWith('DEX_HUMAN_LEASE_')) {
      safeSend(ws, { type: 'dex_human_input_status', requestId: msg.requestId || null,
        status: result.code === 'DEX_HUMAN_LEASE_EXPIRED' ? 'expired' : 'denied',
        code: result.code, message: result.message });
    }
    return true;
  }
  function primary(ws) {
    return dexRouting.isPrimaryDex(ws)
      ? { ok: true }
      : failure('DEX_RUNTIME_STANDBY', 'Only the current primary Dex controller may use Human Input authorization.');
  }
  function exactRoom(roomId) {
    return (stateStore.load()?.rooms || []).find(room => room?.id === String(roomId || '')) || null;
  }
  function providerControlActive(room) {
    return [...(providerControlRouting?.pending?.values?.() || [])]
      .some(entry => entry?.origin?.roomId === room.id || entry?.roomId === room.id);
  }
  function authorize(ws, msg, options) {
    const owner = primary(ws);
    return owner.ok ? authority.validate(ws, msg.authorization, options) : owner;
  }
  function issueProviderAuthorization({ ws, requestId, action, roomId } = {}) {
    const operations = providerOperations(action);
    if (!operations.length) return null;
    const scope = String(action || '').toLowerCase() === 'create_room'
      ? { type: 'create' } : { type: 'room', roomId };
    if (scope.type === 'room' && !String(scope.roomId || '')) return null;
    return authority.issueAgent(ws, { scope, operations, requestId, action });
  }
  function validateAgentGrant(ws, msg, operation) {
    const preliminary = authority.validate(ws, msg.authorization, { operation, kind: 'agent-control' });
    if (!preliminary.ok) return preliminary;
    const grant = preliminary.grant;
    const pending = providerControlRouting?.pending?.get?.(grant.requestId);
    if (!pending || pending.uiAuthorization?.token !== grant.token
        || pending.requestId !== grant.requestId || pending.action !== grant.action
        || !providerOperations(pending.action).includes(operation)
        || (grant.scope.type === 'room' && pending.roomId !== grant.scope.roomId))
      return failure('DEX_AGENT_GRANT_REQUEST_MISMATCH', 'The provider authorization is not tied to an active matching command.');
    return authority.validate(ws, msg.authorization, { operation, kind: 'agent-control',
      roomId: grant.scope.type === 'room' ? grant.scope.roomId : null,
      requestId: pending.requestId, action: pending.action });
  }
  function useAgentGrant(ws, msg, operation) {
    const access = validateAgentGrant(ws, msg, operation);
    return access.ok ? authority.validate(ws, msg.authorization, { operation,
      kind: 'agent-control', requestId: access.grant.requestId,
      action: access.grant.action, consumeOperation: true }) : access;
  }
  function revokeProviderAuthorization(authorization) {
    return authority.revokeToken(authorization?.token, 'DEX_AGENT_GRANT_REVOKED');
  }

  function requestLease(ws, msg) {
    const owner = primary(ws);
    if (!owner.ok) return sendError(ws, msg, owner);
    const creation = msg.scope === 'create';
    const scope = creation ? { type: 'create' } : { type: 'room', roomId: msg.roomId };
    if (!creation && !exactRoom(msg.roomId)) {
      const snapshot = stateStore.load();
      if (msg.bootstrap === true && !(snapshot?.rooms || []).length) {
        const initial = authority.issueHuman(ws, { scope: { type: 'create' }, ttlMs: 15000 });
        safeSend(ws, { type: 'dex_human_input_status',
          requestId: msg.requestId || null, status: 'creation-authorized', lease: initial });
        return true;
      }
      return sendError(ws, msg, failure('DEX_ROOM_NOT_FOUND', 'The exact room no longer exists.'));
    }
    if (!creation) authority.revokeSocket(ws, 'DEX_HUMAN_LEASE_SCOPE_CHANGED', 'human-input');
    const lease = authority.issueHuman(ws, { scope, ttlMs: creation ? 15000 : undefined });
    safeSend(ws, { type: 'dex_human_input_status', requestId: msg.requestId || null,
      status: creation ? 'creation-authorized' : 'active', lease });
    return true;
  }
  function disable(ws, msg) {
    authority.revokeSocket(ws, 'DEX_HUMAN_LEASE_REVOKED', 'human-input');
    safeSend(ws, { type: 'dex_human_input_status', requestId: msg.requestId || null,
      status: 'locked', code: 'DEX_HUMAN_INPUT_DISABLED', message: 'Human Input returned to Agent-Only Mode.' });
    return true;
  }
  function createRoom(ws, msg) {
    const access = authorize(ws, msg, { operation: 'room:create', scopeType: 'create', kind: 'human-input', consume: true });
    if (!access.ok) return sendError(ws, msg, access);
    if (maintenanceBusy()) return sendError(ws, msg, failure('POST_IDLE_LEASE_BUSY', 'Post-idle maintenance blocks room creation.'));
    const snapshot = stateStore.load() || {
      version: 1, rooms: [], activeRoomId: null,
      retiredRoomIds: [], retiredProviderControlReceipts: []
    };
    const rooms = Array.isArray(snapshot.rooms) ? snapshot.rooms : [];
    let room;
    do { room = defaultRoom(rooms.length + 1, { idFactory, now }); }
    while (rooms.some(entry => entry?.id === room.id) || (snapshot.retiredRoomIds || []).includes(room.id));
    const saved = stateStore.save({ ...snapshot, rooms: [...rooms, room], activeRoomId: room.id, savedAt: now() });
    authority.revokeSocket(ws, 'DEX_HUMAN_LEASE_SCOPE_CHANGED', 'human-input');
    const lease = authority.issueHuman(ws, { scope: { type: 'room', roomId: room.id } });
    safeSend(ws, { type: 'dex_room_create_result', requestId: msg.requestId || null,
      ok: true, roomId: room.id, snapshot: saved, lease });
    broadcastState(saved);
    return true;
  }
  function deleteRoom(ws, msg) {
    const access = authorize(ws, msg, { operation: 'room:delete', roomId: msg.roomId, kind: 'human-input' });
    if (!access.ok) return sendError(ws, msg, access);
    if (maintenanceBusy()) return sendError(ws, msg, failure('POST_IDLE_LEASE_BUSY', 'Post-idle maintenance blocks room deletion.'));
    const result = lifecycle.deleteRoom(stateStore.load(), msg, { humanInputEnabled: true, providerControlActive, now });
    if (!result.ok) return sendError(ws, msg, result);
    const saved = stateStore.save(result.snapshot);
    authority.revokeSocket(ws, 'DEX_HUMAN_LEASE_SCOPE_CHANGED', 'human-input');
    safeSend(ws, { type: 'dex_room_delete_result', requestId: msg.requestId || null,
      ...result, snapshot: undefined });
    safeSend(ws, { type: 'dex_human_input_status', status: 'locked', roomId: msg.roomId,
      code: 'DEX_HUMAN_LEASE_SCOPE_CHANGED', message: 'The authorized room changed; Human Input was relocked.' });
    broadcastState(saved);
    return true;
  }
  function saveState(ws, msg) {
    const owner = primary(ws);
    if (!owner.ok) return sendError(ws, msg, owner);
    if (maintenanceBusy()) return sendError(ws, msg, failure('POST_IDLE_LEASE_BUSY', 'Post-idle maintenance blocks room mutations.'));
    const attempts = ['state:edit', 'state:create', 'state:delete']
      .map(operation => authority.validate(ws, msg.authorization, { operation }));
    const tokenCheck = attempts.find(result => result.ok) || attempts[0];
    let merged;
    if (tokenCheck.ok && tokenCheck.grant.kind === 'human-input') {
      const roomId = String(msg.roomId || '');
      const scoped = authority.validate(ws, msg.authorization, { operation: 'state:edit', roomId, kind: 'human-input' });
      merged = scoped.ok ? scopedState.mergeRoomEdit(stateStore.load(), msg.snapshot, roomId) : scoped;
    } else {
      const grant = tokenCheck.ok ? tokenCheck.grant : null;
      const operation = grant?.action === 'create_room' ? 'state:create'
        : grant?.action === 'delete_room' ? 'state:delete' : 'state:edit';
      const agent = validateAgentGrant(ws, msg, operation);
      if (!agent.ok) return sendError(ws, msg, tokenCheck.ok ? agent : tokenCheck);
      const snapshot = stateStore.load();
      merged = operation === 'state:create' ? scopedState.mergeAgentCreate(snapshot, msg.snapshot)
        : operation === 'state:delete' ? scopedState.mergeAgentDelete(snapshot, msg.snapshot, agent.grant.scope.roomId)
          : scopedState.mergeRoomEdit(snapshot, msg.snapshot, agent.grant.scope.roomId);
      if (merged.ok && operation === 'state:edit') {
        const limited = scopedState.checkAgentMutation(snapshot, msg.snapshot, agent.grant.scope.roomId, agent.grant.action);
        if (!limited.ok) return sendError(ws, msg, limited);
      }
      if (merged.ok) {
        const used = useAgentGrant(ws, msg, operation);
        if (!used.ok) return sendError(ws, msg, used);
      }
    }
    if (!merged.ok) return sendError(ws, msg, merged);
    try {
      const saved = stateStore.save(merged.snapshot); scheduler.onStateChanged?.(); broadcastState(saved);
      safeSend(ws, { type: 'dex_state_saved', requestId: msg.requestId || null, savedAt: saved.savedAt });
    } catch (error) {
      return sendError(ws, msg, failure('DEX_STATE_SAVE_FAILED', error.message));
    }
    return true;
  }
  function relay(ws, msg) {
    const owner = primary(ws);
    if (!owner.ok) return sendError(ws, msg, owner, true);
    if (maintenanceBusy()) return sendError(ws, msg, failure('POST_IDLE_LEASE_BUSY', 'Post-idle task owns the relay mutation lease.'), true);
    let committed = false;
    if (msg.type === 'dex_relay_start') {
      if (msg.authorization?.token) {
        const access = validateAgentGrant(ws, msg, 'relay:start');
        if (!access.ok) return sendError(ws, msg, access, true);
        if (access.grant.scope.roomId !== String(msg.roomId || ''))
          return sendError(ws, msg, failure('DEX_AGENT_GRANT_SCOPE_MISMATCH', 'Relay room differs from provider grant.'), true);
        const used = useAgentGrant(ws, msg, 'relay:start');
        if (!used.ok) return sendError(ws, msg, used, true);
      } else {
        if (msg.sourceMessageId !== msg.sourceMessage?.id)
          return sendError(ws, msg, failure('DEX_USER_RELAY_SOURCE_MISMATCH', 'Relay source must equal the committed user message.'), true);
        const appended = scopedState.appendUserMessage(stateStore.load(), msg.roomId, msg.sourceMessage, msg.requestId);
        if (!appended.ok) return sendError(ws, msg, appended, true);
        if (appended.deduplicated)
          return sendError(ws, msg, failure('DEX_USER_RELAY_REPLAYED', 'User message was already committed; relay execution is not repeated automatically. Inspect room state before retrying.'), true);
        if (!appended.deduplicated) {
          const saved = stateStore.save(appended.snapshot); broadcastState(saved); committed = true;
        }
      }
    } else {
      const operation = msg.type === 'dex_relay_stop' ? 'relay:stop' : 'relay:continue';
      let access = authority.validate(ws, msg.authorization, { operation, roomId: msg.roomId, kind: 'human-input' });
      if (!access.ok) {
        access = validateAgentGrant(ws, msg, msg.type === 'dex_relay_stop' ? 'relay:stop' : 'relay:start');
        if (access.ok && access.grant.scope.roomId === String(msg.roomId || ''))
          access = useAgentGrant(ws, msg, msg.type === 'dex_relay_stop' ? 'relay:stop' : 'relay:start');
        else if (access.ok) access = failure('DEX_AGENT_GRANT_SCOPE_MISMATCH', 'Relay room differs from provider grant.');
      }
      if (!access.ok) return sendError(ws, msg, access, true);
    }
    const result = msg.type === 'dex_relay_start' ? scheduler.startRelay(msg)
      : msg.type === 'dex_relay_stop' ? scheduler.stopRelay(msg) : scheduler.continueRelay(msg);
    if (committed) {
      const latest = stateStore.load();
      const message = latest?.rooms?.find(room => room.id === msg.roomId)?.messages?.find(entry => entry.id === msg.sourceMessageId);
      if (message?.relayStartRequestId === msg.requestId) {
        message.relayStartDisposition = result?.ok ? 'started' : 'not-started';
        try { stateStore.save(latest); } catch {} // Reserved receipt already fences replay.
      }
    }
    safeSend(ws, { type: 'dex_relay_result', requestId: msg.requestId || null,
      result: committed && !result?.ok ? { ...result, messageCommitted: true } : result });
    return true;
  }

  function handle(ws, msg = {}) {
    if (ws?.clientKind !== 'dex' || !HUMAN_TYPES.has(msg.type)) return false;
    if (msg.type === 'dex_request_primary') {
      const claimed = dexRouting.claimPrimaryDex(ws) === true;
      safeSend(ws, claimed ? { type: 'dex_state_snapshot', snapshot: stateStore.load() }
        : { type: 'error', requestId: msg.requestId || null, code: 'DEX_PRIMARY_CLAIM_DENIED', message: 'Only a connected Dex viewer may claim the editing role.' });
      return true;
    }
    if (msg.type === 'dex_human_input_request') return requestLease(ws, msg);
    if (msg.type === 'dex_human_input_disable') return disable(ws, msg);
    if (msg.type === 'dex_room_create') return createRoom(ws, msg);
    if (msg.type === 'dex_room_delete') return deleteRoom(ws, msg);
    if (msg.type === 'dex_state_put') return saveState(ws, msg);
    return relay(ws, msg);
  }

  return { handle, issueProviderAuthorization, revokeProviderAuthorization, providerControlActive };
}

module.exports = { HUMAN_TYPES, PROVIDER_STATE_ACTIONS, providerOperations, defaultRoom, createHumanInputServerRoute };
