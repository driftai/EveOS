const fs = require('node:fs');
const path = require('node:path');
const { repairSnapshot } = require('./state-repair');
const { dataDir } = require('../runtime-config');

const DEFAULT_FILE = path.join(dataDir(), 'dex-state.json');

function cleanSnapshot(value = {}) {
  const rooms = Array.isArray(value.rooms) ? value.rooms : [];
  const retiredProviderControlReceipts = Array.isArray(value.retiredProviderControlReceipts)
    ? value.retiredProviderControlReceipts.slice(-100) : [];
  const activeRoomId = typeof value.activeRoomId === 'string' ? value.activeRoomId : null;
  const savedAt = Number.isFinite(Date.parse(value.savedAt || '')) ? value.savedAt : new Date().toISOString();
  return { version: 1, rooms, activeRoomId, retiredProviderControlReceipts, savedAt };
}

function readJson(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return cleanSnapshot(parsed);
  } catch {
    return null;
  }
}

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), 'utf8');
  fs.renameSync(temp, filePath);
}

function createDexStateStore({ filePath = DEFAULT_FILE } = {}) {
  let lastRepairs = [];
  let lastIssues = [];
  let current = readJson(filePath);

  function normalize(snapshot, { restartRecovery = false } = {}) {
    if (!snapshot) return null;
    const repaired = repairSnapshot(cleanSnapshot(snapshot), { restartRecovery });
    lastRepairs = repaired.repairs;
    lastIssues = repaired.issues;
    return repaired.snapshot;
  }

  current = normalize(current, { restartRecovery: true });
  if (current && lastRepairs.length) atomicWrite(filePath, current);

  function load() {
    if (!current) current = normalize(readJson(filePath), { restartRecovery: true });
    return current ? JSON.parse(JSON.stringify(current)) : null;
  }

  function save(snapshot) {
    current = normalize(snapshot);
    atomicWrite(filePath, current);
    return load();
  }

  function clear() {
    current = null;
    try { fs.rmSync(filePath, { force: true }); } catch {}
  }

  function diagnostics() {
    return { repairs: [...lastRepairs], issues: [...lastIssues] };
  }

  return { filePath, load, save, clear, diagnostics };
}

module.exports = { DEFAULT_FILE, cleanSnapshot, readJson, atomicWrite, createDexStateStore };
