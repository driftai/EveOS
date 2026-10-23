'use strict';

const merge = require('./server-state-merge');
const { isDeepStrictEqual } = require('node:util');

function failure(code, message) { return { ok: false, code, message }; }
const roomsOf = (snapshot) => Array.isArray(snapshot?.rooms) ? snapshot.rooms : [];
const roomMap = (snapshot) => new Map(roomsOf(snapshot).filter(room => room?.id).map(room => [room.id, room]));
const same = (left, right) => isDeepStrictEqual(left, right);

function unchangedOutside(serverSnapshot, clientSnapshot, allowedIds = new Set()) {
  const server = roomMap(serverSnapshot), client = roomMap(clientSnapshot);
  for (const [id, room] of server) {
    if (!allowedIds.has(id) && !same(room, client.get(id))) return false;
  }
  for (const id of client.keys()) if (!server.has(id) && !allowedIds.has(id)) return false;
  return true;
}

function mergeRoomEdit(serverSnapshot, clientSnapshot, roomId) {
  const id = String(roomId || ''), serverRooms = roomMap(serverSnapshot), clientRooms = roomMap(clientSnapshot);
  const serverRoom = serverRooms.get(id), clientRoom = clientRooms.get(id);
  if (!serverRoom || !clientRoom) return failure('DEX_HUMAN_LEASE_SCOPE_MISMATCH', 'The authorized room is missing from the submitted state edit.');
  if (serverRooms.size !== clientRooms.size || !unchangedOutside(serverSnapshot, clientSnapshot, new Set([id])))
    return failure('DEX_HUMAN_LEASE_SCOPE_MISMATCH', 'One room authorization cannot add, remove, or edit another room.');
  if (merge.executionBusy(serverRoom))
    return failure('DEX_ROOM_EXECUTION_BUSY', 'Stop active relay, recovery, and deferred work before editing this room.');
  const candidate = merge.mergeClientSnapshot(serverSnapshot, clientSnapshot);
  const mergedRoom = roomsOf(candidate).find(room => room?.id === id);
  if (!mergedRoom) return failure('DEX_STATE_EDIT_REJECTED', 'The authorized room edit could not be merged safely.');
  return { ok: true, snapshot: {
    ...serverSnapshot,
    rooms: roomsOf(serverSnapshot).map(room => room?.id === id ? mergedRoom : room),
    activeRoomId: serverSnapshot?.activeRoomId || id,
    savedAt: candidate.savedAt
  } };
}

const AGENT_ACTION_FIELDS = Object.freeze({
  checkpoint: ['agentCheckpoints', 'updatedAt'],
  rename_room: ['name', 'updatedAt'],
  configure_room: ['settings', 'updatedAt'], set_room_budget: ['settings', 'updatedAt'],
  rename_agent: ['members', 'updatedAt'], rename_self: ['members', 'updatedAt'],
  set_agent_relay: ['members', 'updatedAt'], set_self_relay: ['members', 'updatedAt'],
  add_agent: ['members', 'updatedAt'], spawn_agent: ['members', 'updatedAt'],
  despawn_agent: ['members', 'updatedAt'], remove_agent: ['members', 'updatedAt'],
  clear_chat: ['messages', 'updatedAt', 'doneWatches', 'doneWatchRevision'],
  send: ['messages', 'updatedAt', 'doneWatches', 'doneWatchRevision'],
  handoff_room: ['messages', 'updatedAt'],
  watch_done: ['doneWatches', 'doneWatchRevision', 'updatedAt'],
  unwatch_done: ['doneWatches', 'doneWatchRevision', 'updatedAt'],
  quorum_presence: ['members', 'updatedAt'], quorum_open: ['messages', 'updatedAt'],
  quorum_vote: ['messages', 'updatedAt'], quorum_close: ['messages', 'updatedAt']
});
// Check the submitted edit's intent; server-side merge is responsible for preserving
// canonical runtime fields. Unknown actions fail closed rather than receiving room-wide power.
function checkAgentMutation(serverSnapshot, clientSnapshot, roomId, action) {
  const allowed = AGENT_ACTION_FIELDS[String(action || '')];
  if (!allowed) return failure('DEX_AGENT_GRANT_ACTION_DENIED', 'Provider action has no approved room-edit scope.');
  const before = roomMap(serverSnapshot).get(String(roomId || ''));
  const after = roomMap(clientSnapshot).get(String(roomId || ''));
  if (!before || !after) return failure('DEX_AGENT_GRANT_SCOPE_MISMATCH', 'The provider room changed.');
  const immutable = new Set(['id', 'createdAt', 'relay', 'pendingTurn', 'recovery',
    'pendingProviderControlReceipt', 'machineSpaces', 'finalReceipts',
    'retiredProviderControlReceipts', 'terminalBootstrap']);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    // Canonical replay receipts are never taken from a client edit: the merge
    // always retains the server value, so stale browser copies are harmless.
    if (key === 'userRelayReceipts') continue;
    if (allowed.includes(key) || same(before[key], after[key])) continue;
    // Some older snapshots omit canonical fields that the merge normalizes to
    // empty values. Do not interpret that normalization as an agent edit.
    if (!(key in before) && (after[key] == null || same(after[key], []) || same(after[key], {}))) continue;
    if (immutable.has(key) || !allowed.includes(key))
      return failure('DEX_AGENT_GRANT_ACTION_DENIED', `The ${action} grant cannot change ${key}.`);
  }
  const oldMembers = before.members || [], nextMembers = after.members || [];
  const renameMember = ['rename_agent', 'rename_self'].includes(action);
  const relayMember = ['set_agent_relay', 'set_self_relay'].includes(action);
  if (renameMember || relayMember) {
    if (oldMembers.length !== nextMembers.length) return failure('DEX_AGENT_GRANT_ACTION_DENIED', 'This action cannot add or remove participants.');
    let changes = 0;
    for (let i = 0; i < oldMembers.length; i += 1) {
      const original = oldMembers[i], updated = nextMembers[i];
      const field = renameMember ? 'name' : 'relayEnabled';
      if (!same(original, updated)) changes += 1;
      if (!same({ ...original, [field]: updated?.[field] }, updated))
        return failure('DEX_AGENT_GRANT_ACTION_DENIED', 'Participant mutation exceeds the requested action.');
    }
    if (changes > 1) return failure('DEX_AGENT_GRANT_ACTION_DENIED', 'One command cannot alter multiple participants.');
  }
  if (['add_agent', 'spawn_agent'].includes(action)) {
    if (nextMembers.length !== oldMembers.length + 1 ||
        !oldMembers.every((member, index) => same(member, nextMembers[index])))
      return failure('DEX_AGENT_GRANT_ACTION_DENIED', 'This action may append exactly one participant.');
  }
  if (['remove_agent', 'despawn_agent'].includes(action)) {
    const missing = oldMembers.filter(member => !nextMembers.some(next => next?.id === member?.id));
    if (missing.length !== 1 || nextMembers.length !== oldMembers.length - 1 ||
        !nextMembers.every(next => oldMembers.some(member => same(member, next))))
      return failure('DEX_AGENT_GRANT_ACTION_DENIED', 'This action may remove exactly one unchanged participant.');
  }
  const oldMessages = before.messages || [], nextMessages = after.messages || [];
  if (['send', 'handoff_room'].includes(action) &&
      (nextMessages.length !== oldMessages.length + 1 ||
       !oldMessages.every((message, index) => same(message, nextMessages[index]))))
    return failure('DEX_AGENT_GRANT_ACTION_DENIED', 'This action may append exactly one room message.');
  if (action === 'clear_chat' && nextMessages.length !== 0)
    return failure('DEX_AGENT_GRANT_ACTION_DENIED', 'Clear-chat authorization cannot rewrite messages.');
  return { ok: true };
}

function mergeAgentCreate(serverSnapshot, clientSnapshot) {
  const server = roomMap(serverSnapshot), client = roomMap(clientSnapshot);
  const added = [...client.keys()].filter(id => !server.has(id));
  if (added.length !== 1 || [...server.keys()].some(id => !client.has(id))
      || !unchangedOutside(serverSnapshot, clientSnapshot, new Set(added)))
    return failure('DEX_AGENT_GRANT_SCOPE_MISMATCH', 'The provider-control creation grant permits exactly one new room and no other room mutation.');
  const id = added[0];
  if ((serverSnapshot?.retiredRoomIds || []).includes(id))
    return failure('DEX_ROOM_RETIREMENT_ID_CONFLICT', 'The proposed room ID was previously retired.');
  const candidate = merge.mergeClientSnapshot(serverSnapshot, clientSnapshot);
  return { ok: true, roomId: id, snapshot: candidate };
}

function mergeAgentDelete(serverSnapshot, clientSnapshot, roomId) {
  const id = String(roomId || ''), server = roomMap(serverSnapshot), client = roomMap(clientSnapshot);
  if (!server.has(id) || client.has(id))
    return failure('DEX_AGENT_GRANT_SCOPE_MISMATCH', 'The provider-control deletion grant does not match the removed room.');
  const added = [...client.keys()].filter(candidate => !server.has(candidate));
  const allowed = new Set([id, ...added]);
  if (added.length > (server.size === 1 ? 1 : 0)
      || [...server.keys()].some(candidate => candidate !== id && !client.has(candidate))
      || !unchangedOutside(serverSnapshot, clientSnapshot, allowed))
    return failure('DEX_AGENT_GRANT_SCOPE_MISMATCH', 'The provider-control deletion grant cannot mutate unrelated rooms.');
  if (merge.executionBusy(server.get(id)))
    return failure('DEX_ROOM_EXECUTION_BUSY', 'Active room execution prevents provider-control deletion.');
  const candidate = merge.mergeClientSnapshot(serverSnapshot, clientSnapshot);
  const retired = Array.isArray(serverSnapshot?.retiredRoomIds) ? serverSnapshot.retiredRoomIds : [];
  return { ok: true, snapshot: { ...candidate, retiredRoomIds: retired.includes(id) ? retired : [...retired, id] } };
}

function appendUserMessage(snapshot, roomId, message = {}, requestId = null) {
  const room = roomMap(snapshot).get(String(roomId || ''));
  if (!room) return failure('DEX_ROOM_NOT_FOUND', 'The exact room no longer exists.');
  const id = String(message.id || ''), text = typeof message.text === 'string' ? message.text.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{7,159}$/.test(id) || !text || text.length > 12000
      || message.senderKind !== 'user' || message.senderId !== 'user')
    return failure('DEX_USER_MESSAGE_INVALID', 'Provide one bounded user message with a stable ID.');
  const request = String(requestId || '');
  if (!request || request.length > 160)
    return failure('DEX_USER_RELAY_REQUEST_INVALID', 'A stable bounded relay request ID is required.');
  // Canonical receipts survive clear-chat and ordinary browser mirrors.
  const receipts = Array.isArray(room.userRelayReceipts) ? room.userRelayReceipts : [];
  const prior = receipts.find(receipt => receipt?.requestId === request || receipt?.messageId === id);
  if (prior) return failure(prior.requestId === request && prior.messageId === id
    ? 'DEX_USER_RELAY_REPLAYED' : 'DEX_USER_RELAY_REQUEST_CONFLICT',
    'This relay request or source message was already reserved.');
  // Never discard old receipts to make room; exhaustion must fail closed.
  if (receipts.length >= 8192)
    return failure('DEX_USER_RELAY_LEDGER_FULL', 'Room replay ledger is full. Start a new room rather than risk repeating an old request.');
  if ((room.messages || []).some(entry => entry?.relayStartRequestId === request && entry.id !== id))
    return failure('DEX_USER_RELAY_REQUEST_CONFLICT', 'That relay request already belongs to another message.');
  const existing = (room.messages || []).find(entry => entry?.id === id);
  if (existing) {
    return existing.senderKind === 'user' && existing.senderId === 'user' && existing.text === text
      ? { ok: true, snapshot, room, message: existing, deduplicated: true }
      : failure('DEX_USER_MESSAGE_ID_CONFLICT', 'That user message ID already owns different content.');
  }
  const committed = {
    id, senderKind: 'user', senderId: 'user',
    senderName: String(message.senderName || room.userName || 'User').trim().slice(0, 48) || 'User',
    text, at: Number.isFinite(Date.parse(message.at || '')) ? message.at : new Date().toISOString(),
    relayStartRequestId: request, relayStartDisposition: 'reserved'
  };
  room.userRelayReceipts = [...receipts, { requestId: request, messageId: id }];
  room.messages = [...(room.messages || []), committed];
  room.updatedAt = committed.at;
  return { ok: true, snapshot, room, message: committed, deduplicated: false };
}

module.exports = { unchangedOutside, mergeRoomEdit, mergeAgentCreate, mergeAgentDelete, appendUserMessage, checkAgentMutation };
