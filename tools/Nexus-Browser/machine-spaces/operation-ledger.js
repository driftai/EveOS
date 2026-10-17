'use strict';
// Pure server-side contract for Machine Space request/result provenance.
// This module NEVER authorizes an OS operation or stores terminal stdout.
const { createHash } = require('node:crypto');
const MAX_EVENTS = 128, MAX_SUMMARY = 180, MAX_PREVIEW = 400;
const STATES = new Set(['queued', 'running', 'completed', 'failed', 'outcome-unknown']);
const CAPABILITIES = new Set([
  'terminal.exec', 'terminal.inspect',
  'files.list', 'files.stat', 'files.read', 'files.search',
  'files.create', 'files.write', 'files.patch', 'files.move', 'files.delete'
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function error(code, message) { return Object.assign(new Error(message), { code }); }
function identifier(value, label) {
  if (typeof value !== 'string' || !ID.test(value))
    throw error('MACHINE_BAD_ID', label + ' must be a bounded opaque identifier.');
  return value;
}
function plain(value, limit) {
  return String(value || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, limit);
}
function intentDigest(intent) {
  return createHash('sha256').update(JSON.stringify(intent)).digest('hex');
}
function entryFor(ledger, requestId) {
  return ledger.events.find((entry) => entry.requestId === requestId) || null;
}
function ensureLedger(ledger) {
  if (!ledger || typeof ledger !== 'object' || !Array.isArray(ledger.events)
    || ledger.events.length > MAX_EVENTS) throw error('MACHINE_BAD_LEDGER', 'Invalid bounded operation ledger.');
  return ledger;
}
function createLedger({ roomId, spaceId } = {}) {
  return { roomId: identifier(roomId, 'roomId'), spaceId: identifier(spaceId, 'spaceId'), events: [] };
}
function recordRequest(ledger, input, authorizer) {
  ensureLedger(ledger);
  if (typeof authorizer !== 'function')
    throw error('MACHINE_AUTH_REQUIRED', 'The authenticated broker must validate each operation.');
  const intent = {
    roomId: identifier(input?.roomId, 'roomId'),
    spaceId: identifier(input?.spaceId, 'spaceId'),
    requestId: identifier(input?.requestId, 'requestId'),
    actorMemberId: identifier(input?.actorMemberId, 'actorMemberId'),
    sourceMessageId: identifier(input?.sourceMessageId, 'sourceMessageId'),
    terminalId: identifier(input?.terminalId, 'terminalId'),
    grantId: identifier(input?.grantId, 'grantId'),
    capability: input?.capability,
    operationDigest: String(input?.operationDigest || '')
  };
  if (intent.roomId !== ledger.roomId || intent.spaceId !== ledger.spaceId)
    throw error('MACHINE_SCOPE_MISMATCH', 'Operation targets a different room or space.');
  if (!CAPABILITIES.has(intent.capability))
    throw error('MACHINE_BAD_CAPABILITY', 'Unknown operation capability.');
  if (!DIGEST.test(intent.operationDigest))
    throw error('MACHINE_BAD_DIGEST', 'Operation content requires an exact SHA-256 digest.');
  // Authorizer must derive member, terminal, grant and source-message ownership
  // from trusted localhost state, never accept a client-provided approval flag.
  if (authorizer(intent) !== true)
    throw error('MACHINE_ACCESS_DENIED', 'No current scoped broker authorization.');
  const digest = intentDigest(intent);
  const previous = entryFor(ledger, intent.requestId);
  if (previous) {
    if (previous.intentDigest !== digest)
      throw error('MACHINE_REQUEST_ID_CONFLICT', 'Request ID was used for another immutable intent.');
    return { entry: previous, deduplicated: true };
  }
  if (ledger.events.length >= MAX_EVENTS)
    throw error('MACHINE_LEDGER_FULL', 'Operation ledger must be archived before admitting more work.');
  const entry = { ...intent, intentDigest: digest, state: 'queued',
    commandSummary: plain(input.commandSummary, MAX_SUMMARY),
    createdAt: String(input.createdAt || new Date().toISOString()),
    dispatchedAt: null, executionStartedAt: null,
    executionCompletedAt: null, resultPersistedAt: null,
    outputId: null, preview: '', bytes: null, exitCode: null };
  ledger.events.push(entry);
  return { entry, deduplicated: false };
}
function markDispatched(ledger, requestId, dispatchedAt = new Date().toISOString()) {
  ensureLedger(ledger);
  const entry = entryFor(ledger, identifier(requestId, 'requestId'));
  if (!entry) throw error('MACHINE_NOT_FOUND', 'Unknown operation request.');
  if (entry.state !== 'queued' || entry.dispatchedAt)
    throw error('MACHINE_ALREADY_DISPATCHED', 'Never re-dispatch an already claimed operation.');
  entry.dispatchedAt = String(dispatchedAt);
  return entry;
}

function markExecutionStarted(ledger, requestId, executionStartedAt = new Date().toISOString()) {
  ensureLedger(ledger);
  const entry = entryFor(ledger, identifier(requestId, 'requestId'));
  if (!entry) throw error('MACHINE_NOT_FOUND', 'Unknown operation request.');
  if (entry.state !== 'queued' || !entry.dispatchedAt)
    throw error('MACHINE_NOT_DISPATCHED', 'Execution cannot start before dispatch.');
  if (entry.executionStartedAt)
    throw error('MACHINE_ALREADY_STARTED', 'Execution start cannot be replayed.');
  entry.executionStartedAt = String(executionStartedAt);
  entry.state = 'running';
  return entry;
}

function markExecutionCompleted(ledger, requestId, executionCompletedAt = new Date().toISOString()) {
  ensureLedger(ledger);
  const entry = entryFor(ledger, identifier(requestId, 'requestId'));
  if (!entry) throw error('MACHINE_NOT_FOUND', 'Unknown operation request.');
  if (entry.state !== 'running' || !entry.executionStartedAt)
    throw error('MACHINE_NOT_RUNNING', 'Execution cannot complete before it starts.');
  if (entry.executionCompletedAt)
    throw error('MACHINE_ALREADY_COMPLETED', 'Execution completion cannot be replayed.');
  entry.executionCompletedAt = String(executionCompletedAt);
  return entry;
}

// Compatibility owner for callers that have not yet split dispatch/start.
// Production Machine Spaces uses the explicit boundaries above.
function markRunning(ledger, requestId, startedAt = new Date().toISOString()) {
  ensureLedger(ledger);
  const entry = entryFor(ledger, identifier(requestId, 'requestId'));
  if (!entry) throw error('MACHINE_NOT_FOUND', 'Unknown operation request.');
  if (entry.state !== 'queued' || entry.dispatchedAt)
    throw error('MACHINE_ALREADY_DISPATCHED', 'Never re-dispatch an already claimed operation.');
  markDispatched(ledger, requestId, startedAt);
  return markExecutionStarted(ledger, requestId, startedAt);
}
function settle(ledger, { requestId, state, outputId, preview = '', bytes = null,
  exitCode = null, finishedAt = new Date().toISOString() } = {}) {
  ensureLedger(ledger);
  const entry = entryFor(ledger, identifier(requestId, 'requestId'));
  if (!entry) throw error('MACHINE_NOT_FOUND', 'Unknown operation request.');
  if (!['completed', 'failed', 'outcome-unknown'].includes(state))
    throw error('MACHINE_BAD_STATE', 'Only terminal states may settle an operation.');
  if (entry.state === state && entry.finishedAt)
    return { entry, deduplicated: true };
  const failedBeforeExecutionStart = entry.state === 'queued'
    && state === 'failed'
    && !!entry.dispatchedAt
    && !entry.executionStartedAt;
  if (entry.state !== 'running'
    && !(entry.state === 'queued' && state === 'outcome-unknown')
    && !failedBeforeExecutionStart)
    throw error('MACHINE_ALREADY_SETTLED', 'A settled/unknown command cannot be replayed or rewritten.');
  if (state !== 'outcome-unknown' && !outputId)
    throw error('MACHINE_OUTPUT_REQUIRED', 'Settled commands require a durable output reference.');
  entry.outputId = outputId ? identifier(outputId, 'outputId') : null;
  entry.state = state;
  if (state !== 'outcome-unknown') entry.resultPersistedAt = String(finishedAt);
  entry.preview = plain(preview, MAX_PREVIEW);
  entry.bytes = Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
  entry.exitCode = Number.isInteger(exitCode) ? exitCode : null;
  entry.finishedAt = String(finishedAt);
  return { entry, deduplicated: false };
}
function stageAgeMs(stageSince, now) {
  if (!stageSince) return null;
  const since = Date.parse(String(stageSince));
  const current = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(since) || !Number.isFinite(current)) return null;
  return Math.max(0, current - since);
}

function lifecycleProjection(entry, now = new Date()) {
  if (!STATES.has(entry?.state))
    throw error('MACHINE_BAD_STATE', 'Unexpected operation state.');

  const acceptedAt = entry.createdAt || null;
  let currentStage = 'accepted';
  let stageSince = acceptedAt;

  if (entry.dispatchedAt) {
    currentStage = 'dispatched';
    stageSince = entry.dispatchedAt;
  }
  if (entry.executionStartedAt) {
    currentStage = 'execution-started';
    stageSince = entry.executionStartedAt;
  }
  if (entry.executionCompletedAt) {
    currentStage = 'execution-completed';
    stageSince = entry.executionCompletedAt;
  }
  if (entry.resultPersistedAt) {
    currentStage = 'result-persisted';
    stageSince = entry.resultPersistedAt;
  }
  if (entry.state === 'failed') {
    currentStage = 'failed';
    stageSince = entry.resultPersistedAt || entry.finishedAt || stageSince;
  }
  if (entry.state === 'outcome-unknown') {
    currentStage = 'uncertain';
    stageSince = entry.finishedAt || stageSince;
  }

  return {
    currentStage,
    stageSince,
    stageAgeMs: stageAgeMs(stageSince, now),
    acceptedAt,
    dispatchedAt: entry.dispatchedAt || null,
    executionStartedAt: entry.executionStartedAt || null,
    executionCompletedAt: entry.executionCompletedAt || null,
    resultPersistedAt: entry.resultPersistedAt || null
  };
}

function projection(entry, now = new Date()) {
  if (!STATES.has(entry?.state))
    throw error('MACHINE_BAD_STATE', 'Unexpected operation state.');
  const { intentDigest, ...publicEntry } = entry;
  return { ...publicEntry, lifecycle: lifecycleProjection(entry, now) };
}
module.exports = { MAX_EVENTS, MAX_SUMMARY, MAX_PREVIEW, CAPABILITIES, createLedger, recordRequest,
  markDispatched, markExecutionStarted, markExecutionCompleted, markRunning,
  settle, lifecycleProjection, projection, entryFor };
