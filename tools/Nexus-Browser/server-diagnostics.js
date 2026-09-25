'use strict';

function createDiagnosticsSnapshot(readContext) {
  return function diagnosticsSnapshot() {
    const { dexStateStore, durability, localTargets, extensionSocket, extensionSessions, uiSockets, lastTabs, lastLocalTargets, dexScheduler, providerControlRouting, providerTargetSpawnRouting, postIdleMaintenance, taskCompletion, streamNudgeAuth, SERVER_SESSION_ID, ASSET_REVISION, WebSocket } = readContext();
  const snapshot = dexStateStore.load(), rooms = Array.isArray(snapshot?.rooms) ? snapshot.rooms : [];
  return {
    ok: true, supervised: (process.env.NEXUS_BROWSER_SUPERVISED || process.env.BROWSER_AI_BRIDGE_SUPERVISED) === '1', serverSessionId: SERVER_SESSION_ID, assetRevision: ASSET_REVISION,
    extensionConnected: !!extensionSocket && extensionSocket.readyState === WebSocket.OPEN,
    dexUiConnected: [...uiSockets].some((peer) => peer.clientKind === 'dex'),
    uiClients: uiSockets.size, onlineTargets: lastTabs.length, localTargets: lastLocalTargets.length, localDiscovery: localTargets.discoveryDiagnostics(), extensionSessions: extensionSessions.diagnostics(),
    dexRooms: rooms.length, postIdle: postIdleMaintenance?.diagnostics?.() || null, taskCompletion: taskCompletion?.diagnostics?.() || null, streamNudge: streamNudgeAuth?.diagnostics?.() || null, recoveryRooms: rooms.filter((room) => !!room.recovery).length, savedAt: snapshot?.savedAt || null,
    providerBlocks: lastTabs.filter((tab) => tab.health?.blocking).map((tab) => ({ tabId: tab.id, providerId: tab.providerId, health: tab.health })),
    durability: durability.diagnostics(), stateRepair: dexStateStore.diagnostics(), orchestration: dexScheduler?.diagnostics?.() || null,
    controlPlane: { providerControlPending: providerControlRouting?.pending?.size || 0, agentExtensionReload: providerControlRouting?.agentExtensionReload?.diagnostics?.() || null, controlReceiptsPending: rooms.filter((room) => !!room.pendingProviderControlReceipt).length, targetOperationsPending: providerTargetSpawnRouting?.pending?.size || 0, expiredSpawnCleanup: providerTargetSpawnRouting?.expiredSpawns?.size || 0 }
  };
  };
}

module.exports = { createDiagnosticsSnapshot };
