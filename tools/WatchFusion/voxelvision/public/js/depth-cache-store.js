/** Browser-local persistent depth cache backed by IndexedDB. */

import { dequantizeDepth16, quantizeDepth16 } from './depth-cache-codec.js';
import { canonicalMediaIdentity } from './youtube-source.js';

const DATABASE_NAME = 'voxelvision-depth-cache';
const DATABASE_VERSION = 2;
const SESSION_STORE = 'sessions';
const FRAME_STORE = 'frames';
const SOURCE_STORE = 'sources';

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted.'));
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
  });
}

export class DepthCacheStore {
  constructor({ onStatus = null } = {}) {
    this.onStatus = typeof onStatus === 'function' ? onStatus : () => {};
    this.dbPromise = null;
    this.available = typeof indexedDB !== 'undefined';
    this.persistent = false;
    this.quotaLimited = false;
  }

  async initialize() {
    if (!this.available) return this.snapshot();
    await this.#database();
    if (navigator.storage?.persist) {
      try { this.persistent = await navigator.storage.persist(); } catch {}
    }
    return this.snapshot();
  }

  async openVariant(cacheId, descriptor, details = {}, { knownIndices = null } = {}) {
    if (!this.available) return new Set();
    const db = await this.#database();
    const transaction = db.transaction([SESSION_STORE, FRAME_STORE], 'readwrite');
    const sessions = transaction.objectStore(SESSION_STORE);
    const current = await requestResult(sessions.get(cacheId));
    sessions.put({
      ...(current || {}),
      id: cacheId,
      descriptor,
      ...details,
      createdAt: current?.createdAt || Date.now(),
      lastAccess: Date.now()
    });
    const keys = knownIndices == null
      ? await requestResult(transaction.objectStore(FRAME_STORE).index('cacheId').getAllKeys(cacheId))
      : knownIndices;
    await transactionDone(transaction);
    return new Set(keys.map(key => Number(Array.isArray(key) ? key[1] : key)));
  }

  async getFrame(cacheId, index, { base = false } = {}) {
    if (!this.available) return null;
    const db = await this.#database();
    const transaction = db.transaction(FRAME_STORE, 'readonly');
    const record = await requestResult(transaction.objectStore(FRAME_STORE).get([cacheId, Number(index)]));
    await transactionDone(transaction);
    if (!record) return null;
    if (!base && record.calibratedData) {
      return {
        ...record,
        data: record.calibratedData,
        baseData: record.data,
        quality: record.calibratedQuality || record.quality || null
      };
    }
    return record;
  }

  async putFrame(cacheId, index, encoded, metadata = {}) {
    if (!this.available || this.quotaLimited) return false;
    try {
      const db = await this.#database();
      const transaction = db.transaction(FRAME_STORE, 'readwrite');
      const exactBuffer = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
      transaction.objectStore(FRAME_STORE).put({
        cacheId,
        index: Number(index),
        data: exactBuffer,
        sceneCut: Boolean(metadata.sceneCut),
        mediaTime: Number(metadata.mediaTime) || 0,
        guide: metadata.guide
          ? metadata.guide.buffer.slice(metadata.guide.byteOffset, metadata.guide.byteOffset + metadata.guide.byteLength)
          : null,
        quality: metadata.quality || null,
        createdAt: Date.now()
      });
      await transactionDone(transaction);
      return true;
    } catch (error) {
      if (error?.name === 'QuotaExceededError') {
        this.quotaLimited = true;
        this.onStatus({ phase: 'quota', message: 'Persistent depth storage is full; RAM lookahead remains active.' });
        return false;
      }
      throw error;
    }
  }

  async touchVariant(cacheId, details = {}) {
    if (!this.available) return;
    const db = await this.#database();
    const transaction = db.transaction(SESSION_STORE, 'readwrite');
    const store = transaction.objectStore(SESSION_STORE);
    const current = await requestResult(store.get(cacheId));
    if (current) store.put({ ...current, ...details, lastAccess: Date.now() });
    await transactionDone(transaction);
  }

  async listSessions() {
    if (!this.available) return [];
    const db = await this.#database();
    const transaction = db.transaction(SESSION_STORE, 'readonly');
    const sessions = await requestResult(transaction.objectStore(SESSION_STORE).getAll());
    await transactionDone(transaction);
    return sessions.sort((a, b) => Number(b.lastAccess || 0) - Number(a.lastAccess || 0));
  }

  async getSession(cacheId) {
    if (!this.available) return null;
    const db = await this.#database();
    const transaction = db.transaction(SESSION_STORE, 'readonly');
    const session = await requestResult(transaction.objectStore(SESSION_STORE).get(cacheId));
    await transactionDone(transaction);
    return session || null;
  }

  async frameIndices(cacheId) {
    if (!this.available) return [];
    const db = await this.#database();
    const transaction = db.transaction(FRAME_STORE, 'readonly');
    const keys = await requestResult(transaction.objectStore(FRAME_STORE).index('cacheId').getAllKeys(cacheId));
    await transactionDone(transaction);
    return keys.map(key => Number(Array.isArray(key) ? key[1] : key)).sort((a, b) => a - b);
  }

  decodeFrameRecord(record, { base = false } = {}) {
    const data = base ? (record?.baseData || record?.data) : record?.data;
    return data ? dequantizeDepth16(data) : null;
  }

  async putCalibration(cacheId, index, frame, metadata = {}) {
    if (!this.available || this.quotaLimited) return false;
    const db = await this.#database();
    const transaction = db.transaction(FRAME_STORE, 'readwrite');
    const store = transaction.objectStore(FRAME_STORE);
    const key = [cacheId, Number(index)];
    const record = await requestResult(store.get(key));
    if (!record) {
      await transactionDone(transaction);
      return false;
    }
    const encoded = quantizeDepth16(frame);
    record.calibratedData = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
    record.calibration = metadata.calibration || null;
    record.calibratedQuality = metadata.quality || null;
    record.calibratedAt = Date.now();
    store.put(record);
    await transactionDone(transaction);
    return true;
  }

  async saveSource(identity, details = {}) {
    if (!this.available || !identity || this.quotaLimited) return false;
    try {
      const db = await this.#database();
      const transaction = db.transaction(SOURCE_STORE, 'readwrite');
      const store = transaction.objectStore(SOURCE_STORE);
      const current = await requestResult(store.get(String(identity)));
      store.put({
        ...(current || {}),
        ...details,
        id: String(identity),
        createdAt: current?.createdAt || Date.now(),
        lastAccess: Date.now()
      });
      await transactionDone(transaction);
      return true;
    } catch (error) {
      if (error?.name === 'QuotaExceededError') {
        this.quotaLimited = true;
        this.onStatus({ phase: 'quota', message: 'Video source storage is full; existing depth maps remain usable.' });
        return false;
      }
      throw error;
    }
  }

  async getSource(identity) {
    if (!this.available || !identity) return null;
    const db = await this.#database();
    const transaction = db.transaction(SOURCE_STORE, 'readonly');
    const source = await requestResult(transaction.objectStore(SOURCE_STORE).get(String(identity)));
    await transactionDone(transaction);
    return source || null;
  }

  async deleteSourceCache(identity) {
    if (!this.available || !identity) return { sessions: 0, frames: 0 };
    const canonical = canonicalMediaIdentity(identity);
    const sessions = (await this.listSessions()).filter(session => (
      canonicalMediaIdentity(session.sourceIdentity || session.descriptor?.source) === canonical
    ));
    const sourceIds = new Set([String(identity), canonical]);
    for (const session of sessions) {
      if (session.sourceIdentity) sourceIds.add(String(session.sourceIdentity));
      if (session.descriptor?.source) sourceIds.add(String(session.descriptor.source));
    }
    return this.#deleteSessions(sessions.map(session => session.id), [...sourceIds]);
  }
  async deleteProfile(cacheId) {
    if (!this.available || !cacheId) return { sessions: 0, frames: 0 };
    const session = await this.getSession(cacheId);
    if (!session) return { sessions: 0, frames: 0 };
    const identity = canonicalMediaIdentity(session.sourceIdentity || session.descriptor?.source);
    // Keep the stored source: remaining profiles and future analysis reuse it.
    return this.#deleteSessions([cacheId], [], identity);
  }

  async clearAll() {
    if (!this.available) return { sessions: 0, frames: 0 };
    const db = await this.#database();
    const transaction = db.transaction([SESSION_STORE, FRAME_STORE, SOURCE_STORE], 'readwrite');
    const completion = transactionDone(transaction);
    const sessionCount = requestResult(transaction.objectStore(SESSION_STORE).count());
    const frameCount = requestResult(transaction.objectStore(FRAME_STORE).count());
    transaction.objectStore(SESSION_STORE).clear();
    transaction.objectStore(FRAME_STORE).clear();
    transaction.objectStore(SOURCE_STORE).clear();
    const [sessions, frames] = await Promise.all([sessionCount, frameCount]);
    await completion;
    this.quotaLimited = false;
    return { sessions, frames };
  }

  async estimate() {
    if (!navigator.storage?.estimate) return null;
    try { return await navigator.storage.estimate(); } catch { return null; }
  }

  snapshot() {
    return {
      available: this.available,
      persistent: this.persistent,
      quotaLimited: this.quotaLimited
    };
  }

  async #deleteSessions(cacheIds, sourceIds = [], invalidateIdentity = null) {
    if (!cacheIds.length && !sourceIds.length) return { sessions: 0, frames: 0 };
    const db = await this.#database();
    const transaction = db.transaction([SESSION_STORE, FRAME_STORE, SOURCE_STORE], 'readwrite');
    const completion = transactionDone(transaction);
    const sessionStore = transaction.objectStore(SESSION_STORE);
    const frameStore = transaction.objectStore(FRAME_STORE);
    const frameIndex = frameStore.index('cacheId');
    if (invalidateIdentity) {
      const cursorRequest = sessionStore.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const session = cursor.value;
        if (!cacheIds.includes(session.id)
          && canonicalMediaIdentity(session.sourceIdentity || session.descriptor?.source) === invalidateIdentity) {
          // These counters are derived from donor maps, not additional storage.
          // The next replay recomputes exact reuse from surviving frame indices.
          cursor.update({ ...session, reusableFrames: 0, donorProfiles: 0, sharedQualityAccumulator: null,
            analysisState: Number(session.frameCount) >= Number(session.totalFrames) ? 'complete' : 'paused' });
        }
        cursor.continue();
      };
    }
    let frames = 0;
    const frameDeletes = cacheIds.map(cacheId => new Promise((resolve, reject) => {
      const request = frameIndex.openCursor(IDBKeyRange.only(cacheId));
      request.onerror = () => reject(request.error || new Error('Could not delete cached depth frames.'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve();
        cursor.delete();
        frames += 1;
        cursor.continue();
      };
    }));
    for (const cacheId of cacheIds) sessionStore.delete(cacheId);
    for (const sourceId of sourceIds) transaction.objectStore(SOURCE_STORE).delete(sourceId);
    await Promise.all(frameDeletes);
    await completion;
    this.quotaLimited = false;
    return { sessions: cacheIds.length, frames };
  }

  async #database() {
    if (!this.available) throw new Error('IndexedDB is unavailable.');
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SESSION_STORE)) db.createObjectStore(SESSION_STORE, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(SOURCE_STORE)) db.createObjectStore(SOURCE_STORE, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(FRAME_STORE)) {
          const frames = db.createObjectStore(FRAME_STORE, { keyPath: ['cacheId', 'index'] });
          frames.createIndex('cacheId', 'cacheId', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open the depth cache.'));
      request.onblocked = () => this.onStatus({ phase: 'blocked', message: 'Close older VoxelVision tabs to upgrade the depth cache.' });
    });
    return this.dbPromise;
  }
}
