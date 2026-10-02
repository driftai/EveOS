'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { urls, servicePort, dataDir } = require('../runtime-config');

const ROOT = path.resolve(__dirname, '..');
const PORT = servicePort();

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: options.timeoutMs || 8000,
      maxBuffer: 1024 * 1024
    }, (error, stdout = '', stderr = '') => {
      resolve({ ok: !error, error, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function diagnostics(timeoutMs = 1500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(urls().diagnostics, {
      cache: 'no-store',
      signal: controller.signal
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function diagnosticsWithRetry(attempts = 3, delayMs = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const snapshot = await diagnostics();
    if (snapshot?.serverSessionId) return snapshot;
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

function listenerPidFromNetstat(text, port = PORT) {
  const marker = ':' + String(port);
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.includes(marker) || !/LISTENING/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    const pid = Number(parts.at(-1));
    if (Number.isInteger(pid) && pid > 1) return pid;
  }
  return null;
}

async function processInfo(pid) {
  const command = [
    `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}' -ErrorAction SilentlyContinue;`,
    'if($p){[pscustomobject]@{ProcessId=$p.ProcessId;ParentProcessId=$p.ParentProcessId;ExecutablePath=$p.ExecutablePath;CommandLine=$p.CommandLine}|ConvertTo-Json -Compress}'
  ].join('');
  const result = await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', command
  ]);
  if (!result.ok || !result.stdout.trim()) return null;
  try { return JSON.parse(result.stdout.trim()); } catch { return null; }
}

function normalized(value) {
  return String(value || '').replace(/\//g, '\\').toLowerCase();
}

function commandHas(info, fragment) {
  return normalized(info?.CommandLine).includes(normalized(fragment));
}

function readSupervisorPidFile() {
  try {
    const pid = Number(fs.readFileSync(path.join(dataDir(), 'supervisor.pid'), 'utf8').trim());
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

function writeSupervisorPidFile(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 1) return false;
  try {
    const file = path.join(dataDir(), 'supervisor.pid');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(Number(pid)), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function nodeProcess(info = {}) {
  const executable = normalized(info?.ExecutablePath || '');
  const command = normalized(info?.CommandLine || '');
  return executable.endsWith('\\node.exe') || /(^|[\\\s"])node(?:\.exe)?([\s"]|$)/i.test(command);
}

function verifiedSupervisorParent(server, parent) {
  if (!server || !parent) return false;
  return Number(server.ParentProcessId || 0) === Number(parent.ProcessId || 0)
    && nodeProcess(parent)
    && commandHas(parent, 'bridge-supervisor.js');
}

function chooseSupervisor({
  server,
  parent = null,
  reported = null,
  pidFile = null
} = {}) {
  if (verifiedSupervisorParent(server, parent)) {
    return { supervisor: parent, source: 'parent', stalePidFile: !!pidFile && Number(pidFile) !== Number(parent.ProcessId) };
  }
  for (const [source, candidate] of [['reported', reported], ['pid-file', pidFile]]) {
    if (!candidate?.ProcessId || !nodeProcess(candidate) || !commandHas(candidate, 'bridge-supervisor.js')) continue;
    if (Number(server?.ParentProcessId || 0) !== Number(candidate.ProcessId)) continue;
    return { supervisor: candidate, source, stalePidFile: false };
  }
  return { supervisor: null, source: null, stalePidFile: false };
}

function ownsExpectedProcess(info, fragment) {
  if (!info?.CommandLine) return false;
  const command = normalized(info.CommandLine);
  return command.includes(normalized(ROOT)) && command.includes(normalized(fragment));
}

function restartOwnershipVerified({ before = null, server = null, supervisor = null } = {}) {
  return (!before || !!before.supervised)
    && ownsExpectedProcess(server, 'server.js')
    && !!supervisor;
}

async function waitForReplacement(previousSessionId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let sawOffline = false;
  while (Date.now() < deadline) {
    const snapshot = await diagnostics();
    if (!snapshot) sawOffline = true;
    if (snapshot?.serverSessionId && snapshot.serverSessionId !== previousSessionId) {
      return { ok: true, sawOffline, sessionId: snapshot.serverSessionId };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { ok: false, sawOffline, sessionId: null };
}

async function main() {
  if (process.platform !== 'win32') {
    throw Object.assign(new Error('npm run restart currently supports the Windows Nexus supervisor.'), {
      code: 'NEXUS_RESTART_WINDOWS_ONLY'
    });
  }

  const before = await diagnosticsWithRetry();

  let serverPid = Number(before?.serverPid || 0) || null;
  if (!serverPid) {
    const netstat = await execFileAsync('netstat.exe', ['-ano', '-p', 'tcp']);
    serverPid = listenerPidFromNetstat(netstat.stdout);
  }
  if (!serverPid) {
    throw Object.assign(new Error(
      before
        ? `No listener PID was found for Nexus port ${PORT}.`
        : 'Nexus Browser is not running under the visible supervisor; use START.bat instead of restart.'
    ), {
      code: before ? 'NEXUS_RESTART_LISTENER_NOT_FOUND' : 'NEXUS_RESTART_NOT_RUNNING'
    });
  }

  const server = await processInfo(serverPid);
  const parentPid = Number(server?.ParentProcessId || 0) || null;
  const reportedSupervisorPid = Number(before?.supervisorPid || 0) || null;
  const pidFileSupervisor = readSupervisorPidFile();
  const [parent, reported, pidFileProcess] = await Promise.all([
    parentPid ? processInfo(parentPid) : null,
    reportedSupervisorPid && reportedSupervisorPid !== parentPid ? processInfo(reportedSupervisorPid) : null,
    pidFileSupervisor && pidFileSupervisor !== parentPid && pidFileSupervisor !== reportedSupervisorPid
      ? processInfo(pidFileSupervisor) : null
  ]);
  const selected = chooseSupervisor({
    server,
    parent,
    reported: reportedSupervisorPid === parentPid ? parent : reported,
    pidFile: pidFileSupervisor === parentPid ? parent
      : pidFileSupervisor === reportedSupervisorPid ? reported : pidFileProcess
  });
  const supervisor = selected.supervisor;
  if (!restartOwnershipVerified({ before, server, supervisor })) {
    throw Object.assign(new Error(
      'Refusing to restart: port owner is not the verified EveOS Nexus server under its supervisor.'
    ), {
      code: 'NEXUS_RESTART_OWNERSHIP_MISMATCH',
      detail: {
        diagnosticsAvailable: !!before,
        supervised: before ? !!before.supervised : null,
        serverPid,
        serverCommand: server?.CommandLine || null,
        parentPid,
        parentCommand: parent?.CommandLine || null,
        reportedSupervisorPid,
        pidFileSupervisor,
        supervisorPid: supervisor?.ProcessId || null,
        supervisorCommand: supervisor?.CommandLine || null
      }
    });
  }

  if (selected.stalePidFile) {
    writeSupervisorPidFile(Number(supervisor.ProcessId));
    console.log(`[Nexus Restart] repaired stale supervisor.pid (${pidFileSupervisor || 'missing'} -> ${supervisor.ProcessId}).`);
  }
  console.log(`[Nexus Restart] recycling server PID ${serverPid} under supervisor PID ${supervisor.ProcessId}...`);
  const killed = await execFileAsync('taskkill.exe', ['/F', '/T', '/PID', String(serverPid)]);
  if (!killed.ok) {
    throw Object.assign(new Error(killed.stderr.trim() || killed.stdout.trim() || 'taskkill failed'), {
      code: 'NEXUS_RESTART_KILL_FAILED'
    });
  }

  const replacement = await waitForReplacement(before?.serverSessionId || null);
  if (!replacement.ok) {
    throw Object.assign(new Error('Supervisor did not produce a fresh healthy Nexus session in time.'), {
      code: 'NEXUS_RESTART_TIMEOUT'
    });
  }

  console.log(JSON.stringify({
    ok: true,
    previousSessionId: before?.serverSessionId || null,
    serverSessionId: replacement.sessionId,
    supervisorPid: supervisor.ProcessId,
    message: 'Nexus Browser restarted under the existing visible supervisor.'
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      code: error.code || 'NEXUS_RESTART_FAILED',
      message: error.message,
      detail: error.detail || null
    }, null, 2));
    process.exitCode = 1;
  });
}

module.exports = {
  diagnostics,
  diagnosticsWithRetry,
  listenerPidFromNetstat,
  commandHas,
  readSupervisorPidFile,
  writeSupervisorPidFile,
  nodeProcess,
  verifiedSupervisorParent,
  chooseSupervisor,
  ownsExpectedProcess,
  restartOwnershipVerified,
  normalized,
  waitForReplacement
};
