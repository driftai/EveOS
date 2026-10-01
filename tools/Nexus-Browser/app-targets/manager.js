'use strict';

const chatgptWindows = require('./chatgpt-windows');

const TARGET_CLASSES = [
  { id: 'app-origin', name: 'App-Origin Targets' }
];

const APP_TARGET_TYPES = [
  {
    id: 'desktop-app',
    name: 'Desktop App',
    description: 'Running desktop applications bridged through Windows UI Automation.'
  }
];

const adapters = [chatgptWindows];
const CACHE_MS = Number(process.env.NEXUS_BROWSER_APP_TARGET_CACHE_MS
  || process.env.BROWSER_AI_BRIDGE_APP_TARGET_CACHE_MS
  || 800);
let cachedTargets = null;
let cachedAt = 0;
let listInFlight = null;

function normalizeAppTarget(target = {}) {
  const pid = Number(target.pid || 0) || null;
  return {
    ...target,
    targetClassId: 'app-origin',
    targetTypeId: target.targetTypeId || 'desktop-app',
    targetTypeName: target.targetTypeName || 'Desktop App',
    transport: target.transport || 'windows-uia',
    sessionOrigin: target.sessionOrigin || 'existing-app',
    concreteTargetIdentity: target.concreteTargetIdentity || {
      kind: 'windows-app-window',
      targetId: String(target.id || ''),
      ...(pid ? { processId: pid } : {}),
      ...(target.windowHandle ? { windowHandle: target.windowHandle } : {})
    },
    capabilities: {
      chat: true,
      captureLatest: true,
      ...(target.capabilities || {})
    }
  };
}

function publicTargetClasses() {
  return TARGET_CLASSES.map((entry) => ({ ...entry }));
}

function publicAppTargetTypes() {
  return APP_TARGET_TYPES.map((entry) => ({ ...entry }));
}

async function adapterTargets(adapter) {
  if (typeof adapter.listTargets !== 'function') return [];
  const targets = await adapter.listTargets();
  return Array.isArray(targets) ? targets.filter(Boolean).map(normalizeAppTarget) : [];
}

async function listAppTargets({ force = false, now = Date.now() } = {}) {
  if (!force && cachedTargets && now - cachedAt < CACHE_MS) {
    return cachedTargets.map((target) => ({ ...target }));
  }
  if (!force && listInFlight) return listInFlight;
  listInFlight = (async () => {
    const targets = [];
    for (const adapter of adapters) {
      try { targets.push(...await adapterTargets(adapter)); }
      catch {}
    }
    cachedTargets = targets;
    cachedAt = Date.now();
    return targets.map((target) => ({ ...target }));
  })().finally(() => { listInFlight = null; });
  return listInFlight;
}

async function getAppTarget(targetId, { force = false } = {}) {
  const targets = await listAppTargets({ force });
  return targets.find((target) => target.id === targetId) || null;
}

function adapterForTarget(targetId) {
  return adapters.find((adapter) => {
    try { return adapter.TARGET_ID === targetId || adapter.ownsTarget?.(targetId); }
    catch { return false; }
  }) || null;
}

function getAppTargetStatus(targetId) {
  const adapter = adapterForTarget(targetId);
  try { return adapter?.status?.(targetId) || null; }
  catch { return null; }
}

async function captureAppLatest({ targetId }) {
  if (!targetId) {
    const error = new Error('No App-Origin target is selected.');
    error.code = 'APP_TARGET_NOT_SELECTED';
    throw error;
  }
  const target = await getAppTarget(targetId, { force: true });
  if (!target) {
    const error = new Error('Selected App-Origin target is no longer available.');
    error.code = 'APP_TARGET_NOT_FOUND';
    throw error;
  }
  const adapter = adapterForTarget(target.id);
  if (!adapter?.captureLatest) {
    const error = new Error('App target adapter does not support latest-reply capture.');
    error.code = 'APP_CAPTURE_UNSUPPORTED';
    throw error;
  }
  const result = await adapter.captureLatest({ target });
  return { ...result, target };
}

async function sendAppPrompt({ targetId, requestId, text, emit }) {
  if (!targetId) {
    const error = new Error('No App-Origin target is selected.');
    error.code = 'APP_TARGET_NOT_SELECTED';
    throw error;
  }
  const target = await getAppTarget(targetId, { force: true });
  if (!target) {
    const error = new Error('Selected App-Origin target is no longer available.');
    error.code = 'APP_TARGET_NOT_FOUND';
    throw error;
  }
  const adapter = adapterForTarget(target.id);
  if (!adapter?.sendPrompt) {
    const error = new Error('App target adapter cannot send prompts.');
    error.code = 'APP_SEND_UNSUPPORTED';
    throw error;
  }
  return adapter.sendPrompt({ requestId, text, target, emit });
}

function discoveryDiagnostics() {
  const result = {};
  for (const adapter of adapters) {
    const name = adapter.PROVIDER_ID || adapter.TARGET_ID || 'app';
    try { result[name] = adapter.diagnostics?.() || null; }
    catch (error) { result[name] = { available: false, lastError: error.message }; }
  }
  return result;
}

function invalidateAppTargetCache() {
  cachedTargets = null;
  cachedAt = 0;
}

function stopAppTargets() {
  invalidateAppTargetCache();
  for (const adapter of adapters) {
    try { adapter.stop?.(); } catch {}
  }
}

module.exports = {
  TARGET_CLASSES,
  APP_TARGET_TYPES,
  publicTargetClasses,
  publicAppTargetTypes,
  normalizeAppTarget,
  listAppTargets,
  getAppTarget,
  adapterForTarget,
  getAppTargetStatus,
  captureAppLatest,
  sendAppPrompt,
  discoveryDiagnostics,
  invalidateAppTargetCache,
  stopAppTargets
};
