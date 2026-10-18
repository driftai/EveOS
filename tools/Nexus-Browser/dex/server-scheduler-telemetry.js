'use strict';
// Pure, read-only projections used by Dex diagnostics and the terminal client.
// No dispatch, durable mutation, grant, or lease ownership in this module.
function diagnostics({ current, load, stateApi, lease, recovery }) {
    const snapshot = load();
    const activeRoom = current ? stateApi.roomById(snapshot, current.roomId) : null;
    const active = current ? {
      roomId: current.roomId, memberId: current.memberId, requestId: current.requestId,
      phase: current.phase, retryCount: current.retryCount || 0,
      targetId: current.targetId || null,
      ...(lease.diagnostics() || {}),
      dispatched: !!activeRoom?.recovery?.dispatched,
      recoveryPending: !!activeRoom?.recovery
    } : null;
    return { owner: 'localhost', current: active,
      queuedIncoming: (snapshot.rooms || []).map((room) => ({ roomId: room.id, queued: (room.deferredRelays || []).length })).filter((entry) => entry.queued),
      pendingRooms: stateApi.pendingRooms(snapshot).map((room) => room.id),
      recoveryRooms: (snapshot.rooms || []).filter((room) => !!room.recovery).map((room) => room.id),
      recovery: recovery.diagnostics() };
}
function terminalLiveState(current, roomId) {
    if (!current || current.roomId !== roomId) return null;
    return { roomId: current.roomId, sourceMessageId: current.sourceMessageId,
      requestId: current.requestId, partialText: current.partialText || '' };
}
module.exports = { diagnostics, terminalLiveState };
