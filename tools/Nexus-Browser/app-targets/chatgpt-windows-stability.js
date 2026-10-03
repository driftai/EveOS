'use strict';

const replyProgress = require('./chatgpt-windows-reply-progress');

const FIRST_RESPONSE_RESCUE_AFTER_MS = 700;
const FIRST_RESPONSE_RESCUE_INTERVAL_MS = 1500;
const FIRST_RESPONSE_RESCUE_MAX_ATTEMPTS = 3;

function monotonicPartial(previous = '', candidate = '') {
  const prior = String(previous || '');
  const next = String(candidate || '');
  if (!next || next === prior) return prior;
  if (!prior) return next;
  const merged = replyProgress.mergeReplyProgress(prior, next);
  return merged && merged.startsWith(prior) ? merged : prior;
}

function currentTurnComplete(observed = {}) {
  return observed.correlated === true && !!observed.nativeTurn?.completeHint && !observed.provisional;
}

function authoritativePartial(previous = '', candidate = '', observed = {}) {
  const next = String(candidate || '');
  return currentTurnComplete(observed) && next ? next : monotonicPartial(previous, next);
}

function targetIdentityMatches(previous = {}, identity = {}) {
  const bound = previous.concreteTargetIdentity || {};
  const boundTitle = String(bound.conversationTitle || '').trim();
  const liveTitle = String(identity.conversationTitle || '').trim();
  const boundAnchors = new Set([
    ...(Array.isArray(bound.conversationAnchors) ? bound.conversationAnchors : []),
    bound.conversationAnchor
  ].filter(Boolean).map(String));
  const liveAnchors = [
    ...(Array.isArray(identity.conversationAnchors) ? identity.conversationAnchors : []),
    identity.conversationAnchor
  ].filter(Boolean).map(String);
  return liveAnchors.some((anchor) => boundAnchors.has(anchor))
    || (!!boundTitle && boundTitle === liveTitle);
}

function shouldRunOffscreenRescue({
  observed = {}, candidate = '', lastText = '', observedAt = 0, acceptedAt = 0,
  lastChangedAt = 0, attemptsSinceProgress = 0, visiblePollsSinceProgress = 0, lastRescueAt = 0,
  rescueAfterMs = FIRST_RESPONSE_RESCUE_AFTER_MS,
  rescueIntervalMs = FIRST_RESPONSE_RESCUE_INTERVAL_MS,
  rescueMaxAttempts = FIRST_RESPONSE_RESCUE_MAX_ATTEMPTS
} = {}) {
  if (currentTurnComplete(observed)) return false;
  if (candidate && candidate !== lastText) return false;
  if (visiblePollsSinceProgress < 2) return false;
  const stalledSince = Math.max(Number(acceptedAt) || 0, Number(lastChangedAt) || 0);
  if ((Number(observedAt) || 0) - stalledSince < rescueAfterMs) return false;
  if (attemptsSinceProgress >= rescueMaxAttempts) return false;
  return !lastRescueAt || (Number(observedAt) || 0) - Number(lastRescueAt) >= rescueIntervalMs;
}

async function verifyCachedTarget({ cachedTarget, inspect, conversationIdentity, targetFromIdentity }) {
  if (!cachedTarget) return null;
  try {
    const boundWindow = {
      hwnd: cachedTarget.windowHandle,
      pid: cachedTarget.pid,
      title: cachedTarget.title
    };
    // Conversation anchors rotate as new turns push the previously visible pair
    // above the viewport. Keep verification scoped to the exact bound HWND, but
    // include its offscreen tree so continuity can be proven without falling back
    // to global window discovery after every successful turn.
    const snapshot = await inspect(boundWindow, { includeOffscreen: true, depth: 12 });
    const sameWindow = String(snapshot.hwnd) === String(cachedTarget.windowHandle)
      && String(snapshot.pid) === String(cachedTarget.pid);
    const identity = conversationIdentity(snapshot);
    if (!sameWindow || !targetIdentityMatches(cachedTarget, identity)) return null;
    return targetFromIdentity(snapshot.windowInfo || boundWindow, identity);
  } catch {
    return null;
  }
}

module.exports = {
  FIRST_RESPONSE_RESCUE_AFTER_MS,
  FIRST_RESPONSE_RESCUE_INTERVAL_MS,
  FIRST_RESPONSE_RESCUE_MAX_ATTEMPTS,
  monotonicPartial,
  authoritativePartial,
  currentTurnComplete,
  targetIdentityMatches,
  shouldRunOffscreenRescue,
  verifyCachedTarget
};
