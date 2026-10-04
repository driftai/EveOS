'use strict';

const { execFile } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;
const INSPECT_MAX_BUFFER = 32 * 1024 * 1024;
const TRANSIENT_INSPECT_CODES = new Set([
  'stale_element',
  'element_not_available',
  'uia_element_not_available',
  'rpc_e_call_rejected'
]);

let resolved = null;
let resolvedAt = 0;
let queueRunning = false;
let queueSequence = 0;
const commandQueue = [];

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve) => {
    const maxBuffer = options.maxBuffer || DEFAULT_MAX_BUFFER;
    execFile(file, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      maxBuffer,
      env: options.env || process.env
    }, (error, stdout = '', stderr = '') => resolve({
      ok: !error,
      error,
      stdout: String(stdout || ''),
      stderr: String(stderr || ''),
      exitCode: typeof error?.code === 'number' ? error.code : error ? null : 0,
      processErrorCode: typeof error?.code === 'string' ? error.code : null,
      errorMessage: error?.message || '',
      signal: error?.signal || null,
      killed: !!error?.killed,
      maxBuffer
    }));
  });
}

async function resolveCommand({ env = process.env, now = Date.now(), exec = execFileAsync } = {}) {
  const configured = String(env.NEXUS_WINAPP_CLI || env.BROWSER_AI_BRIDGE_WINAPP_CLI || '').trim();
  if (configured) return configured;
  if (process.platform !== 'win32') return '';
  if (resolved && now - resolvedAt < 30000) return resolved;
  const found = await exec('where.exe', ['winapp'], { timeoutMs: 3000, env });
  resolved = found.ok
    ? found.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || ''
    : '';
  resolvedAt = now;
  return resolved;
}

function parseJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch {}
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch {}
  }
  return null;
}

function isInspect(args = []) {
  return args?.[0] === 'ui' && args?.[1] === 'inspect';
}

function inspectTimeoutFailure(args, result, json) {
  if (!isInspect(args) || result?.ok) return false;
  const code = String(json?.code || json?.error?.code || result?.processErrorCode || '').toLowerCase();
  const message = String(
    json?.message || json?.error?.message || result?.stderr
    || result?.errorMessage || result?.stdout || ''
  ).toLowerCase();
  return result?.signal === 'SIGTERM'
    || code === 'etimedout'
    || /timed out|timeout|killed after/.test(message);
}

function transientInspectFailure(args, result, json) {
  if (!isInspect(args) || result?.ok) return false;
  if (inspectTimeoutFailure(args, result, json)) return true;
  const code = String(json?.code || json?.error?.code || result?.processErrorCode || '').toLowerCase();
  const message = String(
    json?.message || json?.error?.message || result?.stderr
    || result?.errorMessage || result?.stdout || ''
  ).toLowerCase();
  return TRANSIENT_INSPECT_CODES.has(code)
    || /stale[_ ]element|no longer accessible|element.+not available|rpc.+rejected/.test(message);
}

function defaultMaxBuffer(args = []) {
  return isInspect(args) ? INSPECT_MAX_BUFFER : DEFAULT_MAX_BUFFER;
}

function commandPriority(args = []) {
  if (args?.[0] !== 'ui') return 0;
  const command = String(args?.[1] || '');
  if (['set-value', 'focus', 'send-keys', 'invoke'].includes(command)) return 50;
  if (command === 'search') return 45;
  if (command === 'inspect') return args.includes('--hide-offscreen') ? 40 : 30;
  if (command === 'list-windows') return 10;
  return 20;
}

function scheduleCommand(args, task) {
  return new Promise((resolve, reject) => {
    commandQueue.push({
      priority: commandPriority(args),
      sequence: queueSequence += 1,
      task,
      resolve,
      reject
    });
    drainQueue();
  });
}

async function drainQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (commandQueue.length) {
      commandQueue.sort((left, right) =>
        right.priority - left.priority || left.sequence - right.sequence);
      const entry = commandQueue.shift();
      try { entry.resolve(await entry.task()); }
      catch (error) { entry.reject(error); }
    }
  } finally {
    queueRunning = false;
  }
}

function shallowInspectArgs(argv = []) {
  if (!argv.includes('--hide-offscreen')) return [...argv];
  const next = [...argv];
  const depthIndex = next.indexOf('--depth');
  if (depthIndex >= 0 && next[depthIndex + 1]) {
    const depth = Number(next[depthIndex + 1]);
    next[depthIndex + 1] = String(Number.isFinite(depth) ? Math.min(depth, 8) : 8);
  } else {
    next.push('--depth', '8');
  }
  return next;
}

async function runJsonUnlocked(args, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env,
  exec = execFileAsync,
  executable,
  allowFailure = false,
  transientRetries = null,
  maxBuffer = null
} = {}) {
  let argv = [...args];
  if (!argv.includes('--json')) argv.push('--json');
  const defaultRetries = isInspect(args) ? 1 : 0;
  const retries = transientRetries == null
    ? defaultRetries
    : Math.max(0, Number(transientRetries) || 0);
  const bufferLimit = Math.max(1024, Number(maxBuffer) || defaultMaxBuffer(args));
  let result = null;
  let json = null;
  let timedOut = false;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const attemptTimeout = attempt > 0 && timedOut
      ? Math.min(timeoutMs, 8000)
      : timeoutMs;
    result = await exec(executable, argv, {
      timeoutMs: attemptTimeout,
      env,
      maxBuffer: bufferLimit
    });
    json = parseJson(result.stdout);
    timedOut = inspectTimeoutFailure(args, result, json);
    if (!transientInspectFailure(args, result, json) || attempt >= retries) break;
    if (timedOut) argv = shallowInspectArgs(argv);
    await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)));
  }

  if (!result.ok && !allowFailure) {
    const message = json?.message || json?.error?.message || result.stderr.trim()
      || result.errorMessage || result.stdout.trim()
      || (result.processErrorCode ? `winapp failed (${result.processErrorCode})` : '')
      || `winapp exited with code ${result.exitCode}`;
    const error = new Error(String(message).slice(0, 1000));
    error.code = inspectTimeoutFailure(args, result, json)
      ? 'APP_UIA_INSPECT_TIMEOUT'
      : json?.code || json?.error?.code || result.processErrorCode || 'APP_BRIDGE_COMMAND_FAILED';
    error.detail = {
      args: argv,
      exitCode: result.exitCode,
      processErrorCode: result.processErrorCode || null,
      signal: result.signal || null,
      killed: !!result.killed,
      stdoutChars: result.stdout.length,
      stderrChars: result.stderr.length,
      maxBuffer: bufferLimit,
      json
    };
    throw error;
  }
  return { ...result, json, command: executable, args: argv, maxBuffer: bufferLimit };
}

async function runJson(args, options = {}) {
  const env = options.env || process.env;
  const exec = options.exec || execFileAsync;
  const executable = options.command || await resolveCommand({ env, exec });
  if (!executable) {
    const error = new Error('Microsoft winapp CLI is not installed or not on PATH.');
    error.code = 'APP_BRIDGE_HELPER_MISSING';
    error.detail = { install: 'winget install Microsoft.winappcli --source winget' };
    throw error;
  }
  return scheduleCommand(args, () => runJsonUnlocked(args, {
    ...options,
    env,
    exec,
    executable
  }));
}

async function availability(options = {}) {
  if (process.platform !== 'win32') {
    return { available: false, code: 'APP_BRIDGE_WINDOWS_ONLY', platform: process.platform };
  }
  const command = await resolveCommand(options);
  return command
    ? { available: true, command }
    : {
        available: false,
        code: 'APP_BRIDGE_HELPER_MISSING',
        install: 'winget install Microsoft.winappcli --source winget'
      };
}

function resetCache() {
  resolved = null;
  resolvedAt = 0;
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BUFFER,
  INSPECT_MAX_BUFFER,
  execFileAsync,
  resolveCommand,
  parseJson,
  defaultMaxBuffer,
  inspectTimeoutFailure,
  transientInspectFailure,
  commandPriority,
  shallowInspectArgs,
  runJson,
  availability,
  resetCache
};
