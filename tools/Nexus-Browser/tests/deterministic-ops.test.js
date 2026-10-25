const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { verdict } = require('../scripts/bridge-doctor.js');
const { AREA_TESTS, parseArgs } = require('../scripts/qualify.js');

const ROOT = path.resolve(__dirname, '..');
const supervisor = fs.readFileSync(path.join(ROOT, 'scripts', 'bridge-supervisor.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const startBat = fs.readFileSync(path.join(ROOT, 'START.bat'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('bridge doctor converts diagnostics into a compact actionable verdict', () => {
  const healthy = verdict({
    serverSessionId: 'one', extensionConnected: true, dexUiConnected: true,
    onlineTargets: 2, localTargets: 1, dexRooms: 2, recoveryRooms: 0,
    durability: { turnLedger: { reliable: true, entries: 2, active: 0 }, incidents: { count: 0, last: null } },
    stateRepair: { repairs: [], issues: [] }
  });
  assert.equal(healthy.ok, true);
  assert.deepEqual(healthy.issues, []);

  const degraded = verdict({
    serverSessionId: 'two', extensionConnected: false, dexUiConnected: false,
    onlineTargets: 0, localTargets: 1, dexRooms: 2, recoveryRooms: 1,
    durability: { turnLedger: { reliable: false, entries: 2, active: 1 }, incidents: { count: 1, last: { code: 'TEST' } } },
    stateRepair: { repairs: [{ code: 'FIXED' }], issues: [{ code: 'DUPLICATE_MEMBER_ID' }] }
  });
  assert.equal(degraded.ok, false);
  assert.equal(degraded.issues.length, 4);
  assert.equal(degraded.notes.length, 3);

  const staleRuntime = verdict({
    serverSessionId: 'three', extensionConnected: true, dexUiConnected: true,
    onlineTargets: 1, localTargets: 0, dexRooms: 0, recoveryRooms: 0,
    durability: { turnLedger: { reliable: true }, incidents: { count: 0, last: null } },
    stateRepair: { repairs: [], issues: [] }
  }, { serverLogAvailable: false, serverLogPath: 'server.log' });
  assert.equal(staleRuntime.ok, false);
  assert.ok(staleRuntime.issues.some((item) => /restart START\.bat/i.test(item)));

  const supervisedMissingLog = verdict({
    supervised: true, serverSessionId: 'four', extensionConnected: true, dexUiConnected: true,
    onlineTargets: 1, localTargets: 0, dexRooms: 0, recoveryRooms: 0,
    durability: { turnLedger: { reliable: true }, incidents: { count: 0, last: null } },
    stateRepair: { repairs: [], issues: [] }
  }, { serverLogAvailable: false, serverLogPath: 'server.log' });
  assert.equal(supervisedMissingLog.ok, false);
  assert.ok(supervisedMissingLog.issues.some((item) => /runtime log unavailable/i.test(item)));

  const pendingReceipt = verdict({
    supervised: true, serverSessionId: 'five', extensionConnected: true, dexUiConnected: true,
    onlineTargets: 1, localTargets: 0, dexRooms: 1, recoveryRooms: 0,
    durability: { turnLedger: { reliable: true }, incidents: { count: 0, last: null } },
    stateRepair: { repairs: [], issues: [] },
    controlPlane: { providerControlPending: 0, controlReceiptsPending: 1, targetOperationsPending: 0, expiredSpawnCleanup: 0 }
  }, { serverLogAvailable: true, serverLogPath: 'server.log' });
  assert.equal(pendingReceipt.ok, false);
  assert.ok(pendingReceipt.issues.some((item) => /provider-control receipt/i.test(item)));
});

test('qualification runner maps focused areas without requiring an LLM', () => {
  assert.ok(AREA_TESTS.muse.includes('tests/muse-submit.test.js'));
  assert.ok(AREA_TESTS.recovery.includes('tests/server-scheduler-recovery.test.js'));
  assert.ok(AREA_TESTS.resilience.includes('tests/dex-state-store.test.js'));
  assert.ok(AREA_TESTS.resilience.includes('tests/failure-evidence.test.js'));
  assert.deepEqual(parseArgs(['--area', 'muse', '--full']), { area: 'muse', full: true, verify: false });
  assert.throws(() => parseArgs(['--area', 'unknown']), /Unknown area/);
});

test('START.bat uses visible deterministic supervisor and keeps raw server escape hatch', () => {
  assert.match(startBat, /bridge-supervisor\.js/);
  assert.equal(pkg.scripts.start, 'node scripts/bridge-supervisor.js');
  assert.equal(pkg.scripts['start:raw'], 'node server.js');
  assert.equal(pkg.scripts['rooms:cleanup-disposable'], 'node scripts/dexctl.js cleanup-disposable-rooms');
  assert.match(supervisor, /stdio:\s*\[\s*'inherit'\s*,\s*'pipe'\s*,\s*'pipe'\s*,\s*'ipc'\s*\]/);
  assert.match(supervisor, /spawned\.stdout\?\.on\('data'/);
  assert.match(supervisor, /spawned\.stderr\?\.on\('data'/);
  assert.match(supervisor, /runtimeLog\.append/);
  assert.match(supervisor, /health failed/);
  assert.match(supervisor, /if \(stopping \|\| checkInFlight\) return/);
  assert.match(supervisor, /finally \{\s*checkInFlight = false;/);
});

test('localhost coordinates headed Dex UI runtime and manages client roles', () => {
  assert.match(server, /ws\.clientKind === 'dex'/);
  assert.match(server, /ensureDexClient/);
  assert.match(server, /cleanup_disposable_rooms/);
  assert.match(server, /clientKind === 'maintenance'/);
});
