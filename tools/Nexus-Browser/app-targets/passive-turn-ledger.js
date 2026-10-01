'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { dataDir } = require('../runtime-config');

const DEFAULT_FILE = path.join(dataDir(), 'app-origin-passive-turns.jsonl');

function loadLedger(filePath) {
  const latest = new Map();
  let reliable = true;
  try {
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event?.fingerprint && event?.state) latest.set(event.fingerprint, event);
      } catch { reliable = false; }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') reliable = false;
  }
  return { latest, reliable };
}

function createPassiveTurnLedger({ filePath = DEFAULT_FILE, maxBytes = 1024 * 1024 } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const loaded = loadLedger(filePath);
  const latest = loaded.latest;
  let reliable = loaded.reliable, writes = 0, chain = Promise.resolve();

  function entry(fingerprint) {
    const value = latest.get(String(fingerprint || ''));
    return value ? { ...value } : null;
  }

  async function compactIfNeeded() {
    if (writes % 64 !== 0) return;
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat || stat.size <= maxBytes) return;
    const body = [...latest.values()].slice(-512).map((value) => JSON.stringify(value)).join('\n');
    const temp = `${filePath}.${process.pid}.compact`;
    await fs.promises.writeFile(temp, body ? `${body}\n` : '', 'utf8');
    await fs.promises.rename(temp, filePath);
  }

  function record(fingerprint, state, meta = {}) {
    const id = String(fingerprint || '');
    if (!/^[a-f0-9]{64}$/i.test(id) || !['pending', 'delivered'].includes(state)) return Promise.resolve(null);
    const current = latest.get(id);
    if (current?.state === 'delivered' || current?.state === state) return Promise.resolve(current ? { ...current } : null);
    const event = {
      ...(current || {}),
      fingerprint: id.toLowerCase(),
      state,
      at: new Date().toISOString(),
      ...(meta.targetId ? { targetId: String(meta.targetId) } : {}),
      ...(meta.providerId ? { providerId: String(meta.providerId) } : {}),
      ...(meta.source ? { source: String(meta.source) } : {})
    };
    latest.set(event.fingerprint, event);
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
      pending: values.filter((value) => value.state === 'pending').length,
      delivered: values.filter((value) => value.state === 'delivered').length,
      filePath
    };
  }

  return { filePath, entry, discover, seed, ack, stats };
}

module.exports = { DEFAULT_FILE, loadLedger, createPassiveTurnLedger };
