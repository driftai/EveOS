'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const SCHEMA = 'eveos.tlo-conversation-store.v2';
const SCOPE = /^[a-z][a-z0-9_-]{0,63}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const REVISION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 32_000;
const MAX_TOTAL_CHARS = 192_000;
const MAX_RECORD_BYTES = 512 * 1024;
const HASH = /^[a-f0-9]{64}$/;

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function defaultDirectory() {
  return path.join(require('../runtime-config').dataDir(), 'tlo-conversations');
}
function validScope(value) {
  if (typeof value !== 'string' || !SCOPE.test(value)) fail('TLO_HISTORY_SCOPE_INVALID', 'Invalid TLO conversation scope.');
  return value;
}
function validGeneration(value) {
  if (!Number.isSafeInteger(value) || value <= 0) fail('TLO_HISTORY_GENERATION_INVALID', 'Invalid owner generation.');
  return value;
}
function validRequestId(value) {
  if (typeof value !== 'string' || !ID.test(value)) fail('TLO_HISTORY_REQUEST_INVALID', 'Invalid TLO request ID.');
  return value;
}
function cleanText(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_MESSAGE_CHARS) {
    fail('TLO_HISTORY_MESSAGE_INVALID', `${label} is invalid or exceeds the bounded message size.`);
  }
  return value.trim();
}
function cleanHistory(value) {
  if (!Array.isArray(value) || value.length > MAX_MESSAGES) fail('TLO_HISTORY_INVALID', 'Conversation history is not bounded.');
  let chars = 0;
  const result = value.map((entry, index) => {
    if (!entry || !['user', 'assistant'].includes(entry.role)) fail('TLO_HISTORY_INVALID', `Invalid history role at ${index}.`);
    const content = cleanText(entry.content, `history[${index}]`);
    chars += content.length;
    return { role: entry.role, content };
  });
  if (chars > MAX_TOTAL_CHARS) fail('TLO_HISTORY_INVALID', 'Conversation history exceeds the total bounded size.');
  return result;
}
function historyDigest({ scopeId, generation, history }) {
  const canonical = JSON.stringify({ scopeId: validScope(scopeId), generation: validGeneration(generation), history: cleanHistory(history) });
  return createHash('sha256').update(canonical).digest('hex');
}
function validateRecord(scopeId, value) {
  if (!value || value.schema !== SCHEMA || value.scopeId !== scopeId
      || !REVISION.test(String(value.revision || '')) || !Number.isSafeInteger(value.generation)
      || value.generation <= 0 || !Array.isArray(value.history)
      || !Object.hasOwn(value, 'pending')
      || Object.keys(value).sort().join('|') !== 'generation|history|pending|revision|schema|scopeId') {
    fail('TLO_HISTORY_CORRUPT', 'Unexpected durable conversation record format.');
  }
  const history = cleanHistory(value.history);
  let pending = null;
  if (value.pending !== null) {
    const item = value.pending;
    if (!item || !['prepared', 'dispatched', 'inferred', 'unknown'].includes(item.phase)
        || !Number.isFinite(item.at)) fail('TLO_HISTORY_CORRUPT', 'Invalid pending conversation turn.');
    pending = {
      requestId: validRequestId(item.requestId),
      roomId: validRequestId(item.roomId),
      sourceMessageId: validRequestId(item.sourceMessageId),
      dispatchId: validRequestId(item.dispatchId),
      message: cleanText(item.message, 'pending message'),
      phase: item.phase,
      at: item.at
    };
    if (item.phase === 'inferred') {
      pending.response = cleanText(item.response, 'pending response');
      pending.responseDigest = String(item.responseDigest || '');
      pending.inferredAt = Number(item.inferredAt);
      if (!HASH.test(pending.responseDigest) || !Number.isFinite(pending.inferredAt)) {
        fail('TLO_HISTORY_CORRUPT', 'Inferred response evidence is invalid.');
      }
    }
  }
  return { ...value, history, pending };
}
function atomicWrite(file, record, io) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = io.openSync(temp, 'wx', 0o600);
    io.writeFileSync(fd, JSON.stringify(record), 'utf8');
    io.fsyncSync(fd);
    io.closeSync(fd); fd = null;
    io.renameSync(temp, file);
  } finally {
    if (fd != null) io.closeSync(fd);
    try { io.rmSync(temp, { force: true }); } catch {}
  }
}

function createTloConversationStore({ dirPath = null, io = fs, uid = randomUUID, now = Date.now } = {}) {
  if (dirPath === null) dirPath = defaultDirectory();
  if (!path.isAbsolute(dirPath)) throw new TypeError('TLO conversation directory must be absolute.');
  const recordPath = (scopeId) => path.join(dirPath, `${validScope(scopeId)}.json`);
  const lockPath = (scopeId) => path.join(dirPath, `${validScope(scopeId)}.lock`);

  function read(scopeId = 'default') {
    const file = recordPath(scopeId);
    let stat;
    try { stat = io.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_RECORD_BYTES)
      fail('TLO_HISTORY_CORRUPT', 'Conversation record is not a bounded regular file.');
    let parsed;
    try { parsed = JSON.parse(io.readFileSync(file, 'utf8')); }
    catch { fail('TLO_HISTORY_CORRUPT', 'Conversation record cannot be decoded.'); }
    return structuredClone(validateRecord(scopeId, parsed));
  }

  function update(scopeId, transform) {
    validScope(scopeId);
    io.mkdirSync(dirPath, { recursive: true });
    const lock = lockPath(scopeId);
    try { io.mkdirSync(lock); }
    catch (error) {
      if (error.code === 'EEXIST') fail('TLO_HISTORY_LOCKED', 'Conversation journal is locked; do not retry automatically.');
      throw error;
    }
    try {
      const before = read(scopeId);
      const next = transform(before ? structuredClone(before) : null);
      const revision = uid();
      if (!REVISION.test(String(revision || '')) || revision === before?.revision)
        fail('TLO_HISTORY_REVISION_INVALID', 'Conversation revision generator failed.');
      const record = validateRecord(scopeId, { ...next, schema: SCHEMA, scopeId, revision });
      if (Buffer.byteLength(JSON.stringify(record), 'utf8') > MAX_RECORD_BYTES)
        fail('TLO_HISTORY_INVALID', 'Conversation record exceeds bounded storage.');
      atomicWrite(recordPath(scopeId), record, io);
      return structuredClone(record);
    } finally {
      io.rmdirSync(lock);
    }
  }

  function snapshot(scopeId = 'default') { return read(scopeId); }
  function proof(scopeId = 'default', generation) {
    try {
      io.lstatSync(lockPath(scopeId));
      fail('TLO_HISTORY_LOCKED', 'Conversation journal is locked; ownership proof is unavailable.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const record = read(scopeId);
    if (!record || record.generation !== generation || record.pending) return null;
    return { ready: true, durable: true, scopeId, ownerGeneration: generation,
      digest: historyDigest({ scopeId, generation, history: record.history }) };
  }

  function initialize({ scopeId = 'default', generation, history = [], expectedDigest } = {}) {
    const clean = cleanHistory(history);
    const digest = historyDigest({ scopeId, generation, history: clean });
    if (digest !== expectedDigest) fail('TLO_HISTORY_DIGEST_MISMATCH', 'Conversation handoff digest does not match.');
    return update(scopeId, (before) => {
      if (before) fail('TLO_HISTORY_ALREADY_INITIALIZED', 'Conversation history may be initialized only once.');
      return { generation: validGeneration(generation), history: clean, pending: null };
    });
  }

  function advanceGeneration({ scopeId = 'default', handoffProof } = {}) {
    return update(scopeId, (record) => {
      const fromGeneration = handoffProof?.from?.generation;
      const toGeneration = handoffProof?.toGeneration;
      if (!record || record.generation !== validGeneration(fromGeneration)
          || toGeneration !== fromGeneration + 1) fail('TLO_HISTORY_GENERATION_STALE', 'Conversation owner generation is stale.');
      if (record.pending) fail('TLO_HISTORY_BUSY', 'Cannot hand off conversation history with unresolved work.');
      const digest = historyDigest({ scopeId, generation: fromGeneration, history: record.history });
      if (!handoffProof || handoffProof.status !== 'acknowledged'
          || handoffProof.sourceWorkspaceId !== handoffProof.from?.id
          || handoffProof.conversationDigest !== digest
          || handoffProof.acknowledgedBy?.kind !== handoffProof.to?.kind
          || handoffProof.acknowledgedBy?.id !== handoffProof.to?.id) {
        fail('TLO_HISTORY_HANDOFF_UNPROVEN', 'Authenticated generation-bound conversation handoff proof is required.');
      }
      record.generation = validGeneration(toGeneration);
      return record;
    });
  }

  function beginTurn({ scopeId = 'default', generation, requestId, roomId,
    sourceMessageId, dispatchId, message } = {}) {
    const record = update(scopeId, (current) => {
      if (!current || current.generation !== validGeneration(generation))
        fail('TLO_HISTORY_GENERATION_STALE', 'Conversation owner generation is stale.');
      if (current.pending) fail('TLO_HISTORY_BUSY', 'Conversation already has unresolved work.');
      current.pending = {
        requestId: validRequestId(requestId),
        roomId: validRequestId(roomId),
        sourceMessageId: validRequestId(sourceMessageId),
        dispatchId: validRequestId(dispatchId),
        message: cleanText(message, 'message'),
        phase: 'prepared',
        at: now()
      };
      return current;
    });
    return { history: structuredClone(record.history), pending: structuredClone(record.pending) };
  }

  function markDispatched({ scopeId = 'default', generation, requestId } = {}) {
    return update(scopeId, (record) => {
      if (!record || record.generation !== validGeneration(generation)) fail('TLO_HISTORY_GENERATION_STALE', 'Conversation owner generation is stale.');
      if (record.pending?.requestId !== validRequestId(requestId) || record.pending.phase !== 'prepared')
        fail('TLO_HISTORY_TURN_STALE', 'Prepared conversation turn is missing or stale.');
      record.pending.phase = 'dispatched';
      return record;
    });
  }

  function markUnknown({ scopeId = 'default', generation, requestId } = {}) {
    return update(scopeId, (record) => {
      if (!record || record.generation !== validGeneration(generation)) fail('TLO_HISTORY_GENERATION_STALE', 'Conversation owner generation is stale.');
      if (record.pending?.requestId !== validRequestId(requestId)
          || !['prepared', 'dispatched'].includes(record.pending.phase))
        fail('TLO_HISTORY_TURN_STALE', 'Unresolved conversation turn is missing or stale.');
      record.pending.phase = 'unknown';
      return record;
    });
  }

  function markInferred({ scopeId = 'default', generation, requestId, response } = {}) {
    return update(scopeId, (record) => {
      if (!record || record.generation !== validGeneration(generation)) fail('TLO_HISTORY_GENERATION_STALE', 'Conversation owner generation is stale.');
      if (record.pending?.requestId !== validRequestId(requestId) || record.pending.phase !== 'dispatched')
        fail('TLO_HISTORY_TURN_STALE', 'Dispatched conversation turn is missing or uncertain.');
      const text = cleanText(response, 'response');
      record.pending.phase = 'inferred';
      record.pending.response = text;
      record.pending.responseDigest = createHash('sha256').update(text).digest('hex');
      record.pending.inferredAt = now();
      return record;
    });
  }

  function settleDelivered({ scopeId = 'default', generation, requestId,
    roomId, sourceMessageId, dispatchId, responseDigest, deliveryReceipt } = {}) {
    return update(scopeId, (record) => {
      if (!record || record.generation !== validGeneration(generation)) fail('TLO_HISTORY_GENERATION_STALE', 'Conversation owner generation is stale.');
      const pending = record.pending;
      if (!pending || pending.requestId !== validRequestId(requestId) || pending.phase !== 'inferred'
          || pending.roomId !== validRequestId(roomId)
          || pending.sourceMessageId !== validRequestId(sourceMessageId)
          || pending.dispatchId !== validRequestId(dispatchId)
          || pending.responseDigest !== String(responseDigest || '')) {
        fail('TLO_HISTORY_TURN_STALE', 'Inferred conversation turn does not match delivery evidence.');
      }
      if (deliveryReceipt?.source !== 'dex-durable-ledger'
          || deliveryReceipt.confirmed !== true
          || deliveryReceipt.requestId !== pending.requestId
          || deliveryReceipt.roomId !== pending.roomId
          || deliveryReceipt.sourceMessageId !== pending.sourceMessageId) {
        fail('TLO_HISTORY_RECEIPT_REQUIRED', 'Source-correlated Dex delivery receipt is required.');
      }
      record.history = cleanHistory([...record.history,
        { role: 'user', content: pending.message },
        { role: 'assistant', content: pending.response }].slice(-MAX_MESSAGES));
      record.pending = null;
      return record;
    });
  }

  function fenceRestart(scopeId = 'default') {
    const record = read(scopeId);
    if (!record?.pending || ['unknown', 'inferred'].includes(record.pending.phase)) return record;
    return update(scopeId, (current) => {
      if (!current?.pending || current.pending.requestId !== record.pending.requestId)
        fail('TLO_HISTORY_TURN_STALE', 'Conversation changed while fencing restart.');
      current.pending.phase = 'unknown';
      return current;
    });
  }

  return Object.freeze({ snapshot, proof, initialize, advanceGeneration, beginTurn,
    markDispatched, markUnknown, markInferred, settleDelivered, fenceRestart });
}

module.exports = { SCHEMA, MAX_MESSAGES, historyDigest, createTloConversationStore };
