'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDiagnosticsSnapshot } = require('../server-diagnostics');

test('HTTP diagnostics derive fresh state and preserve the source snapshot', () => {
  const saved = { rooms: [{ id: 'r1', recovery: {}, pendingProviderControlReceipt: true }, { id: 'r2' }], savedAt: '2026-09-24T12:00:00.000Z' };
  let tabs = [];
  const context = {
    dexStateStore: { load: () => saved, diagnostics: () => ({ repairs: [] }) },
    durability: { diagnostics: () => ({ incidents: 0 }) },
    localTargets: { discoveryDiagnostics: () => ({ antigravityExisting: { rejected: [{ pid: 10872, code: 'CONSOLE_PROBE_FAILED' }] } }) },
    appTargetController: { diagnostics: () => ({ targets: 1, discovery: { ok: true }, passive: { bindings: [], ledger: { pending: 0 } } }) },
    extensionSocket: { readyState: 1 }, extensionSessions: { diagnostics: () => ({ ready: true }) },
    uiSockets: new Set([{ clientKind: 'dex' }]), lastLocalTargets: [],
    dexScheduler: { diagnostics: () => ({ queued: 0 }) },
    providerControlRouting: { pending: new Map() },
    providerTargetSpawnRouting: { pending: new Map(), expiredSpawns: new Map() },
    SERVER_SESSION_ID: 'session', ASSET_REVISION: 'asset', WebSocket: { OPEN: 1 }
  };
  const read = createDiagnosticsSnapshot(() => ({ ...context, lastTabs: tabs }));
  const first = read();
  assert.equal(first.dexRooms, 2);
  assert.equal(first.recoveryRooms, 1);
  assert.equal(first.serverPid, process.pid);
  assert.equal(first.supervisorPid, process.ppid || null);
  assert.equal(first.controlPlane.controlReceiptsPending, 1);
  assert.equal(first.localDiscovery.antigravityExisting.rejected[0].pid, 10872);
  assert.equal(first.appPassive.ledger.pending, 0);
  tabs = [{ id: 5, providerId: 'chatgpt', health: { blocking: true } }];
  const second = read();
  assert.equal(second.onlineTargets, 1);
  assert.deepEqual(second.providerBlocks.map(tab => tab.tabId), [5]);
  assert.equal(saved.rooms.length, 2);
});
