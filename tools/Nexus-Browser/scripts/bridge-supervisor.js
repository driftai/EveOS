#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createQualificationSupervisorControl } = require('./qualification-supervisor');
const { createRuntimeLog } = require('./runtime-log');
const { createChildHealthProbe } = require('./supervisor-child-health');
const { urls, dataDir } = require('../runtime-config');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');
const HEALTH = process.env.NEXUS_BROWSER_HEALTH || process.env.BROWSER_AI_BRIDGE_HEALTH || urls().health;
const CHECK_MS = Number(process.env.NEXUS_BROWSER_SUPERVISOR_INTERVAL || process.env.BROWSER_AI_BRIDGE_SUPERVISOR_INTERVAL || 5000);
const FAIL_LIMIT = Number(process.env.NEXUS_BROWSER_SUPERVISOR_FAIL_LIMIT || process.env.BROWSER_AI_BRIDGE_SUPERVISOR_FAIL_LIMIT || 3);
const runtimeLog = createRuntimeLog();
const PID_FILE = path.join(dataDir(), 'supervisor.pid');
runtimeLog.append(`\n--- supervisor session ${new Date().toISOString()} ---\n`);

let child = null;
let stopping = false;
let failures = 0;
let restartTimer = null;
const childHealth = createChildHealthProbe();
let lastIpcPreserveLogAt = 0;
const qualificationControl = createQualificationSupervisorControl({ isCurrent: (candidate) => candidate === child, kill: (candidate) => { try { candidate.kill(); } catch {} } });

function log(message) {
  const line = `[Bridge Supervisor] ${message}`;
  console.log(line);
  runtimeLog.append(`${line}\n`);
}

function mirror(stream, chunk) {
  try { stream.write(chunk); } catch {}
  runtimeLog.append(chunk);
}

function readSupervisorPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    return Number.isInteger(pid) && pid > 1 ? pid : 0;
  } catch { return 0; }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function claimSupervisor() {
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(PID_FILE, 'wx');
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = readSupervisorPid();
      if (existing === process.pid) return true;
      if (pidAlive(existing)) return false;
      try { fs.unlinkSync(PID_FILE); } catch {}
    }
  }
  return false;
}

function releaseSupervisor() {
  if (readSupervisorPid() !== process.pid) return;
  try { fs.unlinkSync(PID_FILE); } catch {}
}

function spawnServer() {
  if (stopping || child) return;
  const spawned = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: { ...process.env, NEXUS_BROWSER_SUPERVISED: '1', BROWSER_AI_BRIDGE_SUPERVISED: '1' },
    stdio: ['inherit', 'pipe', 'pipe', 'ipc']
  });
  child = spawned;
  spawned.stdout?.on('data', (chunk) => mirror(process.stdout, chunk));
  spawned.stderr?.on('data', (chunk) => mirror(process.stderr, chunk));
  spawned.on('message', (message) => {
    if (childHealth.handle(spawned, message)) return;
    qualificationControl.handle(spawned, message);
  });
  log(`server started (PID ${spawned.pid})`);
  spawned.once('exit', (code, signal) => {
    qualificationControl.clearChild(spawned);
    childHealth.clearChild(spawned);
    if (child === spawned) child = null;
    if (stopping) return;
    log(`server PID ${spawned.pid} exited (${signal || code}); restarting...`);
    scheduleRestart();
  });
}

function scheduleRestart(delay = 1000) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(spawnServer, delay);
}

async function healthy() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(HEALTH, { cache: 'no-store', signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function check() {
  if (stopping) return;
  if (await healthy()) {
    if (failures) log('health recovered');
    failures = 0;
    if (!child) log('bridge is healthy under another visible server process; supervisor will not duplicate it');
    return;
  }
  if (child) {
    const ipc = await childHealth.probe(child);
    if (ipc.ok && ipc.listening) {
      const current = Date.now();
      if (current - lastIpcPreserveLogAt >= 30000) {
        log('HTTP health missed; server PID ' + child.pid
          + ' confirmed listening over IPC'
          + (ipc.sessionId ? ' session=' + ipc.sessionId : '')
          + '; preserving in-flight work');
        lastIpcPreserveLogAt = current;
      }
      failures = 0;
      return;
    }
  }
  failures += 1;
  if (!child) {
    log('bridge is offline; starting server');
    spawnServer();
    return;
  }
  if (failures >= FAIL_LIMIT) {
    log(`health failed ${failures} consecutive checks; restarting server PID ${child.pid}`);
    const doomed = child;
    child = null;
    try { doomed.kill(); } catch {}
    failures = 0;
    scheduleRestart();
  }
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  clearTimeout(restartTimer);
  log(`stopping on ${signal}`);
  releaseSupervisor();
  if (child) {
    try { child.kill(); } catch {}
  }
  setTimeout(() => process.exit(0), 150).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('exit', releaseSupervisor);

(async () => {
  log('visible deterministic supervision active');
  if (await healthy()) {
    log('existing bridge server is already healthy; extra supervisor exiting');
    process.exit(0);
  }
  if (!claimSupervisor()) {
    log(`another Nexus supervisor PID ${readSupervisorPid()} already owns startup; extra supervisor exiting`);
    process.exit(0);
  }
  spawnServer();
  setInterval(check, CHECK_MS);
})();
