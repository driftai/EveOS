#!/usr/bin/env node
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createQualificationSupervisorControl } = require('./qualification-supervisor');
const { createRuntimeLog } = require('./runtime-log');
const { urls } = require('../runtime-config');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');
const HEALTH = process.env.NEXUS_BROWSER_HEALTH || process.env.BROWSER_AI_BRIDGE_HEALTH || urls().health;
const CHECK_MS = Number(process.env.NEXUS_BROWSER_SUPERVISOR_INTERVAL || process.env.BROWSER_AI_BRIDGE_SUPERVISOR_INTERVAL || 5000);
const FAIL_LIMIT = Number(process.env.NEXUS_BROWSER_SUPERVISOR_FAIL_LIMIT || process.env.BROWSER_AI_BRIDGE_SUPERVISOR_FAIL_LIMIT || 3);
const runtimeLog = createRuntimeLog();
runtimeLog.append(`\n--- supervisor session ${new Date().toISOString()} ---\n`);

let child = null;
let stopping = false;
let failures = 0;
let restartTimer = null;
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
  spawned.on('message', (message) => qualificationControl.handle(spawned, message));
  log(`server started (PID ${spawned.pid})`);
  spawned.once('exit', (code, signal) => {
    qualificationControl.clearChild(spawned);
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
  if (child) {
    try { child.kill(); } catch {}
  }
  setTimeout(() => process.exit(0), 150).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

(async () => {
  log('visible deterministic supervision active');
  if (!(await healthy())) {
    spawnServer();
    setInterval(check, CHECK_MS);
    return;
  }
  log('existing bridge server is already healthy; extra supervisor exiting');
  process.exit(0);
})();
