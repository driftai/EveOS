'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');

const SCHEMA = 'eveos.tlo-production-activation.v1';
const MODES = new Set(['prepared', 'handed_off', 'active']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const HASH = /^[a-f0-9]{64}$/;
const PREPARE_TTL_MS = 10 * 60 * 1000;
const ACTIVE_LEASE_MS = 60 * 1000;
const MAX_BYTES = 32 * 1024;

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function defaultPath() {
  return path.join(require('../runtime-config').dataDir(), 'tlo-backend-activation.json');
}
function canonical(record) {
  return ['schema','protocolVersion','mode','serverSessionId','sourceFingerprint','scopeId',
    'ownerId','ownerGeneration','browserWorkspaceId','browserGeneration','browserDigest',
    'revision','createdAt','expiresAt'].map((key) => `${key}=${record[key] ?? ''}`).join('\n');
}
function sourceIdentity(root = require('../runtime-config').EVEOS_ROOT, io = fs) {
  const manifestPath = path.join(root, 'config', 'tlo-phase3d-source-manifest.json');
  const manifest = JSON.parse(io.readFileSync(manifestPath, 'utf8'));
  if (manifest?.schema !== 'eveos.tlo-phase3d-source-manifest.v1'
      || typeof manifest.protocolVersion !== 'string' || !Array.isArray(manifest.paths)
      || !manifest.paths.includes('config/tlo-phase3d-source-manifest.json')) {
    throw failure('TLO_DEPLOYMENT_MANIFEST_INVALID', 'Phase 3D source manifest is invalid.');
  }
  const paths = [...new Set(manifest.paths.map(String))].sort();
  const aggregate = createHash('sha256');
  for (const relative of paths) {
    if (!relative || path.isAbsolute(relative) || relative.includes('..'))
      throw failure('TLO_DEPLOYMENT_MANIFEST_INVALID', 'Phase 3D source manifest contains an unsafe path.');
    const body = io.readFileSync(path.join(root, ...relative.split('/')));
    aggregate.update(`${relative}\0${createHash('sha256').update(body).digest('hex')}\n`);
  }
  return Object.freeze({ protocolVersion: manifest.protocolVersion,
    fingerprint: aggregate.digest('hex'), paths: Object.freeze(paths) });
}
function secureWrite(file, record, io = fs) {
  io.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = io.openSync(temp, 'wx', 0o600);
    io.writeFileSync(fd, JSON.stringify(record), 'utf8'); io.fsyncSync(fd);
    io.closeSync(fd); fd = null; io.renameSync(temp, file);
    try { io.chmodSync(file, 0o600); } catch {}
  } finally {
    if (fd != null) io.closeSync(fd);
    try { io.rmSync(temp, { force: true }); } catch {}
  }
}
function publicStatus(record, state = record ? record.mode : 'disabled') {
  return Object.freeze({ state, configured: !!record, active: record?.mode === 'active',
    protocolVersion: record?.protocolVersion || null, serverSessionId: record?.serverSessionId || null,
    sourceFingerprint: record?.sourceFingerprint || null, scopeId: record?.scopeId || 'default',
    owner: record ? { kind: 'backend', id: record.ownerId, generation: record.ownerGeneration } : null,
    browserWorkspaceId: record?.browserWorkspaceId || null, browserGeneration: record?.browserGeneration || null,
    createdAt: record?.createdAt || null, expiresAt: record?.expiresAt || null });
}

function createTloProductionActivation({ filePath = null, serverSessionId,
  source = sourceIdentity(), io = fs, now = Date.now, randomSecret = () => randomBytes(32).toString('base64url') } = {}) {
  const file = filePath || defaultPath();
  if (!path.isAbsolute(file) || !ID.test(String(serverSessionId || ''))
      || !HASH.test(String(source?.fingerprint || '')) || typeof source?.protocolVersion !== 'string') {
    throw new TypeError('TLO production activation configuration is invalid.');
  }

  function validate(record) {
    if (!record || record.schema !== SCHEMA || record.protocolVersion !== source.protocolVersion
        || !MODES.has(record.mode) || !ID.test(String(record.serverSessionId || ''))
        || !HASH.test(String(record.sourceFingerprint || '')) || !ID.test(String(record.ownerId || ''))
        || !Number.isSafeInteger(record.ownerGeneration) || record.ownerGeneration <= 0
        || !ID.test(String(record.browserWorkspaceId || '')) || !Number.isSafeInteger(record.browserGeneration)
        || record.browserGeneration <= 0 || !HASH.test(String(record.browserDigest || ''))
        || !ID.test(String(record.revision || '')) || !Number.isFinite(record.createdAt)
        || !Number.isFinite(record.expiresAt) || typeof record.secret !== 'string' || record.secret.length < 32
        || !HASH.test(String(record.integrity || ''))) {
      throw failure('TLO_DEPLOYMENT_RECORD_INVALID', 'TLO activation record is incomplete or mixed-version.');
    }
    const expected = createHmac('sha256', record.secret).update(canonical(record)).digest('hex');
    const left = Buffer.from(record.integrity, 'hex'), right = Buffer.from(expected, 'hex');
    if (left.length !== right.length || !timingSafeEqual(left, right))
      throw failure('TLO_DEPLOYMENT_RECORD_INVALID', 'TLO activation record integrity failed.');
    if (record.serverSessionId !== serverSessionId || record.sourceFingerprint !== source.fingerprint)
      throw failure('TLO_DEPLOYMENT_MIXED_VERSION', 'TLO activation belongs to another server session or source build.');
    if (now() > record.expiresAt)
      throw failure('TLO_DEPLOYMENT_EXPIRED', `${record.mode === 'active' ? 'Active' : 'Prepared'} TLO activation expired.`);
    return record;
  }
  function read() {
    let stat;
    try { stat = io.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_BYTES)
      throw failure('TLO_DEPLOYMENT_RECORD_INVALID', 'TLO activation record is not a bounded regular file.');
    let record; try { record = JSON.parse(io.readFileSync(file, 'utf8')); }
    catch { throw failure('TLO_DEPLOYMENT_RECORD_INVALID', 'TLO activation record cannot be decoded.'); }
    return validate(record);
  }
  function write(next) {
    const record = { ...next };
    record.integrity = createHmac('sha256', record.secret).update(canonical(record)).digest('hex');
    secureWrite(file, record, io); return validate(record);
  }
  function prepare({ ownerId, ownerGeneration, browserWorkspaceId, browserGeneration, browserDigest } = {}) {
    const existing = read();
    if (existing) throw failure('TLO_DEPLOYMENT_ALREADY_PREPARED', 'TLO activation is already prepared or active.');
    const stamp = now();
    return publicStatus(write({ schema: SCHEMA, protocolVersion: source.protocolVersion, mode: 'prepared',
      serverSessionId, sourceFingerprint: source.fingerprint, scopeId: 'default', ownerId,
      ownerGeneration, browserWorkspaceId, browserGeneration, browserDigest,
      revision: `tlo-activation-${randomUUID()}`, createdAt: stamp, expiresAt: stamp + PREPARE_TTL_MS,
      secret: randomSecret() }));
  }
  function transition(expected, mode) {
    const record = read();
    if (!record || record.mode !== expected) throw failure('TLO_DEPLOYMENT_STATE_INVALID', `TLO activation must be ${expected}.`);
    return publicStatus(write({ ...record, mode, revision: `tlo-activation-${randomUUID()}`,
      expiresAt: mode === 'active' ? now() + ACTIVE_LEASE_MS : record.expiresAt }));
  }
  function renew() {
    const record = read();
    if (!record || record.mode !== 'active') throw failure('TLO_DEPLOYMENT_STATE_INVALID', 'Only active TLO authority can renew its lease.');
    return publicStatus(write({ ...record, expiresAt: now() + ACTIVE_LEASE_MS }));
  }
  function credentials() { const record = read(); return record ? { ...record } : null; }
  function status() {
    try { return publicStatus(read()); }
    catch (error) { return Object.freeze({ state: 'invalid', active: false, configured: true,
      code: error.code || 'TLO_DEPLOYMENT_RECORD_INVALID', message: error.message }); }
  }
  function disable() {
    const record = read();
    if (!record) return publicStatus(null);
    io.rmSync(file, { force: false }); return publicStatus(null);
  }
  return Object.freeze({ filePath: file, source, prepare,
    markHandedOff: () => transition('prepared', 'handed_off'),
    activate: () => transition('handed_off', 'active'), renew, credentials, status, disable });
}

module.exports = { SCHEMA, PREPARE_TTL_MS, ACTIVE_LEASE_MS, canonical, sourceIdentity, createTloProductionActivation };
