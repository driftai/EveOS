'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { dataDir } = require('../runtime-config');

const DEFAULT_FILE = path.join(dataDir(), 'app-origin-passive-turns.jsonl');
const HEX64 = /^[a-f0-9]{64}$/i;

function loadLedger(filePath) {
  const latest = new Map(), cursors = new Map();
  let reliable = true;
  try {
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event?.type === 'cursor' && HEX64.test(String(event.scope || ''))
            && HEX64.test(String(event.nativeFingerprint || ''))) {
          cursors.set(event.scope, event);
        } else if (event?.fingerprint && event?.state) {
          latest.set(event.fingerprint, event);
        }
      } catch { reliable = false; }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') reliable = false;
  }
  return { latest, cursors, reliable };
}

function createPassiveTurnLedger({ filePath = DEFAULT_FILE, maxBytes = 1024 * 1024 } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const loaded = loadLedger(filePath);
  const latest = loaded.latest, cursors = loaded.cursors;
  let reliable = loaded.reliable, writes = 0, chain = Promise.resolve();

  function entry(fingerprint) {
    const value = latest.get(String(fingerprint || ''));
    return value ? { ...value } : null;
  }
  function cursor(scope) {
    const value = cursors.get(String(scope || ''));
    return value ? { ...value } : null;
  }
  async function compactIfNeeded() {
    if (writes % 64 !== 0) return;
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat || stat.size <= maxBytes) return;
    const values = [...latest.values()].slice(-512).concat([...cursors.values()].slice(-64));
    const body = values.map((value) => JSON.stringify(value)).join('\n');
    const temp = `${filePath}.${process.pid}.compact`;
    await fs.promises.writeFile(temp, body ? `${body}\n` : '', 'utf8');
    await fs.promises.rename(temp, filePath);
  }
  function append(event) {
    chain = chain.catch(() => {}).then(async () => {
      await fs.promises.appendFile(filePath, `${JSON.stringify(event)}\n`, 'utf8');
      writes += 1;
      await compactIfNeeded();
      return { ...event };
    }).catch((error) => {
      reliable = false;
      throw error;
    });
    return chain;
  }
  function record(fingerprint, state, meta = {}) {
    const id = String(fingerprint || '').toLowerCase();
    if (!HEX64.test(id) || !['pending', 'delivered'].includes(state)) return Promise.resolve(null);
    const current = latest.get(id);
    if (current?.state === 'delivered' || current?.state === state) return Promise.resolve(current ? { ...current } : null);
    const event = {
      ...(current || {}),
      fingerprint: id,
      state,
      at: new Date().toISOString(),
      ...(meta.targetId ? { targetId: String(meta.targetId) } : {}),
      ...(meta.providerId ? { providerId: String(meta.providerId) } : {}),
      ...(meta.source ? { source: String(meta.source) } : {}),
      ...(HEX64.test(String(meta.scope || '')) ? { scope: String(meta.scope).toLowerCase() } : {}),
      ...(HEX64.test(String(meta.nativeFingerprint || ''))
        ? { nativeFingerprint: String(meta.nativeFingerprint).toLowerCase() } : {})
    };
    latest.set(id, event);
    return append(event);
  }
  function setCursor(scope, nativeFingerprint, meta = {}) {
    const scopeId = String(scope || '').toLowerCase();
    const nativeId = String(nativeFingerprint || '').toLowerCase();
    if (!HEX64.test(scopeId) || !HEX64.test(nativeId)) return Promise.resolve(null);
    const current = cursors.get(scopeId);
    if (current?.nativeFingerprint === nativeId) return Promise.resolve({ ...current });
    const event = {
      type: 'cursor',
      scope: scopeId,
      nativeFingerprint: nativeId,
      at: new Date().toISOString(),
      ...(meta.targetId ? { targetId: String(meta.targetId) } : {}),
      ...(meta.providerId ? { providerId: String(meta.providerId) } : {}),
      ...(meta.source ? { source: String(meta.source) } : {})
    };
    cursors.set(scopeId, event);
    return append(event);
  }
  function discover(fingerprint, meta = {}) { return record(fingerprint, 'pending', meta); }
  function seed(fingerprint, meta = {}) { return record(fingerprint, 'delivered', meta); }
  function ack(fingerprint, meta = {}) {
    return record(fingerprint, 'delivered', { ...meta, source: meta.source || 'ack' });
  }
  function stats() {
    const values = [...latest.values()];
    return {
      reliable,
      entries: values.length,
      cursors: cursors.size,
      pending: values.filter((value) => value.state === 'pending').length,
      delivered: values.filter((value) => value.state === 'delivered').length,
      filePath
    };
  }

  return { filePath, entry, cursor, discover, seed, ack, setCursor, stats };
}

module.exports = { DEFAULT_FILE, loadLedger, createPassiveTurnLedger };
