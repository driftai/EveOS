'use strict';
// Shared, fail-closed source check for ALL localhost provider-control actions.
const identity = require('../public/dex-members');
const controlReceipt = require('./provider-control-receipt');
const UNBOUND_ACTIONS = new Set(['help']);
const ONLINE_ORIGIN_MUTATING_ACTIONS = new Set([
  'checkpoint', 'create_room', 'rename_room', 'configure_room', 'add_agent', 'spawn_agent', 'despawn_agent',
  'rename_agent', 'set_agent_relay', 'remove_agent', 'rename_self', 'set_self_relay',
  'stop_relay', 'continue_relay', 'set_room_budget', 'clear_chat', 'delete_room', 'send', 'handoff_room', 'reload_extension', 'watch_done', 'unwatch_done',
  'arm_post_idle', 'cancel_post_idle', 'report_post_idle', 'terminal_exec'
]);
const fail = (code, message) => ({ ok: false, code, message });
const isOnlineOrigin = (source = {}) => String(source.targetClassId || '').trim().toLowerCase() === 'online-origin';
function onlineOriginMutationGate(snapshot, source = {}, command = {}) {
  const action = String(command.action || '').trim().toLowerCase();
  if (!isOnlineOrigin(source) || !ONLINE_ORIGIN_MUTATING_ACTIONS.has(action)) return null;
  if (controlReceipt.findIntent(snapshot, source, command)) return null;
  // A command emitted by the currently active source turn may arrive just before
  // response_final records its exact durable intent. Let routing settle that turn,
  // but reject historical/unsolicited Online-Origin mutations with no durable origin.
  if (controlReceipt.activeSourceTurn(snapshot, source)) return null;
  return fail('DEX_CONTROL_ORIGIN_REQUIRED',
    'Online-Origin state-changing provider-control requires an exact durable control origin; no mutation was executed.');
}
function authorize(snapshot, source = {}, command = {}) {
  const action = String(command.action || '').trim().toLowerCase();
  if (!source.targetClassId || !source.providerId)
    return fail('DEX_CONTROL_BAD_SOURCE', 'Exact authenticated provider identity required.');
  if (UNBOUND_ACTIONS.has(action)) return { ok: true, scope: 'unbound-action' };
  if (!snapshot || !Array.isArray(snapshot.rooms))
    return fail('DEX_ENTRY_STATE_UNAVAILABLE', 'Durable room state unavailable; no command executed.');
  const exact = snapshot.rooms.filter(room => (room.members || []).filter(member =>
    identity.exactBinding(member.binding, source)).length === 1);
  if (!exact.length) return identity.staleRoomCount(snapshot.rooms, source, command.room)
    ? fail('DEX_ROOM_STALE_BINDING', 'Stale tab ID or chat URL: explicitly rebind the existing room member; no command executed.')
    : fail('DEX_ROOM_NOT_BOUND', 'Exact tab and chat identity is not bound to a room; no command executed.');
  if (command.room != null && String(command.room).trim()) {
    const key = String(command.room).trim().toLowerCase();
    const selected = exact.filter(room => room.id === command.room
      || String(room.name || '').trim().toLowerCase() === key);
    if (!selected.length) return identity.staleRoomCount(snapshot.rooms, source, command.room)
      ? fail('DEX_ROOM_STALE_BINDING', 'Selected room has an outdated chat or tab binding; no command executed.')
      : fail('DEX_ROOM_NOT_BOUND', 'No exact authorized room matches this reference.');
    if (selected.length !== 1) return fail('DEX_ROOM_AMBIGUOUS', 'Specify one unique authorized room ID.');
    const originGate = onlineOriginMutationGate(snapshot, source, command);
    if (originGate) return originGate;
    return { ok: true, scope: 'exact-room', roomId: selected[0].id };
  }
  const originGate = onlineOriginMutationGate(snapshot, source, command);
  if (originGate) return originGate;
  return exact.length === 1 ? { ok: true, scope: 'unique-room', roomId: exact[0].id }
    : { ok: true, scope: 'multiple-exact-rooms' };
}
module.exports = { UNBOUND_ACTIONS, ONLINE_ORIGIN_MUTATING_ACTIONS, isOnlineOrigin, onlineOriginMutationGate, authorize };
