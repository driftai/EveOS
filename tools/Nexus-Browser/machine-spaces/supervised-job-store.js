'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { dataDir } = require('../runtime-config');

const DEFAULT_FILE = path.join(dataDir(), 'supervised-jobs.json');

function createSupervisedJobStore({ filePath = DEFAULT_FILE, fsImpl = fs } = {}) {
  function load() {
    try {
      const value = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
      return value && value.version === 1 ? value : null;
    } catch { return null; }
  }
  function save(value) {
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.${process.pid}.tmp`;
    fsImpl.writeFileSync(temp, JSON.stringify(value), 'utf8');
    fsImpl.renameSync(temp, filePath);
  }
  return { filePath, load, save };
}

module.exports = { DEFAULT_FILE, createSupervisedJobStore };
