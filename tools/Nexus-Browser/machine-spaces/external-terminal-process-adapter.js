'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

function fail(code, message) { return Object.assign(new Error(message), { code }); }
function intPid(value) {
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0) throw fail('MACHINE_EXTERNAL_PROCESS_PID_INVALID', 'Choose a positive external terminal process ID.');
  return pid;
}
function text(value, max = 512) { return String(value ?? '').trim().slice(0, max); }
function externalTargetId(pid) { return `external-pid-${intPid(pid)}`; }
function pidFromTargetId(targetId) {
  const match = /^external-pid-(\d+)$/.exec(text(targetId, 80));
  if (!match) throw fail('MACHINE_EXTERNAL_PROCESS_TARGET_INVALID', 'External terminal target identity is invalid.');
  return intPid(match[1]);
}
function epochFor(pid, startedAt) {
  const stamp = text(startedAt, 160);
  if (!stamp) throw fail('MACHINE_EXTERNAL_PROCESS_EPOCH_UNAVAILABLE', 'External terminal process start identity is unavailable.');
  return `external-process:${intPid(pid)}:${stamp}`;
}

function createExternalTerminalProcessAdapter(options = {}) {
  const platform = options.platform || process.platform;
  const spawn = options.spawnSync || spawnSync;
  const kill = options.processKill || ((pid, signal) => process.kill(pid, signal));
  const inspectImpl = typeof options.inspectProcess === 'function' ? options.inspectProcess : null;

  function windowsInspect(pid) {
    const command = [
      `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction SilentlyContinue;`,
      'if (-not $p) { exit 3 };',
      '$o = [ordered]@{ ProcessId = [int]$p.ProcessId; CreationDate = [string]$p.CreationDate; ExecutablePath = [string]$p.ExecutablePath; CommandLine = [string]$p.CommandLine };',
      '$o | ConvertTo-Json -Compress'
    ].join(' ');
    const result = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024
    });
    if (result.status === 3) return null;
    if (result.status !== 0) throw fail('MACHINE_EXTERNAL_PROCESS_INSPECT_FAILED', text(result.stderr) || 'Windows process inspection failed.');
    try {
      const parsed = JSON.parse(String(result.stdout || '').trim());
      return {
        pid: intPid(parsed.ProcessId),
        startedAt: text(parsed.CreationDate, 160),
        executablePath: text(parsed.ExecutablePath, 1024),
        commandLine: text(parsed.CommandLine, 4096)
      };
    } catch {
      throw fail('MACHINE_EXTERNAL_PROCESS_INSPECT_FAILED', 'Windows process inspection returned invalid metadata.');
    }
  }

  function posixInspect(pid) {
    const result = spawn('ps', ['-p', String(pid), '-o', 'pid=', '-o', 'lstart=', '-o', 'command='], {
      encoding: 'utf8', maxBuffer: 1024 * 1024
    });
    if (result.status !== 0 || !String(result.stdout || '').trim()) return null;
    const line = String(result.stdout).trim();
    const match = /^(\d+)\s+(.{24})\s+(.*)$/.exec(line);
    if (!match) throw fail('MACHINE_EXTERNAL_PROCESS_INSPECT_FAILED', 'POSIX process inspection returned invalid metadata.');
    return { pid: intPid(match[1]), startedAt: text(match[2], 160), executablePath: '', commandLine: text(match[3], 4096) };
  }

  function inspect(pidValue) {
    const pid = intPid(pidValue);
    const raw = inspectImpl ? inspectImpl(pid) : platform === 'win32' ? windowsInspect(pid) : posixInspect(pid);
    if (!raw) return null;
    const startedAt = text(raw.startedAt, 160);
    return {
      pid,
      targetId: externalTargetId(pid),
      processEpoch: epochFor(pid, startedAt),
      startedAt,
      executablePath: text(raw.executablePath, 1024),
      commandLine: text(raw.commandLine, 4096)
    };
  }

  function probe(input = {}) {
    const current = inspect(input.pid);
    if (!current) throw fail('MACHINE_EXTERNAL_PROCESS_NOT_FOUND', 'That external terminal process is no longer running.');
    const cwd = path.resolve(text(input.cwd, 2048) || process.cwd());
    const shellType = text(input.shellType, 80) || 'external';
    const adapterId = text(input.adapterId, 128);
    if (!adapterId) throw fail('MACHINE_TRUSTED_ADAPTER_ID_REQUIRED', 'Choose the trusted adapter that will own this external terminal attachment.');
    return Object.freeze({ ...current, cwd, shellType, adapterId });
  }

  function verifyExact(input = {}) {
    const pid = pidFromTargetId(input.targetId);
    const current = inspect(pid);
    if (!current) throw fail('MACHINE_EXTERNAL_PROCESS_NOT_FOUND', 'The attached external terminal process has exited.');
    if (current.processEpoch !== text(input.processEpoch, 256)) {
      throw fail('MACHINE_EXTERNAL_PROCESS_EPOCH_MISMATCH', 'The PID now belongs to a different process epoch; trusted attachment is stale.');
    }
    return current;
  }

  function observe(input = {}) {
    const current = verifyExact(input);
    return Object.freeze({
      alive: true,
      pid: current.pid,
      targetId: current.targetId,
      processEpoch: current.processEpoch,
      startedAt: current.startedAt,
      executablePath: current.executablePath,
      commandLine: current.commandLine
    });
  }

  function interrupt(input = {}) {
    const current = verifyExact(input);
    if (platform === 'win32') {
      const result = spawn('taskkill.exe', ['/pid', String(current.pid), '/t', '/f'], {
        encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024
      });
      if (result.status !== 0) throw fail('MACHINE_EXTERNAL_PROCESS_INTERRUPT_FAILED', text(result.stderr) || 'Windows process-tree interrupt failed.');
      return Object.freeze({ accepted: true, pid: current.pid, method: 'taskkill-tree' });
    }
    try { kill(-current.pid, 'SIGTERM'); return Object.freeze({ accepted: true, pid: current.pid, method: 'process-group-sigterm' }); }
    catch {
      try { kill(current.pid, 'SIGTERM'); return Object.freeze({ accepted: true, pid: current.pid, method: 'process-sigterm' }); }
      catch (error) { throw fail('MACHINE_EXTERNAL_PROCESS_INTERRUPT_FAILED', error.message); }
    }
  }

  return Object.freeze({ probe, observe, interrupt, inspect, externalTargetId, pidFromTargetId });
}

module.exports = {
  externalTargetId,
  pidFromTargetId,
  epochFor,
  createExternalTerminalProcessAdapter
};
