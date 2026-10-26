#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
const PORT_CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'eveos-ports.json'), 'utf8'));
export const PORTS = Object.freeze(
  Object.fromEntries(Object.entries(PORT_CONFIG.ports || {}).map(([key, value]) => [key, Number(value.port)]))
);

export const CONTROL_BASE = `http://127.0.0.1:${PORTS.GEMINI_CONTROL_PORT}`;
export const WEB_BASE = `http://127.0.0.1:${PORTS.EVEOS_WEB_PORT}`;

export const SEARCH_MONITOR_SERVICES = Object.freeze({
  web: {
    key: 'web',
    label: 'EveOS localhost',
    statusPath: `/api/eveos-server/status?port=${PORTS.EVEOS_WEB_PORT}`,
    startPath: `/api/eveos-server/start?port=${PORTS.EVEOS_WEB_PORT}`,
    stopPath: `/api/eveos-server/stop-web?port=${PORTS.EVEOS_WEB_PORT}`,
    port: PORTS.EVEOS_WEB_PORT,
  },
  localMoe: {
    key: 'localMoe',
    label: 'Local MoE Harness',
    statusPath: '/api/local-moe/status',
    startPath: '/api/local-moe/start',
    stopPath: '/api/local-moe/stop',
    port: PORTS.LOCAL_MOE_HARNESS_PORT,
    runtimePort: PORTS.FREETOKEN_PORT,
  },
  nexusBrowser: {
    key: 'nexusBrowser',
    label: 'Nexus Browser',
    statusPath: '/api/nexus-browser/status',
    startPath: '/api/nexus-browser/start',
    stopPath: '/api/nexus-browser/stop',
    port: PORTS.NEXUS_BROWSER_PORT, statusTimeoutMs: 15_000,
  },
  gemini: {
    key: 'gemini',
    label: 'Gemini Live Link',
    statusPath: '/api/gemini-server/status',
    startPath: '/api/gemini-server/start',
    stopPath: '/api/gemini-server/stop',
    port: PORTS.GEMINI_STATUS_PORT,
    websocketPort: PORTS.GEMINI_WS_PORT,
  },
});

const RUNTIME_DIR = path.join(ROOT, 'data', 'runtime');
const RESULT_DIR = path.join(RUNTIME_DIR, 'smoke-results');
const SESSION_PATH = path.join(RUNTIME_DIR, 'search-monitor-runtime-session.json');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactError(error) {
  return String(error?.message || error || 'unknown error').replace(/\s+/g, ' ').slice(0, 500);
}

export function requestJson(url, { method = 'GET', body = null, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const encoded = body === null ? null : Buffer.from(JSON.stringify(body));
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers: {
        Connection: 'close',
        ...(encoded ? {
          'Content-Type': 'application/json',
          'Content-Length': String(encoded.length),
        } : {}),
      },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 2_000_000) chunks.push(chunk);
      });
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch (_) {}
        resolve({
          status: Number(response.statusCode || 0),
          ok: Number(response.statusCode || 0) < 400 && payload?.ok !== false,
          payload,
          text,
        });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`${method} ${target.pathname}${target.search} timed out after ${timeoutMs}ms`)));
    request.on('error', reject);
    if (encoded) request.write(encoded);
    request.end();
  });
}

async function safeJson(url, options) {
  try {
    return await requestJson(url, options);
  } catch (error) {
    return { status: 0, ok: false, payload: null, text: '', error: compactError(error) };
  }
}

export async function controlHealth() {
  const result = await safeJson(`${CONTROL_BASE}/api/control-plane/health`, { timeoutMs: 1200 });
  return result.payload?.ok === true && result.payload?.service === 'eveos-control-plane'
    ? result.payload
    : null;
}

export function runWindowsBatchSync(batchPath, options = {}) {
  const { args = [], cwd = ROOT, env = process.env, stdio = 'inherit', encoding } = options;
  return spawnSync(env.ComSpec || process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'call', batchPath, ...args], {
    cwd, stdio, env, windowsHide: false, ...(encoding ? { encoding } : {}),
  });
}

async function waitUntil(check, { timeoutMs, intervalMs = 300, label, progress } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let nextProgress = Date.now();
  while (Date.now() < deadline) {
    last = await check();
    if (last?.ready) return last.value;
    if (progress && Date.now() >= nextProgress) {
      progress(last?.value);
      nextProgress = Date.now() + 15_000;
    }
    await delay(intervalMs);
  }
  throw new Error(`${label || 'condition'} did not become ready within ${Math.round(timeoutMs / 1000)}s`);
}

export async function ensureControlPlane({ timeoutMs = 30_000 } = {}) {
  const existing = await controlHealth();
  if (existing) return { started: false, health: existing };

  if (process.platform === 'win32') {
    const launcher = path.join(ROOT, 'tools', 'batch', 'start-eveos-control.bat');
    const result = runWindowsBatchSync(launcher, {
      cwd: ROOT, stdio: 'inherit', env: { ...process.env, EVEOS_HEADLESS: '' },
    });
    if (result.error || result.status !== 0) {
      throw new Error(`EveOS Local Control launcher failed (${result.status ?? 'spawn error'}): ${compactError(result.error)}`);
    }
  } else {
    const python = process.env.PYTHON || 'python3';
    const child = spawn(
      python,
      [path.join(ROOT, 'server', 'eveos-control-helper.py'), String(PORTS.GEMINI_CONTROL_PORT)],
      { cwd: ROOT, detached: true, stdio: 'ignore', env: { ...process.env, EVEOS_HEADLESS: '' } },
    );
    child.unref();
  }

  const health = await waitUntil(
    async () => ({ ready: !!(await controlHealth()), value: await controlHealth() }),
    { timeoutMs, label: 'EveOS Local Control' },
  );
  return { started: true, health };
}

export async function configureHeadedServices(serviceNames) {
  const keep = await requestJson(`${CONTROL_BASE}/api/control-plane/consoles`, {
    method: 'POST',
    body: { keepLocalControlAfterToolStop: true },
  });
  if (!keep.ok) throw new Error(`Could not keep Local Control alive: ${keep.payload?.message || keep.text}`);

  const headedDefault = await requestJson(`${CONTROL_BASE}/api/control-plane/consoles`, {
    method: 'POST',
    body: { service: 'default', headless: false },
  });
  if (!headedDefault.ok) {
    throw new Error(`Could not enforce headed-by-default terminals: ${headedDefault.payload?.message || headedDefault.text}`);
  }
  let preferences = headedDefault.payload;

  for (const name of serviceNames) {
    const service = SEARCH_MONITOR_SERVICES[name];
    if (!service) throw new Error(`Unknown Search Monitor service: ${name}`);
    const result = await requestJson(`${CONTROL_BASE}/api/control-plane/consoles`, {
      method: 'POST',
      body: { service: service.key, headless: false },
    });
    if (!result.ok) throw new Error(`Could not make ${service.label} headed: ${result.payload?.message || result.text}`);
    preferences = result.payload;
    const saved = (preferences?.services || []).find((item) => item.key === service.key);
    if (!saved || saved.headless) throw new Error(`${service.label} did not persist headed terminal preference.`);
  }

  if (preferences?.envForced) {
    throw new Error('EVEOS_HEADLESS is forcing hidden services in the existing Local Control process. Restart Local Control without EVEOS_HEADLESS.');
  }
  return preferences;
}

export async function serviceStatus(name) {
  const service = SEARCH_MONITOR_SERVICES[name];
  if (!service) throw new Error(`Unknown Search Monitor service: ${name}`);
  return (await safeJson(`${CONTROL_BASE}${service.statusPath}`, { timeoutMs: service.statusTimeoutMs || 6000 })).payload;
}

export async function directIdentity(name) {
  if (name === 'web') {
    const result = await safeJson(`${WEB_BASE}/api/status`, { timeoutMs: 1500 });
    return { ready: result.payload?.ok === true && result.payload?.service === 'eveos-local-server', payload: result.payload };
  }
  if (name === 'localMoe') {
    const result = await safeJson(`http://127.0.0.1:${PORTS.LOCAL_MOE_HARNESS_PORT}/openapi.json`, { timeoutMs: 1500 });
    return { ready: result.payload?.info?.title === 'Local MoE Harness', payload: result.payload?.info || null };
  }
  if (name === 'nexusBrowser') {
    const result = await safeJson(`http://127.0.0.1:${PORTS.NEXUS_BROWSER_PORT}/health`, { timeoutMs: 1500 });
    return { ready: result.payload?.ok === true && result.payload?.service === 'eveos-nexus-browser', payload: result.payload };
  }
  if (name === 'gemini') {
    const status = await serviceStatus('gemini');
    return { ready: status?.running === true && status?.statusReady === true && status?.websocketReady === true, payload: status };
  }
  return { ready: false, payload: null };
}

export async function waitForService(name, timeoutMs = 30_000) {
  const service = SEARCH_MONITOR_SERVICES[name];
  return waitUntil(async () => {
    const status = await serviceStatus(name);
    const identity = await directIdentity(name);
    return {
      ready: status?.running === true && identity.ready === true,
      value: { status, identity: identity.payload },
    };
  }, {
    timeoutMs,
    label: service.label,
    progress: (value) => {
      const state = value?.status?.state || 'waiting';
      console.log(`WAIT ${service.label}: ${state}`);
    },
  });
}

export async function startService(name, timeoutMs = 30_000) {
  const service = SEARCH_MONITOR_SERVICES[name];
  const before = await serviceStatus(name);
  const identity = await directIdentity(name);
  if (before?.running === true && identity.ready) {
    return { started: false, status: before, identity: identity.payload };
  }
  if (['blocked', 'conflict', 'external'].includes(String(before?.state || ''))) {
    throw new Error(`${service.label} is ${before.state}: ${before.message || 'ownership conflict'}`);
  }
  const result = await requestJson(`${CONTROL_BASE}${service.startPath}`, { method: 'POST', body: {}, timeoutMs: name === 'localMoe' ? 45_000 : 15_000 });
  if (!result.ok && result.payload?.state !== 'starting') {
    throw new Error(`${service.label} start failed: ${result.payload?.message || result.text}`);
  }
  const ready = await waitForService(name, timeoutMs);
  return { started: true, ...ready };
}

export async function stopService(name, timeoutMs = 45_000) {
  const service = SEARCH_MONITOR_SERVICES[name];
  const before = await serviceStatus(name);
  if (!before?.running && !['starting'].includes(String(before?.state || ''))) {
    return { stopped: false, status: before };
  }
  const result = await requestJson(`${CONTROL_BASE}${service.stopPath}`, {
    method: 'POST',
    body: {},
    timeoutMs: Math.max(15_000, timeoutMs),
  });
  if (!result.ok) throw new Error(`${service.label} stop failed: ${result.payload?.message || result.text}`);
  const status = await waitUntil(async () => {
    const current = await serviceStatus(name);
    return { ready: current?.running !== true && current?.state !== 'starting', value: current };
  }, { timeoutMs, label: `${service.label} stop` });
  return { stopped: true, status };
}

export async function tloStatus() {
  const result = await safeJson(`${WEB_BASE}/api/eve-state/modular/tlo/status?scopeId=default`, { timeoutMs: 15000 });
  return result.payload;
}

export async function ensureLocalModelRuntime(timeoutMs = 30_000) {
  const current = await safeJson(`http://127.0.0.1:${PORTS.LOCAL_MOE_HARNESS_PORT}/api/status`, { timeoutMs: 5000 });
  if (current.payload?.runtime?.ready === true) return current.payload;
  const start = await safeJson(`http://127.0.0.1:${PORTS.LOCAL_MOE_HARNESS_PORT}/api/runtime/start`, {
    method: 'POST',
    timeoutMs,
  });
  if (!start.ok || start.payload?.lifecycle?.startup_stage === 'failed') {
    throw new Error(`Local MoE model runtime start failed: ${start.payload?.lifecycle?.last_error || start.payload?.detail?.message || start.payload?.detail || start.error || start.text || 'unknown error'}`);
  }
  return start.payload;
}

export async function waitForTloReady(timeoutMs = 600_000) {
  return waitUntil(async () => {
    const probe = await safeJson(`http://127.0.0.1:${PORTS.LOCAL_MOE_HARNESS_PORT}/api/status`, { timeoutMs: 7000 });
    const lifecycle = probe.payload?.runtime_lifecycle || {}, runtime = probe.payload?.runtime || {};
    if (lifecycle.startup_stage === 'failed') throw new Error(`Local model startup failed: ${lifecycle.last_error || runtime.error || 'runtime exited before readiness'}`);
    if (runtime.ready !== true) return { ready: false, value: { state: lifecycle.startup_stage || 'runtime_starting', agent: { activeModelId: lifecycle.active_model_id }, message: lifecycle.last_error || runtime.error || 'Local model is still loading.' } };
    const status = await tloStatus();
    return { ready: status?.ok === true && status?.canChat === true && status?.state === 'ready', value: status };
  }, { timeoutMs, intervalMs: 1500, label: 'TLO / Local MoE model', progress: (status) => {
    const model = status?.agent?.activeModelId || status?.agent?.configuredModelId || 'model';
    console.log(`WAIT TLO: ${status?.state || 'unavailable'} · ${model} · ${status?.message || ''}`);
  } });
}

function readSession() {
  try {
    const payload = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
    return payload && typeof payload === 'object' ? payload : {};
  } catch (_) {
    return {};
  }
}

export function runtimeSession() {
  return readSession();
}

export function writeRuntimeSession(session) {
  fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });
  const temporary = `${SESSION_PATH}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(session, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, SESSION_PATH);
  return session;
}

export function clearRuntimeSession() {
  try { fs.unlinkSync(SESSION_PATH); } catch (_) {}
}

function portListeners() {
  const wanted = new Set(Object.values(PORTS).filter(Number.isFinite));
  const found = {};
  if (process.platform === 'win32') {
    const result = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
    for (const line of String(result.stdout || '').split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const match = parts[1]?.match(/:(\d+)$/);
      const port = Number(match?.[1]);
      if (!wanted.has(port) || !/^\d+$/.test(parts.at(-1) || '')) continue;
      (found[port] ||= []).push({ pid: Number(parts.at(-1)), local: parts[1] });
    }
  }
  return found;
}

function tailFile(filePath, maxLines = 40) {
  try {
    const stat = fs.statSync(filePath);
    const bytes = Math.min(stat.size, 64 * 1024);
    const handle = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(bytes);
    fs.readSync(handle, buffer, 0, bytes, stat.size - bytes);
    fs.closeSync(handle);
    return buffer.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-maxLines);
  } catch (_) {
    return [];
  }
}

function collectLogTails() {
  const candidates = [
    path.join(RUNTIME_DIR, 'logs', 'eveos-web.out.log'),
    path.join(RUNTIME_DIR, 'logs', 'eveos-web.err.log'),
    path.join(RUNTIME_DIR, 'nexus-browser', 'server.log'),
  ];
  const harnessLogDir = path.join(ROOT, 'tools', 'Local-MoE-Harness', 'logs');
  try {
    const extra = fs.readdirSync(harnessLogDir)
      .filter((name) => name.toLowerCase().endsWith('.log'))
      .slice(-4)
      .map((name) => path.join(harnessLogDir, name));
    candidates.push(...extra);
  } catch (_) {}
  return Object.fromEntries(
    candidates.map((filePath) => [path.relative(ROOT, filePath).replace(/\\/g, '/'), tailFile(filePath)])
      .filter(([, lines]) => lines.length),
  );
}

export async function runtimeSnapshot(extra = {}) {
  const control = await controlHealth();
  const services = {};
  for (const name of Object.keys(SEARCH_MONITOR_SERVICES)) {
    services[name] = {
      status: control ? await serviceStatus(name) : null,
      identity: await directIdentity(name),
    };
  }
  const localMoe = await safeJson(`http://127.0.0.1:${PORTS.LOCAL_MOE_HARNESS_PORT}/api/runtime/status`, { timeoutMs: 5000 });
  const nexus = await safeJson(`http://127.0.0.1:${PORTS.NEXUS_BROWSER_PORT}/diagnostics`, { timeoutMs: 2500 });
  return {
    timestamp: new Date().toISOString(),
    head: gitHead(),
    control,
    services,
    tlo: await tloStatus(),
    localMoe: localMoe.payload,
    nexus: nexus.payload,
    listeners: portListeners(),
    session: readSession(),
    logs: collectLogTails(),
    ...extra,
  };
}

function gitHead() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  return String(result.stdout || '').trim();
}

export function writeSnapshot(snapshot, label = 'search-monitor-runtime') {
  fs.mkdirSync(RESULT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(RESULT_DIR, `${label}-${stamp}.json`);
  const last = path.join(RESULT_DIR, 'LAST-SEARCH-MONITOR-RUNTIME.json');
  const content = JSON.stringify(snapshot, null, 2) + '\n';
  fs.writeFileSync(target, content, 'utf8');
  fs.writeFileSync(last, content, 'utf8');
  return {
    json: path.relative(ROOT, target).replace(/\\/g, '/'),
    last: path.relative(ROOT, last).replace(/\\/g, '/'),
  };
}
