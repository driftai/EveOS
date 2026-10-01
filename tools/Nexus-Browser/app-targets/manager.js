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
const activeSends = new Set();
const appTurnListeners = new Set();

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
  if (listInFlight) {
    const targets = await listInFlight;
    return targets.map((target) => ({ ...target }));
  }
  if (!force && cachedTargets && now - cachedAt < CACHE_MS) {
    return cachedTargets.map((target) => ({ ...target }));
  }
  listInFlight = (async () => {
    const targets = [];
    for (const adapter of adapters) {
      try { targets.push(...await adapterTargets(adapter)); }
      catch {}
    }
    cachedTargets = targets;
    cachedAt = Date.now();
    return targets;
  })();
  try {
    const targets = await listInFlight;
    return targets.map((target) => ({ ...target }));
  } finally {
    listInFlight = null;
  }
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

function appConversationMatches(expected = {}, actual = {}) {
  const titleMatches = !!expected.conversationTitle
    && String(expected.conversationTitle) === String(actual.conversationTitle || '');
  if (expected.conversationAnchor) {
    const anchors = Array.isArray(actual.conversationAnchors)
      ? actual.conversationAnchors.map(String)
      : actual.conversationAnchor ? [String(actual.conversationAnchor)] : [];
    if (anchors.includes(String(expected.conversationAnchor))) return true;
    if (anchors.length) return false;
    return titleMatches;
  }
  return titleMatches;
}

function exactAppTargetMatch(expected = {}, actual = {}) {
  if (!expected?.id || String(expected.id) !== String(actual?.id || '')
      || expected.providerId !== actual?.providerId) return false;
  const bound = expected.concreteTargetIdentity || {}, live = actual.concreteTargetIdentity || {};
  if (bound.processId && String(bound.processId) !== String(live.processId || '')) return false;
  if (bound.windowHandle && String(bound.windowHandle) !== String(live.windowHandle || '')) return false;
  if (expected.providerId === 'chatgpt-desktop') {
    if (!bound.conversationAnchor && !bound.conversationTitle) return false;
    if (!appConversationMatches(bound, live)) return false;
  }
  return true;
}

function onAppTurnFinal(listener) {
  if (typeof listener !== 'function') return () => {};
  appTurnListeners.add(listener);
  return () => appTurnListeners.delete(listener);
}

function notifyObservedTurn(target, adapter, result, source) {
  const turn = adapter?.completedTurns?.(result?.snapshot)?.at(-1);
  if (!turn?.fingerprint) return null;
  const event = { target, turn, source, observedAt: Date.now() };
  for (const listener of appTurnListeners) {
    try { Promise.resolve(listener(event)).catch(() => {}); } catch {}
  }
  return turn;
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
  notifyObservedTurn(target, adapter, result, 'capture');
  return { ...result, target };
}

async function sendAppPrompt({ targetId, requestId, text, emit, beforeSend = null }) {
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
  if (activeSends.has(target.id)) {
    const error = new Error('That App-Origin target is already handling another prompt.');
    error.code = 'APP_TARGET_BUSY';
    throw error;
  }
  activeSends.add(target.id);
  try {
    if (typeof beforeSend === 'function') await beforeSend(target);
    const result = await adapter.sendPrompt({ requestId, text, target, emit });
    notifyObservedTurn(target, adapter, result, 'active');
    return result;
  } finally {
    activeSends.delete(target.id);
  }
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

function appTargetBusy(targetId) {
  return activeSends.has(String(targetId || ''));
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
  exactAppTargetMatch,
  onAppTurnFinal,
  captureAppLatest,
  sendAppPrompt,
  discoveryDiagnostics,
  invalidateAppTargetCache,
  stopAppTargets,
  appTargetBusy
};
