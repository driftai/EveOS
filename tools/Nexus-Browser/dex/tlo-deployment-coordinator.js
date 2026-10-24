'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, createHmac, randomUUID, timingSafeEqual } = require('node:crypto');
const { dataDir } = require('../runtime-config');
const { writeJournal } = require('./post-idle-maintenance');

const INTENT_SCHEMA = 'eveos.tlo-two-service-deployment-intent.v1';
const JOURNAL_SCHEMA = 'eveos.tlo-two-service-deployment-journal.v1';
const RECORD_SCHEMA = 'eveos.tlo-two-service-deployment-record.v1';
const MAX_AUTH_AGE_MS = 5 * 60 * 1000;
const DEFAULT_JOURNAL = path.join(dataDir(), 'tlo-two-service-deployment.json');
const DEFAULT_LOCK = `${DEFAULT_JOURNAL}.lock`;
const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;

function fault(code, message) { return Object.assign(new Error(message), { code }); }
function canonical(value) {
  return ['schema', 'requestId', 'issuedAt', 'expiresAt', 'expectedHead', 'sourceFingerprint',
    'serverSessionId', 'serverPid', 'supervisorPid', 'expectedRooms', 'roomIdentityDigest',
    'controlInstanceId', 'controlSourceFingerprint', 'controlPid',
    'webInstanceId', 'webSourceFingerprint', 'webPidsDigest',
    'webPort', 'modularRoot', 'durableDormancyDigest']
    .map((key) => `${key}=${value[key] ?? ''}`).join('\n');
}
function intentDigest(intent) {
  return createHash('sha256').update(`${canonical(intent)}\nsignature=${intent.signature || ''}`).digest('hex');
}
function arrayDigest(values) {
  return createHash('sha256').update(JSON.stringify([...values].map(String).sort())).digest('hex');
}
function roomIdentity(snapshot = {}) {
  const rooms = Array.isArray(snapshot.rooms) ? snapshot.rooms : [];
  const ids = rooms.map((room) => String(room?.id || ''));
  if (ids.some((id) => !/^room-[A-Za-z0-9-]{6,115}$/.test(id)) || new Set(ids).size !== ids.length) {
    throw fault('TLO_DEPLOYMENT_ROOM_IDENTITY_INVALID', 'Dex room identities are invalid or duplicated.');
  }
  return Object.freeze({ count: ids.length, digest: arrayDigest(ids) });
}
function signDeploymentIntent(secret, inventory, requestId, now = Date.now()) {
  if (typeof secret !== 'string' || secret.length < 32 || !ID.test(String(requestId || ''))) {
    throw fault('TLO_DEPLOYMENT_AUTH_UNAVAILABLE', 'Deployment authorization material is unavailable.');
  }
  const intent = {
    schema: INTENT_SCHEMA, requestId, issuedAt: now, expiresAt: now + MAX_AUTH_AGE_MS,
    expectedHead: inventory.head, sourceFingerprint: inventory.sourceFingerprint,
    serverSessionId: inventory.serverSessionId, serverPid: inventory.serverPid,
    supervisorPid: inventory.supervisorPid, expectedRooms: inventory.dexRooms,
    roomIdentityDigest: inventory.roomIdentityDigest,
    controlInstanceId: inventory.control?.instanceId,
    controlSourceFingerprint: inventory.control?.sourceFingerprint,
    controlPid: inventory.control?.pid,
    webInstanceId: inventory.web?.instanceId,
    webSourceFingerprint: inventory.web?.sourceFingerprint,
    webPidsDigest: arrayDigest(inventory.web?.pids || []),
    webPort: inventory.web?.port, modularRoot: inventory.web?.modularRoot,
    durableDormancyDigest: inventory.durableTloDormancy?.digest,
  };
  intent.signature = createHmac('sha256', secret).update(canonical(intent)).digest('hex');
  return Object.freeze(intent);
}
function verifyDeploymentIntent(secret, intent, now = Date.now(), requireFresh = true) {
  const valid = intent?.schema === INTENT_SCHEMA && ID.test(String(intent.requestId || ''))
    && SHA.test(String(intent.expectedHead || '')) && HASH.test(String(intent.sourceFingerprint || ''))
    && ID.test(String(intent.serverSessionId || '')) && Number.isSafeInteger(intent.serverPid)
    && Number.isSafeInteger(intent.supervisorPid) && Number.isSafeInteger(intent.expectedRooms)
    && intent.expectedRooms > 0 && HASH.test(String(intent.roomIdentityDigest || ''))
    && ID.test(String(intent.controlInstanceId || '')) && ID.test(String(intent.webInstanceId || ''))
    && HASH.test(String(intent.controlSourceFingerprint || '')) && Number.isSafeInteger(intent.controlPid)
    && HASH.test(String(intent.webSourceFingerprint || '')) && HASH.test(String(intent.webPidsDigest || ''))
    && HASH.test(String(intent.durableDormancyDigest || ''))
    && Number.isSafeInteger(intent.webPort) && intent.webPort > 0 && intent.webPort <= 65535
    && path.isAbsolute(String(intent.modularRoot || '')) && Number.isFinite(intent.issuedAt)
    && Number.isFinite(intent.expiresAt) && intent.expiresAt >= intent.issuedAt
    && (!requireFresh || (now >= intent.issuedAt - 5_000 && now <= intent.expiresAt))
    && typeof secret === 'string' && secret.length >= 32 && HASH.test(String(intent.signature || ''));
  if (!valid) throw fault('TLO_DEPLOYMENT_AUTH_INVALID', 'Deployment authorization is invalid or expired.');
  const expected = createHmac('sha256', secret).update(canonical(intent)).digest('hex');
  const left = Buffer.from(intent.signature, 'hex'), right = Buffer.from(expected, 'hex');
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw fault('TLO_DEPLOYMENT_AUTH_INVALID', 'Deployment authorization signature failed.');
  }
  return intent;
}
const RECORD_KEYS = ['code', 'expectedHead', 'finishedAt', 'initialServerSessionId', 'integrity',
  'intentDigest', 'replacementServerSessionId', 'requestId', 'schema', 'sideEffectsStarted',
  'sourceFingerprint', 'stage', 'startedAt', 'state', 'webInstanceId'];
const RECORD_STATES = new Set(['pending', 'blocked', 'uncertain', 'succeeded']);
const RECORD_STAGES = new Set(['preflight', 'web-restart-pending', 'web-verified',
  'nexus-restart-pending', 'complete']);
function recordCanonical(record) {
  return RECORD_KEYS.filter((key) => key !== 'integrity')
    .map((key) => `${key}=${record[key] ?? ''}`).join('\n');
}
function sealRecord(secret, record) {
  const sealed = { ...record };
  sealed.integrity = createHmac('sha256', secret).update(recordCanonical(sealed)).digest('hex');
  return sealed;
}
function validDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function validateRecord(record, secret = null) {
  const keys = record && typeof record === 'object' && !Array.isArray(record)
    ? Object.keys(record).sort() : [];
  const structural = record?.schema === RECORD_SCHEMA && keys.join('|') === [...RECORD_KEYS].sort().join('|')
    && ID.test(String(record.requestId || '')) && HASH.test(String(record.intentDigest || ''))
    && SHA.test(String(record.expectedHead || '')) && HASH.test(String(record.sourceFingerprint || ''))
    && ID.test(String(record.initialServerSessionId || ''))
    && (record.replacementServerSessionId === null || ID.test(String(record.replacementServerSessionId || '')))
    && RECORD_STATES.has(record.state) && RECORD_STAGES.has(record.stage)
    && validDate(record.startedAt) && (record.finishedAt === null || validDate(record.finishedAt))
    && (record.code === null || (typeof record.code === 'string' && record.code.length > 0 && record.code.length <= 96))
    && (record.webInstanceId === null || ID.test(String(record.webInstanceId || '')))
    && typeof record.sideEffectsStarted === 'boolean' && HASH.test(String(record.integrity || ''));
  const stateValid = structural && (
    (record.state === 'pending' && record.stage !== 'complete' && record.finishedAt === null
      && record.code === null && record.sideEffectsStarted === false)
    || (record.state === 'blocked' && record.stage !== 'complete' && record.finishedAt !== null
      && record.code !== null && record.sideEffectsStarted === false)
    || (record.state === 'uncertain' && record.stage !== 'complete' && record.finishedAt !== null
      && record.code !== null && record.sideEffectsStarted === true)
    || (record.state === 'succeeded' && record.stage === 'complete' && record.finishedAt !== null
      && record.code === null && record.sideEffectsStarted === true
      && record.webInstanceId !== null && record.replacementServerSessionId !== null));
  if (!stateValid) throw fault('TLO_DEPLOYMENT_JOURNAL_INVALID', 'Deployment journal record is malformed.');
  if (secret !== null) {
    if (typeof secret !== 'string' || secret.length < 32) {
      throw fault('TLO_DEPLOYMENT_JOURNAL_INVALID', 'Deployment journal authentication is unavailable.');
    }
    const expected = createHmac('sha256', secret).update(recordCanonical(record)).digest('hex');
    const left = Buffer.from(record.integrity, 'hex'), right = Buffer.from(expected, 'hex');
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      throw fault('TLO_DEPLOYMENT_JOURNAL_INVALID', 'Deployment journal record integrity failed.');
    }
  }
  return record;
}
function readJournal(file = DEFAULT_JOURNAL, io = fs, secret = null) {
  if (!io.existsSync(file)) return { schema: JOURNAL_SCHEMA, records: [] };
  const stat = io.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 256 * 1024) {
    throw fault('TLO_DEPLOYMENT_JOURNAL_INVALID', 'Deployment journal is not a bounded regular file.');
  }
  let value; try { value = JSON.parse(io.readFileSync(file, 'utf8')); } catch {}
  if (value?.schema !== JOURNAL_SCHEMA || !Array.isArray(value.records) || value.records.length > 32) {
    throw fault('TLO_DEPLOYMENT_JOURNAL_INVALID', 'Deployment journal cannot be trusted.');
  }
  const requestIds = new Set();
  for (const record of value.records) {
    validateRecord(record, secret);
    if (requestIds.has(record.requestId)) {
      throw fault('TLO_DEPLOYMENT_JOURNAL_INVALID', 'Deployment journal has duplicate request identities.');
    }
    requestIds.add(record.requestId);
  }
  return value;
}
function publicRecord(record) {
  return record ? { requestId: record.requestId, state: record.state, stage: record.stage,
    startedAt: record.startedAt, finishedAt: record.finishedAt || null,
    code: record.code || null, webInstanceId: record.webInstanceId || null,
    serverSessionId: record.replacementServerSessionId || null } : null;
}
function idleAndDisabled(value, allowLegacyNull = false) {
  const pending = value?.pending;
  const disabled = value?.tlo?.deployment?.state === 'disabled'
    || (allowLegacyNull && value?.sourceLoaded === false && value?.tlo?.deployment == null);
  return !!pending && Object.values(pending).every((count) => Number.isSafeInteger(count) && count === 0)
    && disabled && value.tlo?.uncertain !== true && !value.tlo?.handoff
    && value.durableTloDormancy?.proven === true;
}
function exactPreflight(intent, value) {
  return value?.branch === 'eve/nexus-machine-spaces' && value.head === intent.expectedHead
    && value.remoteHead === intent.expectedHead && value.clean === true
    && value.sourceFingerprint === intent.sourceFingerprint
    && value.serverSessionId === intent.serverSessionId && value.serverPid === intent.serverPid
    && value.supervisorPid === intent.supervisorPid && value.dexRooms === intent.expectedRooms
    && value.roomIdentityDigest === intent.roomIdentityDigest && idleAndDisabled(value, true)
    && value.durableTloDormancy.digest === intent.durableDormancyDigest
    && value.control?.instanceId === intent.controlInstanceId && value.control?.running === true
    && value.control?.sourceFingerprint === intent.controlSourceFingerprint
    && value.control?.pid === intent.controlPid && value.control?.identityVerified === true
    && value.web?.instanceId === intent.webInstanceId
    && value.web?.sourceFingerprint === intent.webSourceFingerprint
    && arrayDigest(value.web?.pids || []) === intent.webPidsDigest
    && value.web?.port === intent.webPort && value.web?.modularRoot === intent.modularRoot
    && value.web?.running === true && value.web?.identityVerified === true
    && value.nexus?.owned === true && value.nexus?.supervisorPid === intent.supervisorPid;
}
function baseAfterRestart(intent, value, allowLegacyNull = false) {
  return value?.branch === 'eve/nexus-machine-spaces' && value.head === intent.expectedHead
    && value.remoteHead === intent.expectedHead && value.clean === true
    && value.sourceFingerprint === intent.sourceFingerprint && value.dexRooms === intent.expectedRooms
    && value.roomIdentityDigest === intent.roomIdentityDigest && idleAndDisabled(value, allowLegacyNull)
    && value.durableTloDormancy.digest === intent.durableDormancyDigest
    && value.control?.instanceId === intent.controlInstanceId && value.control?.running === true
    && value.control?.sourceFingerprint === intent.controlSourceFingerprint
    && value.control?.pid === intent.controlPid && value.control?.identityVerified === true;
}
function createDeploymentCoordinator({ readSecret, observe, restartService,
  journalPath = DEFAULT_JOURNAL, lockPath = DEFAULT_LOCK, io = fs, now = Date.now } = {}) {
  if (![readSecret, observe, restartService].every((value) => typeof value === 'function')) {
    throw new TypeError('TLO deployment coordinator requires auth, observation, and lifecycle owners.');
  }
  function save(journal) { writeJournal(journalPath, journal, io); }
  async function execute(intent) {
    const secret = readSecret();
    // An exact completed request may be read back after its authorization TTL,
    // but only after its signature and durable intent binding are verified.
    verifyDeploymentIntent(secret, intent, now(), false);
    io.mkdirSync(path.dirname(lockPath), { recursive: true });
    let lock;
    try { lock = io.openSync(lockPath, 'wx', 0o600); }
    catch { throw fault('TLO_DEPLOYMENT_CONCURRENT', 'Another deployment coordinator owns the one-shot lock.'); }
    let record = null, sideEffect = false, journal, persist = () => {};
    try {
      journal = readJournal(journalPath, io, secret);
      const digest = intentDigest(intent);
      const prior = journal.records.find((entry) => entry.requestId === intent.requestId);
      if (prior && prior.intentDigest !== digest) {
        throw fault('TLO_DEPLOYMENT_REQUEST_CONFLICT', 'Deployment request identity is bound to another signed intent.');
      }
      if (prior?.state === 'succeeded') {
        return { ok: true, deduplicated: true, record: publicRecord(prior) };
      }
      verifyDeploymentIntent(secret, intent, now(), true);
      if (prior || journal.records.some((entry) => ['pending', 'uncertain'].includes(entry.state))) {
        throw fault('TLO_DEPLOYMENT_OUTCOME_UNCERTAIN', 'A deployment is unresolved; never replay it.');
      }
      if (journal.records.some((entry) => entry.state === 'succeeded'
          && entry.expectedHead === intent.expectedHead
          && entry.sourceFingerprint === intent.sourceFingerprint)) {
        throw fault('TLO_DEPLOYMENT_ALREADY_SUCCEEDED', 'This qualified revision already completed its one-shot deployment.');
      }
      if (journal.records.length >= 32) {
        throw fault('TLO_DEPLOYMENT_JOURNAL_FULL', 'Deployment journal is full; owner review is required before another deployment.');
      }
      persist = () => {
        record = sealRecord(secret, record);
        save({ schema: JOURNAL_SCHEMA, records: [...journal.records, record] });
      };
      const before = await observe();
      record = { schema: RECORD_SCHEMA, requestId: intent.requestId, intentDigest: digest,
        expectedHead: intent.expectedHead, sourceFingerprint: intent.sourceFingerprint,
        initialServerSessionId: intent.serverSessionId, replacementServerSessionId: null,
        state: 'pending', stage: 'preflight', startedAt: new Date(now()).toISOString(),
        finishedAt: null, code: null, webInstanceId: null, sideEffectsStarted: false,
        integrity: '0'.repeat(64) };
      if (!exactPreflight(intent, before)) {
        record.state = 'blocked'; record.code = 'TLO_DEPLOYMENT_PREFLIGHT_CHANGED';
        record.finishedAt = new Date(now()).toISOString(); persist();
        throw fault(record.code, 'Exact source, process, room, or web identity changed before deployment.');
      }
      record.stage = 'web-restart-pending'; persist(); sideEffect = true;
      const webReceipt = await restartService('web', intent.webPort);
      if (webReceipt?.ok !== true || webReceipt.serviceRestarted !== true
          || webReceipt.spotify?.restored?.ok !== true) {
        throw fault('TLO_DEPLOYMENT_WEB_RESTART_FAILED', 'Web restart did not return a complete verified receipt.');
      }
      const afterWeb = await observe();
      const freshWeb = baseAfterRestart(intent, afterWeb, true)
        && afterWeb.serverSessionId === intent.serverSessionId && afterWeb.serverPid === intent.serverPid
        && afterWeb.supervisorPid === intent.supervisorPid && afterWeb.web?.identityVerified === true
        && afterWeb.web?.instanceId && afterWeb.web.instanceId !== intent.webInstanceId
        && arrayDigest(afterWeb.web.pids || []) !== intent.webPidsDigest
        && afterWeb.web.sourceFingerprint === webReceipt.expectedSourceFingerprint
        && afterWeb.web.modularRoot === intent.modularRoot;
      if (!freshWeb) throw fault('TLO_DEPLOYMENT_WEB_VERIFY_FAILED', 'Fresh web identity or preserved data scope was not proven.');
      record.stage = 'web-verified'; record.webInstanceId = afterWeb.web.instanceId; persist();
      record.stage = 'nexus-restart-pending'; persist();
      const nexusReceipt = await restartService('nexusBrowser', intent.webPort);
      if (nexusReceipt?.ok !== true || nexusReceipt.serviceRestarted !== true) {
        throw fault('TLO_DEPLOYMENT_NEXUS_RESTART_FAILED', 'Nexus restart did not return a complete verified receipt.');
      }
      const final = await observe();
      const freshNexus = baseAfterRestart(intent, final)
        && final.web?.instanceId === afterWeb.web.instanceId && final.web?.modularRoot === intent.modularRoot
        && final.web?.sourceFingerprint === afterWeb.web.sourceFingerprint
        && final.serverSessionId && final.serverSessionId !== intent.serverSessionId
        && final.serverPid && final.serverPid !== intent.serverPid
        && final.supervisorPid && final.supervisorPid !== intent.supervisorPid
        && final.nexus?.owned === true && final.nexus?.supervisorPid === final.supervisorPid
        && final.sourceLoaded === true && final.tlo?.source?.fingerprint === intent.sourceFingerprint;
      if (!freshNexus) throw fault('TLO_DEPLOYMENT_NEXUS_VERIFY_FAILED', 'Fresh Nexus identity, source, or room continuity was not proven.');
      record.state = 'succeeded'; record.stage = 'complete'; record.sideEffectsStarted = true;
      record.replacementServerSessionId = final.serverSessionId;
      record.finishedAt = new Date(now()).toISOString(); persist();
      return { ok: true, deduplicated: false, record: publicRecord(record) };
    } catch (error) {
      if (record && record.state === 'pending') {
        record.state = sideEffect ? 'uncertain' : 'blocked';
        record.sideEffectsStarted = sideEffect;
        record.code = String(error?.code || 'TLO_DEPLOYMENT_FAILED').slice(0, 96);
        record.finishedAt = new Date(now()).toISOString(); persist();
      }
      throw error;
    } finally {
      if (lock != null) io.closeSync(lock);
      if (lock != null) { try { io.rmSync(lockPath, { force: true }); } catch {} }
    }
  }
  return Object.freeze({ execute, journalPath, lockPath });
}

module.exports = { INTENT_SCHEMA, JOURNAL_SCHEMA, RECORD_SCHEMA, MAX_AUTH_AGE_MS, DEFAULT_JOURNAL, DEFAULT_LOCK,
  canonical, arrayDigest, roomIdentity, signDeploymentIntent, verifyDeploymentIntent,
  intentDigest, sealRecord, readJournal, createDeploymentCoordinator };
