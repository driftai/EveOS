function runtimeBusy(room) {
  return !!room && (
    !!room.recovery ||
    !!room.pendingTurn ||
    !!room.relay?.active ||
    !!room.relay?.waitingFor
  );
}

function mergeMessages(serverMessages = [], clientMessages = []) {
  const merged = serverMessages.map((message) => ({ ...message }));
  const ids = new Set(merged.map((message) => message?.id).filter(Boolean));
  for (const message of clientMessages || []) {
    if (message?.id && ids.has(message.id)) continue;
    merged.push({ ...message });
    if (message?.id) ids.add(message.id);
  }
  return merged;
}

function mergeCheckpoints(serverValue, clientValue) {
  return {
    ...(serverValue && typeof serverValue === 'object' ? serverValue : {}),
    ...(clientValue && typeof clientValue === 'object' ? clientValue : {})
  };
}

function mergeDoneWatchFields(serverRoom = {}, clientRoom = {}) {
  // A newer browser arming may supersede the server; a stale browser snapshot
  // must never resurrect a one-shot watch already consumed by the scheduler.
  const useClient = Number(clientRoom.doneWatchRevision || 0) > Number(serverRoom.doneWatchRevision || 0);
  const owner = useClient ? clientRoom : serverRoom;
  return {
    doneWatches: Array.isArray(owner.doneWatches) ? owner.doneWatches : [],
    doneWatchRevision: Number(owner.doneWatchRevision || 0),
    doneWatchEvents: Array.isArray(serverRoom.doneWatchEvents) ? serverRoom.doneWatchEvents : []
  };
}

function mergeIdleRoom(serverRoom, clientRoom) {
  const client = clientRoom && typeof clientRoom === 'object' ? clientRoom : {};
  const messages = Array.isArray(client.messages) && client.messages.length === 0
    ? []
    : mergeMessages(serverRoom.messages || [], client.messages || []);
  const merged = { ...client, ...mergeDoneWatchFields(serverRoom, client), messages, finalReceipts: serverRoom.finalReceipts || [], lastHeadsUp: serverRoom.lastHeadsUp || null, deferredRelays: serverRoom.deferredRelays || [], deferredSendReceipts: serverRoom.deferredSendReceipts || [], lateFinalWatches: serverRoom.lateFinalWatches || [], relay: { ...(serverRoom.relay || {}) } };
  delete merged.pendingTurn;
  delete merged.recovery;
  return merged;
}

function mergeBusyRoom(serverRoom, clientRoom) {
  const client = clientRoom && typeof clientRoom === 'object' ? clientRoom : {};
  return {
    ...serverRoom,
    ...mergeDoneWatchFields(serverRoom, client),
    finalReceipts: serverRoom.finalReceipts || [],
    deferredRelays: serverRoom.deferredRelays || [], deferredSendReceipts: serverRoom.deferredSendReceipts || [], lateFinalWatches: serverRoom.lateFinalWatches || [],
    ...(client.name != null ? { name: client.name } : {}),
    ...(client.userName != null ? { userName: client.userName } : {}),
    ...(client.settings && typeof client.settings === 'object' ? {
      settings: { ...(serverRoom.settings || {}), ...client.settings }
    } : {}),
    agentCheckpoints: mergeCheckpoints(serverRoom.agentCheckpoints, client.agentCheckpoints),
    messages: mergeMessages(serverRoom.messages || [], client.messages || []),
    members: Array.isArray(serverRoom.members) ? serverRoom.members : [],
    relay: { ...(serverRoom.relay || {}) },
    ...(serverRoom.pendingTurn ? { pendingTurn: { ...serverRoom.pendingTurn } } : {}),
    ...(serverRoom.recovery ? { recovery: { ...serverRoom.recovery } } : {}),
    updatedAt: serverRoom.updatedAt || client.updatedAt || null
  };
}

function mergeClientSnapshot(serverSnapshot, clientSnapshot) {
  const server = serverSnapshot && typeof serverSnapshot === 'object' ? serverSnapshot : {};
  const client = clientSnapshot && typeof clientSnapshot === 'object' ? clientSnapshot : {};
  const serverRooms = Array.isArray(server.rooms) ? server.rooms : [];
  const clientRooms = Array.isArray(client.rooms) ? client.rooms : [];
  const clientById = new Map(clientRooms.map((room) => [room?.id, room]));
  const serverIds = new Set(serverRooms.map((room) => room?.id).filter(Boolean));
  const rooms = [];

  for (const serverRoom of serverRooms) {
    if (!serverRoom?.id) continue;
    const clientRoom = clientById.get(serverRoom.id);
    if (runtimeBusy(serverRoom)) rooms.push(mergeBusyRoom(serverRoom, clientRoom));
    else if (clientRoom) rooms.push(mergeIdleRoom(serverRoom, clientRoom));
    else continue;
  }

  for (const clientRoom of clientRooms) {
    if (!clientRoom?.id || serverIds.has(clientRoom.id)) continue;
    rooms.push(clientRoom);
  }

  return {
    version: Number(server.version || client.version || 1),
    rooms,
    activeRoomId: rooms.some((room) => room.id === client.activeRoomId)
      ? client.activeRoomId
      : rooms.some((room) => room.id === server.activeRoomId)
        ? server.activeRoomId
        : rooms[0]?.id || null,
    savedAt: new Date().toISOString()
  };
}

module.exports = {
  runtimeBusy,
  mergeMessages,
  mergeCheckpoints,
  mergeDoneWatchFields,
  mergeIdleRoom,
  mergeBusyRoom,
  mergeClientSnapshot
};