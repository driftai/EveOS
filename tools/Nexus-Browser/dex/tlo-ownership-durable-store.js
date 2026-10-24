'use strict';
// Phase 3D-B1: server-only, source-inert durable CAS adapter for tlo-ownership-fence.
// This file is NOT a dispatch hook, websocket route, inference host or chat store.
// The caller must authenticate ownership and hold the existing Dex dispatch boundary.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { SCHEMA: FENCE_SCHEMA } = require('./tlo-ownership-fence');

const STORE_SCHEMA = 'eveos.tlo-ownership-durable-cas.v1';
const SCOPE = /^[a-z][a-z0-9_-]{0,63}$/;
const REVISION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 16 * 1024;
// Resolve EveOS's existing runtime path only when a real store is constructed.
function defaultDirectory() {
  return path.join(require('../runtime-config').dataDir(), 'tlo-ownership');
}
function atomicWriteRecord(file, record, io = fs) {
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


function failure(code, message) {
  return Object.assign(new Error(message), { code });
}
function validatedScope(scopeId) {
  if (typeof scopeId !== 'string' || !SCOPE.test(scopeId))
    throw failure('TLO_OWNER_STORE_SCOPE_INVALID', 'Scope ID is invalid.');
  return scopeId;
}
function validatedState(scopeId, state) {
  // The fence performs the full state-transition contract; this disk boundary
  // rejects malformed envelopes, scope changes, and accidental direct writes.
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
      state.schema !== FENCE_SCHEMA || state.scopeId !== scopeId ||
      !Number.isSafeInteger(state.generation) || state.generation < 0 ||
      !Object.hasOwn(state, 'owner') || !Object.hasOwn(state, 'handoff') ||
      !Object.hasOwn(state, 'turn')) {
    throw failure('TLO_OWNER_STORE_STATE_INVALID', 'Invalid ownership-fence state.');
  }
  return state;
}
function createDurableTloOwnershipStore({ dirPath = null, io = fs, uid = randomUUID } = {}) {
  if (dirPath === null) dirPath = defaultDirectory();
  if (!path.isAbsolute(dirPath)) throw new TypeError('TLO durable ownership directory must be absolute.');
  if (typeof uid !== 'function') throw new TypeError('TLO store requires a revision generator.');
  const recordPath = scopeId => path.join(dirPath, validatedScope(scopeId) + '.json');
  const lockPath = scopeId => path.join(dirPath, validatedScope(scopeId) + '.lock');

  function read(scopeId = 'default') {
    const file = recordPath(scopeId);
    let st;
    try { st = io.lstatSync(file); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (!st.isFile() || st.isSymbolicLink() || st.size <= 0 || st.size > MAX_BYTES)
      throw failure('TLO_OWNER_STORE_CORRUPT', 'Ownership record is not a bounded regular file.');
    let payload;
    try { payload = JSON.parse(io.readFileSync(file, 'utf8')); }
    catch { throw failure('TLO_OWNER_STORE_CORRUPT', 'Ownership record cannot be decoded.'); }
    if (!payload || payload.schema !== STORE_SCHEMA ||
        typeof payload.revision !== 'string' || !REVISION.test(payload.revision) ||
        Object.keys(payload).sort().join('|') !== 'revision|schema|state')
      throw failure('TLO_OWNER_STORE_CORRUPT', 'Unexpected durable ownership record format.');
    try { validatedState(scopeId, payload.state); }
    catch { throw failure('TLO_OWNER_STORE_CORRUPT', 'Ownership state failed boundary validation.'); }
    // The returned copy is never a reference to shared in-memory state.
    return { revision: payload.revision, state: structuredClone(payload.state) };
  }

  function compareAndSwap(scopeId, expectedRevision, nextState) {
    validatedScope(scopeId);
    if (expectedRevision !== null &&
        (typeof expectedRevision !== 'string' || !REVISION.test(expectedRevision)))
      throw failure('TLO_OWNER_STORE_REVISION_INVALID', 'Missing or invalid expected revision.');
    validatedState(scopeId, nextState);
    const serializedState = JSON.stringify(nextState);
    if (Buffer.byteLength(serializedState, 'utf8') > MAX_BYTES - 200)
      throw failure('TLO_OWNER_STORE_SIZE_INVALID', 'Ownership record exceeds bounded storage.');

    // Exclusive filesystem lock is the cross-process CAS serialization point.
    // A stale lock from a crash intentionally blocks writes until owner review;
    // never break or retry it automatically.
    io.mkdirSync(dirPath, { recursive: true });
    const lock = lockPath(scopeId);
    try { io.mkdirSync(lock); }
    catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    }
    try {
      const before = read(scopeId);
      if ((before?.revision ?? null) !== expectedRevision) return false;
      const revision = uid();
      if (typeof revision !== 'string' || !REVISION.test(revision) ||
          revision === expectedRevision)
        throw failure('TLO_OWNER_STORE_REVISION_INVALID', 'Revision generator failed.');
      // Use the same fsync/temp/rename pattern as EveOS's local journals.
      // This record holds only owner/turn metadata, never prompt or response text.
      atomicWriteRecord(recordPath(scopeId), {
        schema: STORE_SCHEMA,
        revision,
        state: structuredClone(nextState)
      }, io);
      return true;
    } finally {
      // Only this invocation acquired this mkdir lock. Never clean a stale
      // pre-existing lock, since it may indicate a crashed writer.
      io.rmdirSync(lock);
    }
  }
  return Object.freeze({ read, compareAndSwap });
}
module.exports = { STORE_SCHEMA, MAX_BYTES, createDurableTloOwnershipStore };
