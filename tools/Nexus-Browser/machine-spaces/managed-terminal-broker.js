'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const MAX_SESSIONS = 8;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_SUPERVISED_TIMEOUT_MS = 8 * 60 * 60 * 1000;
const SUPPORTED_TYPES = Object.freeze(['powershell', 'cmd', 'pwsh', 'wsl']);

function machineError(code, message) {
  return Object.assign(new Error(message), { code });
}

function safeLabel(value, fallback) {
  return String(value || fallback).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 80) || fallback;
}

function shellInvocation(type, command, platform = process.platform) {
  if (type === 'cmd') {
    if (platform !== 'win32') throw machineError('MACHINE_SHELL_UNAVAILABLE', 'CMD is available only on Windows.');
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  if (type === 'powershell') {
    if (platform !== 'win32') throw machineError('MACHINE_SHELL_UNAVAILABLE', 'Windows PowerShell is available only on Windows.');
    return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] };
  }
  if (type === 'pwsh') {
    return { file: platform === 'win32' ? 'pwsh.exe' : 'pwsh',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] };
  }
  if (type === 'wsl') {
    if (platform !== 'win32') throw machineError('MACHINE_SHELL_UNAVAILABLE', 'WSL targets are available only from Windows.');
    return { file: 'wsl.exe', args: ['--exec', 'bash', '--noprofile', '--norc', '-c', command] };
  }
  throw machineError('MACHINE_BAD_TARGET_TYPE', 'Unsupported managed terminal type.');
}

function createManagedTerminalBroker({
  spawnImpl = spawn,
  fsImpl = fs,
  platform = process.platform,
  defaultCwd = process.cwd(),
  now = () => Date.now(),
  idFactory = () => randomUUID(),
  executableCheck = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_OUTPUT_BYTES,
  supervisedTimeoutMs = DEFAULT_SUPERVISED_TIMEOUT_MS
} = {}) {
  const sessions = new Map();
  const active = new Map();
  const realpath = fsImpl.realpathSync?.native || fsImpl.realpathSync;

  function executableAvailable(file) {
    if (typeof executableCheck === 'function') return executableCheck(file) === true;
    const envPath = String(process.env.PATH || process.env.Path || '');
    const directories = envPath.split(platform === 'win32' ? ';' : ':').map((entry) => entry.trim().replace(/^"|"$/g, '')).filter(Boolean);
    return directories.some((directory) => {
      try { return fsImpl.statSync(path.join(directory, file)).isFile(); } catch { return false; }
    });
  }

  function canonicalDirectory(input) {
    const requested = path.resolve(String(input || defaultCwd));
    let resolved;
    try {
      resolved = realpath.call(fsImpl.realpathSync, requested);
      if (!fsImpl.statSync(resolved).isDirectory()) throw new Error('not-directory');
    } catch {
      throw machineError('MACHINE_BAD_CWD', 'Choose an existing local directory for this managed terminal.');
    }
    return resolved;
  }

  function target(session) {
    const running = active.get(session.targetId) || null;
    return Object.freeze({
      id: session.targetId,
      targetId: session.targetId,
      targetClassId: 'terminal-origin',
      targetTypeId: session.type,
      targetTypeName: session.type === 'cmd' ? 'Command Prompt'
        : session.type === 'powershell' ? 'Windows PowerShell'
          : session.type === 'pwsh' ? 'PowerShell 7' : 'WSL Bash',
      title: session.label,
      type: session.type,
      sessionOrigin: 'managed',
      processEpoch: session.processEpoch,
      cwd: session.cwd,
      busy: !!running,
      activeMode: running?.mode || null,
      activeRequestId: running?.requestId || null,
      capabilities: {
        managed: true,
        executeWithOwnerApproval: true,
        stdout: true,
        stderr: true,
        interrupt: true,
        supervised: true,
        sessionRebound: true,
        trustedAttach: false
      }
    });
  }

  function createSession({ type, label, cwd } = {}) {
    if (!SUPPORTED_TYPES.includes(type)) throw machineError('MACHINE_BAD_TARGET_TYPE', 'Choose a supported managed terminal type.');
    const invocation = shellInvocation(type, 'echo probe', platform);
    if (!executableAvailable(invocation.file)) throw machineError('MACHINE_SHELL_UNAVAILABLE', `${invocation.file} is not installed or available on PATH.`);
    if (sessions.size >= MAX_SESSIONS) throw machineError('MACHINE_SESSION_LIMIT', 'Stop another managed terminal before creating a new one.');
    const suffix = idFactory();
    const session = {
      targetId: `terminal-${type}-${suffix}`,
      processEpoch: `session-${suffix}`,
      type,
      label: safeLabel(label, type === 'cmd' ? 'Managed Command Prompt'
        : type === 'powershell' ? 'Managed Windows PowerShell'
          : type === 'pwsh' ? 'Managed PowerShell 7' : 'Managed WSL Bash'),
      cwd: canonicalDirectory(cwd),
      createdAt: new Date(now()).toISOString()
    };
    sessions.set(session.targetId, session);
    return target(session);
  }

  function exact(targetId, processEpoch = null) {
    const session = sessions.get(String(targetId || ''));
    if (!session || (processEpoch && session.processEpoch !== processEpoch)) return null;
    return session;
  }

  function listTargets() {
    return [...sessions.values()].map(target);
  }

  function spawnCommand(session, requestId, command, mode, onStart) {
    if (active.has(session.targetId)) throw machineError('MACHINE_TARGET_BUSY', 'This managed terminal is already running a command.');
    const invocation = shellInvocation(session.type, String(command), platform);
    const startedAt = new Date(now()).toISOString();
    let child;
    try {
      child = spawnImpl(invocation.file, invocation.args, {
        cwd: session.cwd,
        env: process.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      throw machineError('MACHINE_SPAWN_FAILED', error.message);
    }
    const state = {
      child,
      requestId: String(requestId || ''),
      mode,
      interrupted: false,
      exceeded: false,
      timedOut: false,
      startedAt
    };
    active.set(session.targetId, state);
    onStart?.({ pid: Number(child.pid) || null, startedAt, mode,
      invocation: { file: invocation.file, args: [...invocation.args] } });
    return state;
  }

  function run({ targetId, requestId, command, onStart } = {}) {
    const session = exact(targetId);
    if (!session) return Promise.reject(machineError('MACHINE_TARGET_NOT_FOUND', 'Managed terminal no longer exists.'));
    let state;
    try { state = spawnCommand(session, requestId, command, 'bounded', onStart); }
    catch (error) { return Promise.reject(error); }
    const { child, startedAt } = state;
    return new Promise((resolve, reject) => {
      const stdout = [], stderr = [];
      let bytes = 0, finished = false;
      const timer = setTimeout(() => {
        state.timedOut = true;
        try { child.kill(); } catch {}
      }, timeoutMs);
      const collect = (bucket) => (chunk) => {
        if (finished) return;
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > maxOutputBytes) {
          state.exceeded = true;
          try { child.kill(); } catch {}
          return;
        }
        bucket.push(buffer);
      };
      child.stdout?.on?.('data', collect(stdout));
      child.stderr?.on?.('data', collect(stderr));
      child.once?.('error', (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        active.delete(session.targetId);
        reject(machineError('MACHINE_SPAWN_FAILED', error.message));
      });
      child.once?.('close', (code, signal) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        active.delete(session.targetId);
        const uncertain = state.timedOut || state.exceeded || state.interrupted;
        resolve({
          requestId: state.requestId,
          targetId: session.targetId,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          bytes: Math.min(bytes, maxOutputBytes),
          exitCode: Number.isInteger(code) ? code : null,
          signal: signal || null,
          state: uncertain ? 'outcome-unknown' : code === 0 ? 'completed' : 'failed',
          reason: state.timedOut ? 'timeout' : state.exceeded ? 'output-limit'
            : state.interrupted ? 'interrupted' : null,
          startedAt,
          finishedAt: new Date(now()).toISOString()
        });
      });
    });
  }

  function runSupervised({ targetId, processEpoch, requestId, command, onStart, onData } = {}) {
    const session = exact(targetId, processEpoch || null);
    if (!session) return Promise.reject(machineError('MACHINE_TARGET_EPOCH_MISMATCH', 'Managed terminal no longer matches the trusted process epoch.'));
    let state;
    try { state = spawnCommand(session, requestId, command, 'supervised', onStart); }
    catch (error) { return Promise.reject(error); }
    const { child, startedAt } = state;
    return new Promise((resolve, reject) => {
      const stdout = [], stderr = [];
      let storedBytes = 0, totalBytes = 0, finished = false, outputTruncated = false;
      const timer = setTimeout(() => {
        state.timedOut = true;
        try { child.kill(); } catch {}
      }, supervisedTimeoutMs);
      const collect = (stream, bucket) => (chunk) => {
        if (finished) return;
        const buffer = Buffer.from(chunk);
        totalBytes += buffer.length;
        if (storedBytes < maxOutputBytes) {
          const remaining = maxOutputBytes - storedBytes;
          const kept = buffer.subarray(0, remaining);
          if (kept.length) { bucket.push(kept); storedBytes += kept.length; }
          if (kept.length < buffer.length) outputTruncated = true;
        } else outputTruncated = true;
        onData?.({ targetId: session.targetId, requestId: state.requestId, stream,
          text: buffer.toString('utf8'), totalBytes, storedBytes, outputTruncated });
      };
      child.stdout?.on?.('data', collect('stdout', stdout));
      child.stderr?.on?.('data', collect('stderr', stderr));
      child.once?.('error', (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        active.delete(session.targetId);
        reject(machineError('MACHINE_SPAWN_FAILED', error.message));
      });
      child.once?.('close', (code, signal) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        active.delete(session.targetId);
        const uncertain = state.timedOut || state.interrupted;
        resolve({
          requestId: state.requestId,
          targetId: session.targetId,
          processEpoch: session.processEpoch,
          mode: 'supervised',
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          bytes: storedBytes,
          totalBytes,
          outputTruncated,
          exitCode: Number.isInteger(code) ? code : null,
          signal: signal || null,
          state: uncertain ? 'outcome-unknown' : code === 0 ? 'completed' : 'failed',
          reason: state.timedOut ? 'supervised-timeout' : state.interrupted ? 'interrupted' : null,
          startedAt,
          finishedAt: new Date(now()).toISOString()
        });
      });
    });
  }

  function interrupt(targetId) {
    const state = active.get(String(targetId || ''));
    if (!state) return false;
    state.interrupted = true;
    try { return state.child.kill(); } catch { return false; }
  }

  function activeInfo(targetId) {
    const state = active.get(String(targetId || ''));
    if (!state) return null;
    return Object.freeze({ requestId: state.requestId, mode: state.mode, startedAt: state.startedAt,
      interrupted: state.interrupted, timedOut: state.timedOut });
  }

  function stopSession(targetId) {
    const id = String(targetId || '');
    if (!sessions.has(id)) return false;
    interrupt(id);
    sessions.delete(id);
    return true;
  }

  function stopAll() {
    for (const id of [...sessions.keys()]) stopSession(id);
  }

  return {
    createSession,
    listTargets,
    exact,
    target: (targetId) => {
      const session = exact(targetId);
      return session ? target(session) : null;
    },
    run,
    runSupervised,
    interrupt,
    activeInfo,
    stopSession,
    stopAll,
    availableTypes: () => SUPPORTED_TYPES.filter((type) => {
      try { return executableAvailable(shellInvocation(type, 'echo probe', platform).file); } catch { return false; }
    }),
    activeCount: () => active.size
  };
}

module.exports = {
  MAX_SESSIONS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_OUTPUT_BYTES,
  DEFAULT_SUPERVISED_TIMEOUT_MS,
  SUPPORTED_TYPES,
  shellInvocation,
  createManagedTerminalBroker
};
