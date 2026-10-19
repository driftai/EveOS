'use strict';

const { executionBusy } = require('./server-state-merge');
const MAX_RETIRED_RECEIPTS = 100;

function text(value, max = 160) {
  return typeof value === 'string' ? value.trim().slice(0, max) : null;
}

function archiveEntry(room, at) {
  const pending = room.pendingProviderControlReceipt || {};
  return {
    schema: 'eveos.dex-retired-provider-control.v1',
    disposition: 'USER_RETIRED_UNRESOLVED',
    roomId: text(room.id, 120),
    roomName: text(room.name, 80),
    action: text(pending.action, 80),
    turnRequestId: text(pending.turnRequestId, 160),
    executorMemberId: text(pending.executorMemberId, 160),
    originMessageId: text(pending.originMessageId, 160),
    agentMessageId: text(pending.agentMessageId, 160),
    createdAt: text(pending.createdAt, 40),
    retiredAt: at
  };
}

function deleteRoom(snapshot, request = {}, {
  humanInputEnabled = false,
  providerControlActive = () => false,
  now = () => new Date().toISOString()
} = {}) {
  const value = snapshot && typeof snapshot === 'object' ? snapshot : { rooms: [] };
  const rooms = Array.isArray(value.rooms) ? value.rooms : [];
  const roomId = text(request.roomId, 120);
  const room = rooms.find((entry) => entry?.id === roomId);
  if (!humanInputEnabled) return { ok: false, code: 'DEX_HUMAN_INPUT_LOCKED', message: 'Enable Human Input before deleting a room.' };
  if (!room) return { ok: false, code: 'DEX_ROOM_NOT_FOUND', message: 'The exact room no longer exists.' };
  if (text(request.confirmName, 80) !== text(room.name, 80)) return { ok: false, code: 'DEX_ROOM_CONFIRMATION_MISMATCH', message: 'Room identity changed; review it before deleting.' };
  if (rooms.length <= 1) return { ok: false, code: 'DEX_ROOM_LAST_ROOM', message: 'Create another room before deleting the final room.' };
  if (executionBusy(room)) return { ok: false, code: 'DEX_ROOM_EXECUTION_BUSY', message: 'Stop active relay, recovery, and deferred work before deleting this room.' };
  const pending = room.pendingProviderControlReceipt || null;
  if (pending && providerControlActive(room, pending)) return { ok: false, code: 'DEX_PROVIDER_CONTROL_ACTIVE', message: 'A correlated provider-control request is still active; the room was not deleted.' };
  if (pending && request.retireUnresolved !== true) return { ok: false, code: 'DEX_UNRESOLVED_RECEIPT_CONFIRMATION_REQUIRED', message: 'This room has an unresolved provider-control receipt. Confirm archival before deleting it.' };

  const remaining = rooms.filter((entry) => entry?.id !== room.id);
  const archive = Array.isArray(value.retiredProviderControlReceipts)
    ? value.retiredProviderControlReceipts.slice(-(MAX_RETIRED_RECEIPTS - 1)) : [];
  if (pending) archive.push(archiveEntry(room, now()));
  return {
    ok: true,
    message: pending ? 'Room deleted; unresolved receipt evidence was archived.' : 'Room deleted.',
    snapshot: {
      ...value,
      rooms: remaining,
      activeRoomId: remaining.some((entry) => entry.id === value.activeRoomId)
        ? value.activeRoomId : remaining[0]?.id || null,
      retiredProviderControlReceipts: archive,
      savedAt: now()
    },
    data: { deletedRoomId: room.id, archivedUnresolvedReceipt: !!pending }
  };
}

module.exports = { MAX_RETIRED_RECEIPTS, archiveEntry, deleteRoom };
