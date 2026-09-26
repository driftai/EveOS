'use strict';
// Pure, broker-attested metadata inventory. This file cannot spawn, attach or
// execute any terminal. An inventory match is NOT filesystem or shell approval.
const CLASS = 'terminal-origin';
const TYPES = new Set(['cmd', 'powershell', 'pwsh', 'wsl', 'supervised-server']);
const ORIGINS = new Set(['managed', 'existing']);
const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const MAX_TARGETS = 64;
function invalid(code, message) { return Object.assign(new Error(message), { code }); }
function opaque(value, name) {
  if (typeof value !== 'string' || !ID.test(value))
    throw invalid('MACHINE_BAD_TARGET_ID', name + ' requires a bounded opaque identifier.');
  return value;
}
function buildInventory({ deviceId, records, attest } = {}) {
  opaque(deviceId, 'deviceId');
  if (typeof attest !== 'function')
    throw invalid('MACHINE_ATTESTOR_REQUIRED', 'Only a trusted native broker can attest target identity.');
  if (!Array.isArray(records) || records.length > MAX_TARGETS)
    throw invalid('MACHINE_TARGET_LIMIT', 'Invalid or oversized discovery snapshot.');
  const targets = [], seen = new Set();
  for (const candidate of records) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      throw invalid('MACHINE_BAD_TARGET', 'Discovery returned an invalid target.');
    const targetId = opaque(candidate.targetId, 'targetId');
    if (seen.has(targetId))
      throw invalid('MACHINE_AMBIGUOUS_TARGET', 'Duplicate target identity cannot be selected.');
    seen.add(targetId);
    // The callback must obtain identity directly from a broker-controlled
    // process handle/session table, not trust candidate.verified or caller flags.
    const proof = attest(candidate);
    if (!proof || proof.verified !== true || proof.targetId !== targetId
      || proof.deviceId !== deviceId || !ID.test(String(proof.processEpoch || ''))
      || !ORIGINS.has(proof.sessionOrigin))
      throw invalid('MACHINE_UNVERIFIED_TARGET', 'Target lacks exact native identity evidence.');
    if (!TYPES.has(candidate.type) || (candidate.type === 'wsl' && !proof.wslVerified))
      throw invalid('MACHINE_BAD_TARGET_TYPE', 'Unrecognized or unverified terminal type.');
    const label = String(candidate.label || candidate.type)
      .replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 80);
    const pid = Number.isSafeInteger(proof.pid) && proof.pid > 0 ? proof.pid : null;
    const outputInspectable = proof.outputInspectable === true;
    targets.push(Object.freeze({
      targetClassId: CLASS, deviceId, targetId, type: candidate.type,
      sessionOrigin: proof.sessionOrigin, processEpoch: proof.processEpoch,
      pid, label, outputInspectable,
      // A managed session may support later broker-granted operations. An
      // existing terminal remains discovery-only pending an exact attach proof.
      attachStatus: proof.sessionOrigin === 'existing' ? 'discovery-only' : 'approval-required'
    }));
  }
  return Object.freeze({ version: 1, targetClassId: CLASS, deviceId,
    targets: Object.freeze(targets) });
}
function resolveExact(inventory, { deviceId, targetId, processEpoch } = {}) {
  if (inventory?.targetClassId !== CLASS || inventory.deviceId !== deviceId
    || !ID.test(String(targetId || '')) || !ID.test(String(processEpoch || '')))
    return null;
  const candidates = (inventory.targets || []).filter((target) => target.targetId === targetId
    && target.processEpoch === processEpoch && target.deviceId === deviceId);
  return candidates.length === 1 ? candidates[0] : null;
}
module.exports = { CLASS, TYPES, ORIGINS, MAX_TARGETS, buildInventory, resolveExact };
