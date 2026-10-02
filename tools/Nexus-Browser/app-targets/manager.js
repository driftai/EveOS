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
const sendFailures = new Map();
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

function cloneTargets(targets = []) {
  return targets.map((target) => ({ ...target }));
}

async function listAppTargets({ force = false, now = Date.now() } = {}) {
  if (listInFlight) return cloneTargets(await listInFlight);
  if (activeSends.size && cachedTargets) return cloneTargets(cachedTargets);
  if (!force && cachedTargets && now - cachedAt < CACHE_MS) return cloneTargets(cachedTargets);
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
    return cloneTargets(await listInFlight);
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
  let status = null;
  try { status = adapter?.status?.(targetId) || null; }
  catch { status = null; }
  const failure = sendFailures.get(String(targetId || ''));
  if (!failure || activeSends.has(String(targetId || ''))) return status;
  return {
    ...(status || {}),
    ...failure,
    diagnostics: status?.diagnostics || null
  };
}

function conversationAnchors(identity = {}) {
  return [...new Set([
    ...(Array.isArray(identity.conversationAnchors) ? identity.conversationAnchors : []),
    identity.conversationAnchor
  ].filter(Boolean).map(String))];
}

function reliableConversationTitle(value = '') {
  const title = String(value || '').trim();
  if (title.length < 4 || title.length > 120) return false;
  if (/^(?:worked|working)\s+for\b/i.test(title)) return false;
  if (/^(?:chatgpt\s+is\s+responding|responding|generating)(?:\.{3}|…)?$/i.test(title)) return false;
  if (/^,\s*expected\s*=*\s*$/i.test(title)) return false;
  return !/^(?:chatgpt|codex|chat|work|new chat|minimize|maximize|restore(?: down)?|close(?: window)?|fullscreen|full screen|enter full screen|exit full screen|(?:show|hide|open|close|toggle) sidebar)$/i.test(title);
}

function appConversationMatches(expected = {}, actual = {}) {
  const expectedTitle = String(expected.conversationTitle || '').trim();
  const actualTitle = String(actual.conversationTitle || '').trim();
  const titleMatches = reliableConversationTitle(expectedTitle) && expectedTitle === actualTitle;
  const expectedAnchors = conversationAnchors(expected);
  const actualAnchors = conversationAnchors(actual);
  if (expectedAnchors.length) {
    if (actualAnchors.length) {
      const live = new Set(actualAnchors);
      if (expectedAnchors.some((anchor) => live.has(anchor))) return true;
      return titleMatches;
    }
    return titleMatches;
  }
  return titleMatches;
}

function advanceAppTargetBinding(expected = {}, actual = {}) {
  if (!exactAppTargetMatch(expected, actual)) return null;
  const bound = expected.concreteTargetIdentity || {};
  const live = actual.concreteTargetIdentity || {};
  const anchors = [...new Set([
    ...conversationAnchors(bound),
    ...conversationAnchors(live)
  ])].slice(-16);
  const liveTitle = reliableConversationTitle(live.conversationTitle) ? live.conversationTitle : '';
  const boundTitle = reliableConversationTitle(bound.conversationTitle) ? bound.conversationTitle : '';
  const concreteTargetIdentity = {
    ...bound,
    ...((liveTitle || boundTitle) ? { conversationTitle: liveTitle || boundTitle } : {}),
    ...(anchors.length ? {
      conversationAnchor: anchors.at(-1),
      conversationAnchors: anchors
    } : {})
  };
  return { ...expected, concreteTargetIdentity };
}

function exactAppTargetMatch(expected = {}, actual = {}) {
  if (!expected?.id || String(expected.id) !== String(actual?.id || '')
      || expected.providerId !== actual?.providerId) return false;
  const bound = expected.concreteTargetIdentity || {};
  const live = actual.concreteTargetIdentity || {};
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
  const turn = result?.nativeTurn
    || (source === 'capture' ? adapter?.completedTurns?.(result?.snapshot)?.at(-1) : null);
  if (!turn?.fingerprint) return null;
  const event = { target, turn, source, observedAt: Date.now() };
  for (const listener of appTurnListeners) {
    try { Promise.resolve(listener(event)).catch(() => {}); } catch {}
  }
  return turn;
}

function busyError() {
  const error = new Error('That App-Origin target is already handling another prompt.');
  error.code = 'APP_TARGET_BUSY';
  return error;
}

async function captureAppLatest({ targetId }) {
  if (!targetId) {
    const error = new Error('No App-Origin target is selected.');
    error.code = 'APP_TARGET_NOT_SELECTED';
    throw error;
  }
  if (activeSends.has(String(targetId))) throw busyError();
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
  sendFailures.delete(target.id);
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
  if (activeSends.has(target.id)) throw busyError();
  sendFailures.delete(target.id);
  activeSends.add(target.id);
  try {
    if (typeof beforeSend === 'function') await beforeSend(target);
    const result = await adapter.sendPrompt({ requestId, text, target, emit });
    sendFailures.delete(target.id);
    notifyObservedTurn(target, adapter, result, 'active');
    return result;
  } catch (error) {
    sendFailures.set(target.id, {
      phase: 'error',
      requestId: requestId || null,
      code: error.code || 'APP_TARGET_ERROR',
      error: error.message,
      at: Date.now()
    });
    throw error;
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
  sendFailures.clear();
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
  advanceAppTargetBinding,
  reliableConversationTitle,
  onAppTurnFinal,
  captureAppLatest,
  sendAppPrompt,
  discoveryDiagnostics,
  invalidateAppTargetCache,
  stopAppTargets,
  appTargetBusy
};
