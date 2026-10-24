'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { dataDir } = require('../runtime-config');
const { writeJournal } = require('./post-idle-maintenance');

const SCHEMA = 'eveos.tlo-activation-runner-command.v1';
const JOURNAL_SCHEMA = 'eveos.tlo-activation-runner-journal.v1';
const STAGES = new Set(['deployment', 'history-export', 'handoff', 'activation',
  'rollback', 'first-inference']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const MAX_AUTH_AGE_MS = 2 * 60 * 1000;
const DEFAULT_JOURNAL = path.join(dataDir(), 'tlo-activation-runner-journal.json');

function fault(code, message) { return Object.assign(new Error(message), { code }); }
function payloadDigest(payload = {}) {
  const keys = Object.keys(payload || {}).sort();
  const compact = {};
  for (const key of keys) compact[key] = payload[key];
  return createHash('sha256').update(JSON.stringify(compact)).digest('hex');
}
function canonical(command) {
  return ['schema','stage','requestId','expectedHead','sourceFingerprint','serverSessionId',
    'serverPid','expectedRooms','issuedAt','expiresAt','payloadDigest']
    .map((key) => `${key}=${command[key] ?? ''}`).join('\n');
}
function validateCommand(command, now = Date.now()) {
  if (!command || command.schema !== SCHEMA || !STAGES.has(command.stage)
      || !ID.test(String(command.requestId || '')) || !SHA.test(String(command.expectedHead || ''))
      || !HASH.test(String(command.sourceFingerprint || ''))
      || !ID.test(String(command.serverSessionId || ''))
      || !Number.isSafeInteger(command.serverPid) || command.serverPid <= 1
      || !Number.isSafeInteger(command.expectedRooms) || command.expectedRooms < 1
      || !Number.isFinite(command.issuedAt) || !Number.isFinite(command.expiresAt)
      || command.expiresAt <= command.issuedAt
      || command.expiresAt - command.issuedAt > MAX_AUTH_AGE_MS
      || now < command.issuedAt - 5_000 || now > command.expiresAt
      || payloadDigest(command.payload) !== command.payloadDigest
      || !HASH.test(String(command.signature || ''))) {
    throw fault('TLO_ACTIVATION_AUTH_INVALID', 'Activation authorization is invalid or expired.');
  }
  return command;
}
function signCommand(secret, input, now = Date.now()) {
  if (!/^[a-f0-9]{64}$/i.test(String(secret || ''))) {
    throw fault('TLO_ACTIVATION_AUTH_UNAVAILABLE', 'Private local authorization is unavailable.');
  }
  const issuedAt = Number(input.issuedAt ?? now);
  const command = { schema: SCHEMA, stage: String(input.stage || ''),
    requestId: String(input.requestId || ''), expectedHead: String(input.expectedHead || '').toLowerCase(),
    sourceFingerprint: String(input.sourceFingerprint || '').toLowerCase(),
    serverSessionId: String(input.serverSessionId || ''), serverPid: Number(input.serverPid),
    expectedRooms: Number(input.expectedRooms), issuedAt,
    expiresAt: Number(input.expiresAt ?? (issuedAt + MAX_AUTH_AGE_MS)),
    payload: input.payload && typeof input.payload === 'object' ? { ...input.payload } : {} };
  command.payloadDigest = payloadDigest(command.payload);
  command.signature = createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(`eveos:tlo-activation-runner:v1\n${canonical(command)}`).digest('hex');
  validateCommand(command, now);
  return Object.freeze(command);
}
function verifyCommand(secret, command, now = Date.now()) {
  if (!/^[a-f0-9]{64}$/i.test(String(secret || ''))) {
    throw fault('TLO_ACTIVATION_AUTH_UNAVAILABLE', 'Private local authorization is unavailable.');
  }
  validateCommand(command, now);
  const expected = createHmac('sha256', Buffer.from(String(secret || ''), 'hex'))
    .update(`eveos:tlo-activation-runner:v1\n${canonical(command)}`).digest('hex');
  const left = Buffer.from(command.signature, 'hex'), right = Buffer.from(expected, 'hex');
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw fault('TLO_ACTIVATION_AUTH_INVALID', 'Activation authorization signature is invalid.');
  }
  return command;
}
function readJournal(file, io = fs) {
  if (!io.existsSync(file)) return { schema: JOURNAL_SCHEMA, records: [] };
  const stat = io.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 64 * 1024) {
    throw fault('TLO_ACTIVATION_JOURNAL_INVALID', 'Activation journal is not a bounded regular file.');
  }
  let journal;
  try { journal = JSON.parse(io.readFileSync(file, 'utf8')); }
  catch { throw fault('TLO_ACTIVATION_JOURNAL_INVALID', 'Activation journal cannot be decoded.'); }
  if (journal?.schema !== JOURNAL_SCHEMA || !Array.isArray(journal.records)
      || journal.records.length > 64 || journal.records.some((entry) =>
        !entry || !ID.test(String(entry.requestId || ''))
        || !STAGES.has(entry.stage) || !HASH.test(String(entry.payloadDigest || ''))
        || !['pending', 'uncertain', 'succeeded'].includes(entry.state))) {
    throw fault('TLO_ACTIVATION_JOURNAL_INVALID', 'Activation journal is invalid.');
  }
  return journal;
}
function publicRecord(record) {
  return record ? { requestId: record.requestId, stage: record.stage, state: record.state,
    startedAt: record.startedAt, finishedAt: record.finishedAt || null,
    code: record.code || null } : null;
}
function inspectPrivateStorage(folder = dataDir(), platform = process.platform) {
  try {
    const stat = fs.lstatSync(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { secure: false, reason: 'not-private-directory' };
    if (platform !== 'win32') {
      return { secure: (stat.mode & 0o022) === 0,
        reason: (stat.mode & 0o022) === 0 ? 'private-mode' : 'group-or-world-writable' };
    }
    // Resolve Windows SIDs, not localized account names. Broad write grants
    // to Users / Authenticated Users are unsafe even without an Everyone ACE.
    const script = [
      "$ErrorActionPreference='Stop';",
      '$a=Get-Acl -LiteralPath $env:EVEOS_TLO_ACL_PATH;',
      '$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;',
      '$owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;',
      "$b=@('S-1-1-0','S-1-5-11','S-1-5-32-545','S-1-5-32-546','S-1-5-2');",
      '$unsafe=0;',
      'foreach($ace in $a.Access){',
      'if($ace.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow){continue};',
      'try{$sid=$ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}',
      'catch{$unsafe++;continue};',
      '$rights=$ace.FileSystemRights;',
      '$mask=[Security.AccessControl.FileSystemRights]::WriteData -bor ',
      '[Security.AccessControl.FileSystemRights]::AppendData -bor ',
      '[Security.AccessControl.FileSystemRights]::CreateDirectories -bor ',
      '[Security.AccessControl.FileSystemRights]::Delete -bor ',
      '[Security.AccessControl.FileSystemRights]::ChangePermissions -bor ',
      '[Security.AccessControl.FileSystemRights]::TakeOwnership;',
      'if($b -contains $sid -and (($rights -band $mask) -ne 0)){$unsafe++}',
      '};',
      '[pscustomobject]@{ownerMatches=($owner -eq $me);unsafe=$unsafe}|ConvertTo-Json -Compress'
    ].join(' ');
    const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 5_000, windowsHide: true,
      env: { ...process.env, EVEOS_TLO_ACL_PATH: folder }
    });
    if (probe.status !== 0) return { secure: false, reason: 'acl-probe-failed' };
    const acl = JSON.parse(String(probe.stdout || '').trim());
    return { secure: acl.ownerMatches === true && Number(acl.unsafe) === 0,
      reason: acl.ownerMatches !== true ? 'owner-mismatch'
        : Number(acl.unsafe) === 0 ? 'private-acl' : 'broad-write-grant',
      ownerPresent: acl.ownerMatches === true };
  } catch { return { secure: false, reason: 'acl-unavailable' }; }
}
function createTloActivationRunnerGate({ readSecret, readInventory, operations = {},
  journalPath = DEFAULT_JOURNAL, io = fs, now = Date.now } = {}) {
  if (typeof readSecret !== 'function' || typeof readInventory !== 'function') {
    throw new TypeError('TLO activation runner gate requires private auth and inventory owners.');
  }
  let journal = readJournal(journalPath, io);
  const save = () => writeJournal(journalPath, journal, io);
  function inventory() {
    const value = readInventory();
    return { serverSessionId: value.serverSessionId, serverPid: value.serverPid,
      gitHead: value.gitHead, sourceFingerprint: value.sourceFingerprint,
      dexRooms: value.dexRooms, pending: { ...value.pending },
      tlo: value.tlo || null, journal: journal.records.slice(-8).map(publicRecord) };
  }
  async function execute(command) {
    verifyCommand(readSecret(), command, now());
    const prior = journal.records.find((entry) => entry.requestId === command.requestId);
    if (prior) {
      if (prior.stage !== command.stage || prior.payloadDigest !== command.payloadDigest) {
        throw fault('TLO_ACTIVATION_REQUEST_CONFLICT', 'Activation request ID belongs to different intent.');
      }
      if (prior.state === 'succeeded') return { ok: true, deduplicated: true, record: publicRecord(prior) };
      throw fault('TLO_ACTIVATION_OUTCOME_UNCERTAIN', 'Activation request is unresolved; never replay it.');
    }
    // Inference authorization is a one-shot grant across server restarts.
    // A successful grant is NOT proof of a settled model turn; never mint another.
    if (command.stage === 'first-inference' && journal.records.some((entry) =>
      entry.stage === 'first-inference')) {
      throw fault('TLO_FIRST_INFERENCE_ALREADY_AUTHORIZED',
        'The one-shot inference gate has already been used; reconcile before any further grant.');
    }
    if (journal.records.some((entry) => ['pending', 'uncertain'].includes(entry.state))) {
      throw fault('TLO_ACTIVATION_OUTCOME_UNCERTAIN', 'An earlier activation stage is unresolved.');
    }
    const current = readInventory();
    const mismatch = current.serverSessionId !== command.serverSessionId
      || current.serverPid !== command.serverPid || current.gitHead !== command.expectedHead
      || current.sourceFingerprint !== command.sourceFingerprint
      || current.dexRooms !== command.expectedRooms;
    const pending = !current.pending || Object.values(current.pending).some((value) =>
      !Number.isSafeInteger(value) || value < 0 || value !== 0);
    const badTlo = current.tlo?.uncertain || current.tlo?.handoff;
    const state = current.tlo?.deployment?.state;
    const badStage = command.stage === 'deployment'
      ? state !== 'disabled'
      : command.stage === 'history-export' ? state !== 'disabled'
      : command.stage === 'handoff' ? state !== 'prepared'
      : command.stage === 'activation' ? state !== 'handed_off'
      : command.stage === 'rollback' ? !['handed_off', 'active'].includes(state)
      : command.stage === 'first-inference' ? state !== 'active' : true;
    if (mismatch || pending || badTlo || badStage || current.gitClean !== true
        || current.privateStorage?.secure !== true) {
      throw fault('TLO_ACTIVATION_PREFLIGHT_CHANGED', 'Runtime identity, room count, or idle state changed.');
    }
    const operation = operations[command.stage];
    if (typeof operation !== 'function') {
      throw fault('TLO_ACTIVATION_STAGE_UNAVAILABLE', 'This activation stage is not installed.');
    }
    const record = { requestId: command.requestId, stage: command.stage,
      payloadDigest: command.payloadDigest, state: 'pending', startedAt: new Date(now()).toISOString() };
    journal = { schema: JOURNAL_SCHEMA, records: [...journal.records.slice(-62), record] }; save();
    try {
      const result = await operation({ ...command.payload }, current);
      record.state = 'succeeded'; record.finishedAt = new Date(now()).toISOString(); save();
      return { ok: true, deduplicated: false, record: publicRecord(record), result };
    } catch (error) {
      record.state = 'uncertain'; record.code = String(error?.code || 'TLO_ACTIVATION_STAGE_FAILED').slice(0, 96);
      record.finishedAt = new Date(now()).toISOString(); save();
      throw fault('TLO_ACTIVATION_OUTCOME_UNCERTAIN',
        `Activation stage stopped with uncertain outcome (${record.code}); do not retry.`);
    }
  }
  async function handle(message = {}) {
    const requestId = String(message.requestId || '') || null;
    try {
      if (message.type === 'tlo_activation_status') {
        return { type: 'tlo_activation_result', requestId, ok: true, inventory: inventory() };
      }
      if (message.type !== 'tlo_activation_execute') {
        throw fault('TLO_ACTIVATION_COMMAND_UNKNOWN', 'Unsupported activation runner command.');
      }
      return { type: 'tlo_activation_result', requestId, ...(await execute(message.authorization)) };
    } catch (error) {
      return { type: 'tlo_activation_result', requestId, ok: false,
        code: String(error?.code || 'TLO_ACTIVATION_COMMAND_FAILED').slice(0, 96),
        message: String(error?.message || 'Activation command failed.').slice(0, 240) };
    }
  }
  return Object.freeze({ inventory, execute, handle, journalPath });
}

// Invalid durable runner state must disable only this control plane, not
// take down Nexus or destroy its existing Dex rooms.
function createSafeTloActivationRunnerGate(options) {
  try { return createTloActivationRunnerGate(options); }
  catch (error) {
    return Object.freeze({ handle: async (msg) => ({ type: 'tlo_activation_result',
      requestId: msg?.requestId || null, ok: false,
      code: 'TLO_ACTIVATION_RUNNER_UNAVAILABLE',
      message: 'Runner journal or initialization is unavailable; owner review required.' }) });
  }
}

module.exports = { SCHEMA, JOURNAL_SCHEMA, STAGES, MAX_AUTH_AGE_MS, DEFAULT_JOURNAL,
  canonical, payloadDigest, signCommand, verifyCommand, readJournal,
  inspectPrivateStorage, createTloActivationRunnerGate, createSafeTloActivationRunnerGate };
