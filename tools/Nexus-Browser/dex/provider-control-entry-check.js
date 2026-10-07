'use strict';
// Shared, fail-closed source check for ALL localhost provider-control actions.
const identity = require('../public/dex-members');
const UNBOUND_ACTIONS = new Set(['help', 'create_room']);
const fail = (code, message) => ({ ok: false, code, message });
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
    return { ok: true, scope: 'exact-room', roomId: selected[0].id };
  }
  return exact.length === 1 ? { ok: true, scope: 'unique-room', roomId: exact[0].id }
    : { ok: true, scope: 'multiple-exact-rooms' };
}
module.exports = { UNBOUND_ACTIONS, authorize };
