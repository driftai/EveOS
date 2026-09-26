'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildInventory, resolveExact, MAX_TARGETS } = require('../machine-spaces/terminal-inventory');
const deviceId = 'device-local-one';
function entry(targetId = 'terminal-ps-one', type = 'powershell') {
  return { targetId, type, label: 'My PowerShell', verified: true, execute: true, auth: 'spoofed' };
}
function broker(record) {
  return { verified: true, targetId: record.targetId, deviceId, processEpoch: 'birth-100',
    sessionOrigin: 'managed', pid: 25032, outputInspectable: true, wslVerified: true };
}
const make = (records, attest = broker) => buildInventory({ deviceId, records, attest });
function fails(fn, code) { assert.throws(fn, (err) => err.code === code); }
test('only a native attestor may populate terminal-origin metadata', () => {
  fails(() => buildInventory({ deviceId, records: [entry()] }), 'MACHINE_ATTESTOR_REQUIRED');
  fails(() => make([entry()], () => ({ ...broker(entry()), verified: false })),
    'MACHINE_UNVERIFIED_TARGET');
  fails(() => make([entry()], () => ({ ...broker(entry()), deviceId: 'another-device' })),
    'MACHINE_UNVERIFIED_TARGET');
});
test('managed shell inventory is inert: no caller-provided approval or command privilege leaks', () => {
  const snapshot = make([entry()]);
  assert.equal(snapshot.targetClassId, 'terminal-origin');
  assert.deepEqual(snapshot.targets.map(t => t.attachStatus), ['approval-required']);
  assert.equal(snapshot.targets[0].outputInspectable, true);
  assert.equal(snapshot.targets[0].execute, undefined);
  assert.equal(snapshot.targets[0].auth, undefined);
  assert.equal(snapshot.targets[0].verified, undefined);
  assert.equal(Object.isFrozen(snapshot.targets[0]), true);
  assert.equal(resolveExact(snapshot, { deviceId, targetId: 'terminal-ps-one',
    processEpoch: 'birth-100' }).pid, 25032);
});
test('existing terminal is discoverable but not silently promoted to attached/authorized', () => {
  const snapshot = make([entry('terminal-existing-one', 'cmd')],
    (r) => ({ ...broker(r), sessionOrigin: 'existing', outputInspectable: false }));
  assert.equal(snapshot.targets[0].attachStatus, 'discovery-only');
  assert.equal(snapshot.targets[0].outputInspectable, false);
});
test('same provider with changed PID or process creation epoch cannot inherit selection', () => {
  const snapshot = make([entry()]);
  assert.equal(resolveExact(snapshot, { deviceId, targetId: 'terminal-ps-one',
    processEpoch: 'birth-101' }), null);
  assert.equal(resolveExact(snapshot, { deviceId, targetId: 'terminal-ps-one',
    processEpoch: 'birth-100', pid: 25123 })?.pid, 25032);
  assert.equal(resolveExact(snapshot, { deviceId: 'different', targetId: 'terminal-ps-one',
    processEpoch: 'birth-100' }), null);
});
test('duplicate discovery and malformed identity fail closed', () => {
  fails(() => make([entry(), entry()]), 'MACHINE_AMBIGUOUS_TARGET');
  fails(() => make([{ ...entry(), targetId: '../other' }]), 'MACHINE_BAD_TARGET_ID');
  fails(() => make([entry()], (r) => ({ ...broker(r), targetId: 'other' })),
    'MACHINE_UNVERIFIED_TARGET');
  fails(() => make(Array(MAX_TARGETS + 1).fill(entry())), 'MACHINE_TARGET_LIMIT');
});
test('WSL inventory requires independent broker verification and rejects invented types', () => {
  const wsl = entry('terminal-wsl-one', 'wsl');
  fails(() => make([wsl], r => ({ ...broker(r), wslVerified: false })),
    'MACHINE_BAD_TARGET_TYPE');
  assert.equal(make([wsl]).targets[0].type, 'wsl');
  fails(() => make([entry('terminal-bad', 'custom-shell')]), 'MACHINE_BAD_TARGET_TYPE');
});
