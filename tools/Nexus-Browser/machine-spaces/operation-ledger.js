'use strict';
// Pure server-side contract for Machine Space request/result provenance.
// This module NEVER authorizes an OS operation or stores terminal stdout.
const { createHash } = require('node:crypto');
const MAX_EVENTS = 128, MAX_SUMMARY = 180, MAX_PREVIEW = 400;
const STATES = new Set(['queued', 'running', 'completed', 'failed', 'outcome-unknown']);
const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

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
    capability: input?.capability
  };
  if (intent.roomId !== ledger.roomId || intent.spaceId !== ledger.spaceId)
    throw error('MACHINE_SCOPE_MISMATCH', 'Operation targets a different room or space.');
  if (!['terminal.exec', 'terminal.inspect', 'files.list', 'files.read', 'files.edit'].includes(intent.capability))
    throw error('MACHINE_BAD_CAPABILITY', 'Unknown operation capability.');
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
    outputId: null, preview: '', bytes: null, exitCode: null };
  ledger.events.push(entry);
  return { entry, deduplicated: false };
}
function markRunning(ledger, requestId) {
  ensureLedger(ledger);
  const entry = entryFor(ledger, identifier(requestId, 'requestId'));
  if (!entry) throw error('MACHINE_NOT_FOUND', 'Unknown operation request.');
  if (entry.state !== 'queued') throw error('MACHINE_ALREADY_DISPATCHED', 'Never re-dispatch an already claimed operation.');
  entry.state = 'running';
  return entry;
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
  if (entry.state !== 'running' && !(entry.state === 'queued' && state === 'outcome-unknown'))
    throw error('MACHINE_ALREADY_SETTLED', 'A settled/unknown command cannot be replayed or rewritten.');
  if (state !== 'outcome-unknown' && !outputId)
    throw error('MACHINE_OUTPUT_REQUIRED', 'Settled commands require a durable output reference.');
  entry.outputId = outputId ? identifier(outputId, 'outputId') : null;
  entry.state = state;
  entry.preview = plain(preview, MAX_PREVIEW);
  entry.bytes = Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
  entry.exitCode = Number.isInteger(exitCode) ? exitCode : null;
  entry.finishedAt = String(finishedAt);
  return { entry, deduplicated: false };
}
function projection(entry) {
  if (!STATES.has(entry?.state)) throw error('MACHINE_BAD_STATE', 'Unexpected operation state.');
  const { intentDigest, ...publicEntry } = entry;
  return { ...publicEntry };
}
module.exports = { MAX_EVENTS, MAX_SUMMARY, MAX_PREVIEW, createLedger, recordRequest,
  markRunning, settle, projection, entryFor };
