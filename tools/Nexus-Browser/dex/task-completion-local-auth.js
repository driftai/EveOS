'use strict';
// One localhost-user capability for the detached qualification CLI.
// Browser tabs never receive this secret. A corrupt/missing existing credential
// fails closed: never rotate it while there may be outstanding task receipts.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { dataDir } = require('../runtime-config');
const AUTH_FILE = 'task-completions/local-api-credential.json';
function credentialFile(root = dataDir()) {
  return path.join(root, AUTH_FILE);
}
function decode(value) {
  if (value?.version !== 1 || !/^[0-9a-f]{64}$/i.test(String(value.secret || '')))
    throw Error('TASK_COMPLETION_LOCAL_AUTH_INVALID');
  return value.secret.toLowerCase();
}
function readLocalAuth(root = dataDir(), io = fs) {
  let data;
  try { data = JSON.parse(io.readFileSync(credentialFile(root), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw Error(
      'TASK_COMPLETION_LOCAL_AUTH_NOT_READY: install and qualify the updated supervised Nexus server first.');
    throw Error('TASK_COMPLETION_LOCAL_AUTH_INVALID');
  }
  return decode(data);
}
function loadOrCreateLocalAuth(root = dataDir(), io = fs) {
  const file = credentialFile(root);
  if (io.existsSync(file)) return readLocalAuth(root, io);
  io.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString('hex');
  let fd;
  try {
    fd = io.openSync(file, 'wx', 0o600);
    io.writeFileSync(fd, JSON.stringify({
      version: 1, secret, createdAt: new Date().toISOString()
    }), 'utf8');
    io.fsyncSync(fd);
  } catch (error) {
    if (error.code === 'EEXIST') return readLocalAuth(root, io);
    // Do not turn an interrupted first write into a different capability.
    throw error;
  } finally { if (fd != null) io.closeSync(fd); }
  try { io.chmodSync?.(file, 0o600); } catch {}
  return secret;
}
function localAuthMatches(provided, known) {
  if (!/^[0-9a-f]{64}$/i.test(String(provided || ''))
    || !/^[0-9a-f]{64}$/i.test(String(known || ''))) return false;
  return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(known, 'hex'));
}
module.exports = { AUTH_FILE, credentialFile, readLocalAuth,
  loadOrCreateLocalAuth, localAuthMatches };
