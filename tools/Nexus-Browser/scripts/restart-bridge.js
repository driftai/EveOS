'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');
const { urls, servicePort } = require('../runtime-config');

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

async function diagnostics() {
  try {
    const response = await fetch(urls().diagnostics, { cache: 'no-store' });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
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
    'if($p){[pscustomobject]@{ProcessId=$p.ProcessId;ParentProcessId=$p.ParentProcessId;CommandLine=$p.CommandLine}|ConvertTo-Json -Compress}'
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

function ownsExpectedProcess(info, fragment) {
  if (!info?.CommandLine) return false;
  const command = normalized(info.CommandLine);
  return command.includes(normalized(ROOT)) && command.includes(normalized(fragment));
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

  const before = await diagnostics();
  if (!before?.serverSessionId) {
    throw Object.assign(new Error('Nexus Browser is not healthy; use START.bat instead of restart.'), {
      code: 'NEXUS_RESTART_NOT_RUNNING'
    });
  }

  const netstat = await execFileAsync('netstat.exe', ['-ano', '-p', 'tcp']);
  const serverPid = listenerPidFromNetstat(netstat.stdout);
  if (!serverPid) {
    throw Object.assign(new Error(`No listener PID was found for Nexus port ${PORT}.`), {
      code: 'NEXUS_RESTART_LISTENER_NOT_FOUND'
    });
  }

  const server = await processInfo(serverPid);
  const supervisor = server?.ParentProcessId ? await processInfo(server.ParentProcessId) : null;
  if (!ownsExpectedProcess(server, 'server.js')
      || !ownsExpectedProcess(supervisor, 'bridge-supervisor.js')) {
    throw Object.assign(new Error(
      'Refusing to restart: port owner is not the verified EveOS Nexus server under its supervisor.'
    ), {
      code: 'NEXUS_RESTART_OWNERSHIP_MISMATCH',
      detail: {
        serverPid,
        serverCommand: server?.CommandLine || null,
        supervisorPid: supervisor?.ProcessId || null,
        supervisorCommand: supervisor?.CommandLine || null
      }
    });
  }

  console.log(`[Nexus Restart] recycling server PID ${serverPid} under supervisor PID ${supervisor.ProcessId}...`);
  const killed = await execFileAsync('taskkill.exe', ['/F', '/T', '/PID', String(serverPid)]);
  if (!killed.ok) {
    throw Object.assign(new Error(killed.stderr.trim() || killed.stdout.trim() || 'taskkill failed'), {
      code: 'NEXUS_RESTART_KILL_FAILED'
    });
  }

  const replacement = await waitForReplacement(before.serverSessionId);
  if (!replacement.ok) {
    throw Object.assign(new Error('Supervisor did not produce a fresh healthy Nexus session in time.'), {
      code: 'NEXUS_RESTART_TIMEOUT'
    });
  }

  console.log(JSON.stringify({
    ok: true,
    previousSessionId: before.serverSessionId,
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
  listenerPidFromNetstat,
  ownsExpectedProcess,
  normalized,
  waitForReplacement
};
