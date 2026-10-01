'use strict';

const { execFile } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 15000;
let resolved = null;
let resolvedAt = 0;

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
      env: options.env || process.env
    }, (error, stdout = '', stderr = '') => {
      resolve({
        ok: !error,
        error,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        exitCode: Number(error?.code ?? 0) || 0,
        signal: error?.signal || null
      });
    });
  });
}

async function resolveCommand({ env = process.env, now = Date.now(), exec = execFileAsync } = {}) {
  const configured = String(env.NEXUS_WINAPP_CLI || env.BROWSER_AI_BRIDGE_WINAPP_CLI || '').trim();
  if (configured) return configured;
  if (process.platform !== 'win32') return '';
  if (resolved && now - resolvedAt < 30000) return resolved;
  const found = await exec('where.exe', ['winapp'], { timeoutMs: 3000, env });
  resolved = found.ok ? found.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '' : '';
  resolvedAt = now;
  return resolved;
}

function parseJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); }
  catch {
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try { return JSON.parse(lines[index]); } catch {}
    }
    return null;
  }
}

async function runJson(args, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env,
  exec = execFileAsync,
  command = null,
  allowFailure = false
} = {}) {
  const executable = command || await resolveCommand({ env, exec });
  if (!executable) {
    const error = new Error('Microsoft winapp CLI is not installed or not on PATH.');
    error.code = 'APP_BRIDGE_HELPER_MISSING';
    error.detail = { install: 'winget install Microsoft.winappcli --source winget' };
    throw error;
  }
  const argv = [...args];
  if (!argv.includes('--json')) argv.push('--json');
  const result = await exec(executable, argv, { timeoutMs, env });
  const json = parseJson(result.stdout);
  if (!result.ok && !allowFailure) {
    const message = json?.message || json?.error?.message || result.stderr.trim()
      || result.stdout.trim() || `winapp exited with code ${result.exitCode}`;
    const error = new Error(message.slice(0, 1000));
    error.code = json?.code || json?.error?.code || 'APP_BRIDGE_COMMAND_FAILED';
    error.detail = { args: argv, exitCode: result.exitCode, json };
    throw error;
  }
  return { ...result, json, command: executable, args: argv };
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
  execFileAsync,
  resolveCommand,
  parseJson,
  runJson,
  availability,
  resetCache
};
