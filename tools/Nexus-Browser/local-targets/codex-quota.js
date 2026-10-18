'use strict';

// Read-only Codex app-server RPC. Never reads auth files or consumes credits.
const { spawn } = require('node:child_process');
const { resolveCodexLaunch } = require('./codex-common');
const FIVE_HOURS = 300;
const WEEK = 10080;
const MAX_OUTPUT = 512 * 1024;
const TIMEOUT_MS = 8000;
let cached = null;
let inFlight = null;

function quotaWindow(input) {
  if (!input || typeof input !== 'object') return null;
  const mins = Number(input.windowDurationMins);
  const used = Number(input.usedPercent);
  if (!Number.isFinite(mins) || !Number.isFinite(used) || used < 0 || used > 100) return null;
  const epoch = Number(input.resetsAt);
  const resetAt = Number.isFinite(epoch) && epoch > 0 && epoch < 8640000000000 / 1000
    ? new Date(epoch * 1000).toISOString() : null;
  return { windowMinutes: mins, remainingPercent: Math.round((100 - used) * 100) / 100, resetAt };
}

function normalizeRateLimits(response, observedAt = new Date().toISOString()) {
  const limits = response?.rateLimits || response?.rateLimitsByLimitId?.codex || null;
  const candidates = [limits?.primary, limits?.secondary].map(quotaWindow).filter(Boolean);
  const fiveHour = candidates.find((w) => w.windowMinutes === FIVE_HOURS) || null;
  const weekly = candidates.find((w) => w.windowMinutes === WEEK) || null;
  return {
    schema: 'eveos.codex-quota.v1', source: 'codex-app-server-account/rateLimits/read',
    observedAt, state: fiveHour || weekly ? 'AVAILABLE' : 'UNAVAILABLE',
    fiveHour, weekly, incomplete: !fiveHour || !weekly,
    reached: Boolean(limits?.rateLimitReachedType),
  };
}

function appServerRpc({ launch = resolveCodexLaunch(), spawnImpl = spawn, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (!launch) return reject(new Error('CODEX_NOT_INSTALLED'));
    // All arguments are fixed; no user-supplied shell string or prompt.
    const child = spawnImpl(launch.command, ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'], shell: Boolean(launch.shell), windowsHide: true,
    });
    let settled = false;
    let bytes = 0;
    let pending = '';
    const end = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin?.end(); child.kill(); } catch {}
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(() => end(new Error('CODEX_QUOTA_TIMEOUT')), timeoutMs);
    const send = (message) => {
      try { child.stdin.write(JSON.stringify(message) + '\n'); }
      catch { end(new Error('CODEX_QUOTA_STDIN_UNAVAILABLE')); }
    };
    const consume = (line) => {
      if (settled) return;
      let frame;
      try { frame = JSON.parse(line); } catch { return; }
      if (frame?.id === 1) {
        if (frame.error) return end(new Error('CODEX_QUOTA_INIT_FAILED'));
        send({ method: 'initialized', params: {} });
        send({ id: 2, method: 'account/rateLimits/read' });
      } else if (frame?.id === 2) {
        if (frame.error) return end(new Error('CODEX_QUOTA_READ_FAILED'));
        end(null, frame.result);
      }
    };
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT) return end(new Error('CODEX_QUOTA_OUTPUT_LIMIT'));
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) consume(line);
    });
    child.stdin?.on?.('error', () => end(new Error('CODEX_QUOTA_PIPE_ERROR')));
    child.once('error', () => end(new Error('CODEX_QUOTA_PROCESS_ERROR')));
    child.once('close', () => end(new Error('CODEX_QUOTA_PROCESS_EXIT')));
    // Ignore stderr: may include private local paths and diagnostics.
    child.stderr?.resume?.();
    send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'eveos-nexus-quota', title: 'EveOS Nexus Quota', version: '1.0.0' },
      capabilities: {},
    } });
  });
}

async function freshQuota({ reader = appServerRpc, now = Date.now, maxAgeMs = 30000 } = {}) {
  if (cached && now() - cached.time < maxAgeMs) return cached.value;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    let result;
    try { result = normalizeRateLimits(await reader(), new Date(now()).toISOString()); }
    catch { result = { schema: 'eveos.codex-quota.v1', source: 'codex-app-server-account/rateLimits/read', observedAt: new Date(now()).toISOString(), state: 'UNAVAILABLE', fiveHour: null, weekly: null, incomplete: true, reached: false }; }
    cached = { time: now(), value: result };
    return result;
  })();
  try { return await inFlight; } finally { inFlight = null; }
}

function dispatchPolicy(snapshot, { unattended = false, minRemaining = 5 } = {}) {
  const windows = [snapshot?.fiveHour, snapshot?.weekly].filter(Boolean);
  const unavailable = snapshot?.state !== 'AVAILABLE' || !windows.length || snapshot?.incomplete;
  const exhausted = Boolean(snapshot?.reached) || windows.some((w) => w.remainingPercent <= 0);
  const low = windows.some((w) => w.remainingPercent <= minRemaining);
  const permitted = !exhausted && (!unattended || (!low && !unavailable));
  return { permitted, state: exhausted ? 'EXHAUSTED' : unavailable ? 'INCOMPLETE' : low ? 'LOW' : 'READY',
    reason: exhausted ? 'Codex reports a reached quota.' : unavailable ? 'Fresh complete quota evidence unavailable.' : low ? 'Remaining quota is at or below the configured threshold.' : 'Quota evidence available.',
    minRemaining, unattended };
}

async function ensureCodexDispatch({ unattended = false, minRemaining = 5, read = freshQuota } = {}) {
  const snapshot = await read({ maxAgeMs: 0 });
  const policy = dispatchPolicy(snapshot, { unattended, minRemaining });
  if (!policy.permitted) {
    const error = new Error('Codex quota gate: ' + policy.reason);
    error.code = 'CODEX_QUOTA_BLOCKED';
    throw error;
  }
  return { snapshot, policy };
}

module.exports = { normalizeRateLimits, quotaWindow, appServerRpc, freshQuota, dispatchPolicy, ensureCodexDispatch };
