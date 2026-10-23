function executionBusy(room) {
  return !!room && (
    !!room.recovery ||
    !!room.pendingTurn ||
    (room.deferredRelays || []).length > 0 ||
    !!room.relay?.active ||
    !!room.relay?.waitingFor
  );
}
function runtimeBusy(room) {
  return executionBusy(room) || !!room?.pendingProviderControlReceipt;
}

// Historical engineering-cycle notices were accidentally persisted without an ID or
// timestamp. Match ONLY that exact legacy notification shape when merging a browser
// mirror; preserve other ID-less messages and every existing server record.
function legacyPreparedNoticeKey(message) {
  if (!message || message.id || message.at || message.senderKind !== 'system'
      || message.senderName !== 'Machine Spaces' || typeof message.text !== 'string') return null;
  const lines = message.text.split('\n');
  if (lines[0] !== '[ENGINEERING RECOVERY PREPARED]'
      || !/^incident=machine-job-[A-Za-z0-9-]+$/.test(lines[1] || '')
      || !/^proposal=[A-Za-z0-9:_-]+$/.test(lines[2] || '')
      || !/^recoveryJob=machine-job-[A-Za-z0-9-]+$/.test(lines[3] || '')) return null;
  return JSON.stringify([message.text, message.engineeringRecoveryPrepared || null]);
}
function mergeMessages(serverMessages = [], clientMessages = []) {
  const merged = serverMessages.map((message) => ({ ...message }));
  const ids = new Set(merged.map((message) => message?.id).filter(Boolean));
  const legacyKeys = new Set(merged.map(legacyPreparedNoticeKey).filter(Boolean));
  for (const message of clientMessages || []) {
    if (message?.id && ids.has(message.id)) continue;
    const legacyKey = legacyPreparedNoticeKey(message);
    if (legacyKey && legacyKeys.has(legacyKey)) continue;
    merged.push({ ...message });
    if (message?.id) ids.add(message.id);
    if (legacyKey) legacyKeys.add(legacyKey);
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

function mergeSettings(serverRoom, clientRoom) {
  const server = serverRoom.settings || {}, client = clientRoom.settings || {};
  const merged = { ...server, ...client };
  if (Number(server.budgetRevision || 0) > Number(client.budgetRevision || 0)) {
    merged.maxTurns = server.maxTurns;
    merged.contextDefaultMessages = server.contextDefaultMessages;
    merged.budgetRevision = server.budgetRevision;
  }
  return merged;
}
function mergeIdleRoom(serverRoom, clientRoom) {
  const client = clientRoom && typeof clientRoom === 'object' ? clientRoom : {};
  const messages = Array.isArray(client.messages) && client.messages.length === 0
    ? []
    : mergeMessages(serverRoom.messages || [], client.messages || []);
  const merged = { ...client, terminalBootstrap: serverRoom.terminalBootstrap || null, userRelayReceipts: Array.isArray(serverRoom.userRelayReceipts) ? serverRoom.userRelayReceipts : [], settings: mergeSettings(serverRoom, client), ...mergeDoneWatchFields(serverRoom, client), messages, finalReceipts: serverRoom.finalReceipts || [], lastHeadsUp: serverRoom.lastHeadsUp || null, deferredRelays: serverRoom.deferredRelays || [], deferredSendReceipts: serverRoom.deferredSendReceipts || [], lateFinalWatches: serverRoom.lateFinalWatches || [], localToolResults: serverRoom.localToolResults || [], localToolResultFailure: serverRoom.localToolResultFailure || null, engineeringIncidentReceipts: serverRoom.engineeringIncidentReceipts || [], machineSpaces: serverRoom.machineSpaces || client.machineSpaces || null, relay: { ...(serverRoom.relay || {}) } };
  delete merged.pendingTurn;
  delete merged.recovery;
  // Only localhost can create/correlate control intents. An idle server room
  // has none; old UI mirrors must not resurrect one after receipt settlement.
  delete merged.pendingProviderControlReceipt;
  return merged;
}

function mergeBusyRoom(serverRoom, clientRoom) {
  const client = clientRoom && typeof clientRoom === 'object' ? clientRoom : {};
  return {
    ...serverRoom,
    ...mergeDoneWatchFields(serverRoom, client),
    finalReceipts: serverRoom.finalReceipts || [],
    deferredRelays: serverRoom.deferredRelays || [], deferredSendReceipts: serverRoom.deferredSendReceipts || [], lateFinalWatches: serverRoom.lateFinalWatches || [],
    localToolResults: serverRoom.localToolResults || [], localToolResultFailure: serverRoom.localToolResultFailure || null, engineeringIncidentReceipts: serverRoom.engineeringIncidentReceipts || [], machineSpaces: serverRoom.machineSpaces || client.machineSpaces || null,
    ...(client.name != null ? { name: client.name } : {}),
    ...(client.userName != null ? { userName: client.userName } : {}),
    ...(client.settings && typeof client.settings === 'object' ? {
      settings: mergeSettings(serverRoom, client)
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

function mergeReceiptPendingRoom(serverRoom, clientRoom) {
  const merged = mergeIdleRoom(serverRoom, clientRoom);
  merged.messages = mergeMessages(serverRoom.messages || [], clientRoom?.messages || []);
  merged.pendingProviderControlReceipt = { ...serverRoom.pendingProviderControlReceipt };
  return merged;
}

function mergeClientSnapshot(serverSnapshot, clientSnapshot) {
  const server = serverSnapshot && typeof serverSnapshot === 'object' ? serverSnapshot : {};
  const client = clientSnapshot && typeof clientSnapshot === 'object' ? clientSnapshot : {};
  const serverRooms = Array.isArray(server.rooms) ? server.rooms : [];
  const clientRooms = Array.isArray(client.rooms) ? client.rooms : [];
  // Canonical retirement fence: client snapshots cannot inject or remove these IDs.
  const retiredRoomIds = Array.isArray(server.retiredRoomIds) ? server.retiredRoomIds : [];
  const retiredSet = new Set(retiredRoomIds);
  const clientById = new Map(clientRooms.map((room) => [room?.id, room]));
  const serverIds = new Set(serverRooms.map((room) => room?.id).filter(Boolean));
  const rooms = [];

  for (const serverRoom of serverRooms) {
    if (!serverRoom?.id) continue;
    const clientRoom = clientById.get(serverRoom.id);
    if (executionBusy(serverRoom)) rooms.push(mergeBusyRoom(serverRoom, clientRoom));
    else if (serverRoom.pendingProviderControlReceipt && clientRoom) rooms.push(mergeReceiptPendingRoom(serverRoom, clientRoom));
    else if (serverRoom.pendingProviderControlReceipt) rooms.push(serverRoom);
    else if (clientRoom) rooms.push(mergeIdleRoom(serverRoom, clientRoom));
    else if (serverRoom.terminalBootstrap?.schema === 'eveos.dex-tlo-scripted-bootstrap.v1') rooms.push(serverRoom); // Headless-created test rooms survive stale viewers.
    else continue;
  }

  for (const clientRoom of clientRooms) {
    if (!clientRoom?.id || serverIds.has(clientRoom.id) || retiredSet.has(clientRoom.id)) continue;
    rooms.push(clientRoom);
  }

  return {
    version: Number(server.version || client.version || 1),
    rooms,
    retiredRoomIds: [...retiredRoomIds],
    // Receipt retirement is a localhost-owned audit ledger. Preserve the
    // canonical copy across ordinary viewer saves and ignore client injection.
    retiredProviderControlReceipts: Array.isArray(server.retiredProviderControlReceipts)
      ? server.retiredProviderControlReceipts
      : [],
    activeRoomId: rooms.some((room) => room.id === client.activeRoomId)
      ? client.activeRoomId
      : rooms.some((room) => room.id === server.activeRoomId)
        ? server.activeRoomId
        : rooms[0]?.id || null,
    savedAt: new Date().toISOString()
  };
}

module.exports = {
  executionBusy,
  runtimeBusy,
  mergeMessages,
  mergeCheckpoints,
  mergeDoneWatchFields,
  mergeIdleRoom,
  mergeBusyRoom,
  mergeReceiptPendingRoom,
  mergeClientSnapshot
};
