'use strict';

const conversation = require('./chatgpt-windows-conversation');
const replyProgress = require('./chatgpt-windows-reply-progress');
const { currentTurnComplete } = require('./chatgpt-windows-stability');

const BUSY_RECOVERY_SETTLE_MS = 700;
const BUSY_RECOVERY_CONFIRM_MS = 300;

function busyRecoveryObservation(snapshot = {}, observed = {}, previousText = '') {
  const text = String(observed.nativeTurn?.text || observed.text || '').trim();
  if (!observed.correlated || !observed.nativeTurn || !text) {
    return { eligible: false, authoritative: false, reason: 'uncorrelated', text: '' };
  }
  if (observed.provisional || observed.activityHint) {
    return { eligible: false, authoritative: false, reason: 'activity', text };
  }

  const authoritative = currentTurnComplete(observed);
  if (!authoritative && (snapshot.generating || observed.generating)) {
    return { eligible: false, authoritative: false, reason: 'generating', text };
  }

  const previous = String(previousText || '').trim();
  if (previous) {
    const preferred = replyProgress.preferFinalReply(previous, text);
    if (preferred !== text && !replyProgress.looselyContains(text, previous)) {
      return { eligible: false, authoritative, reason: 'regressed', text };
    }
  }

  return {
    eligible: true,
    authoritative,
    reason: authoritative ? 'turn-complete' : 'native-idle',
    text,
    nativeTurn: observed.nativeTurn
  };
}

function createBusyRecoveryController({
  inspect,
  sleepFn,
  now = () => Date.now(),
  settleMs = BUSY_RECOVERY_SETTLE_MS,
  confirmMs = BUSY_RECOVERY_CONFIRM_MS
} = {}) {
  const active = new Map();

  function start({ target, requestId, prompt, baseline, acceptedAt = now() }) {
    const targetId = String(target?.id || '');
    if (!targetId || !requestId) return null;
    const context = {
      target: {
        id: targetId,
        pid: target.pid,
        windowHandle: target.windowHandle,
        title: target.title
      },
      requestId: String(requestId),
      prompt: String(prompt || ''),
      baseline,
      acceptedAt,
      lastText: '',
      lastChangedAt: acceptedAt,
      forcedFinal: null,
      recoveryInFlight: null
    };
    active.set(targetId, context);
    return context;
  }

  function progress(targetId, requestId, text, changedAt = now()) {
    const context = active.get(String(targetId || ''));
    if (!context || String(context.requestId) !== String(requestId || '')) return false;
    const next = String(text || '');
    if (next && next !== context.lastText) {
      context.lastText = next;
      context.lastChangedAt = changedAt;
    }
    return true;
  }

  function forcedFinal(targetId, requestId) {
    const context = active.get(String(targetId || ''));
    if (!context || String(context.requestId) !== String(requestId || '')) return null;
    return context.forcedFinal;
  }

  function finish(targetId, requestId) {
    const key = String(targetId || '');
    const context = active.get(key);
    if (!context || (requestId && String(context.requestId) !== String(requestId))) return false;
    active.delete(key);
    return true;
  }

  async function probe({ target, requestId }) {
    const targetId = String(target?.id || '');
    const context = active.get(targetId);
    if (!context) return { recovered: false, requestId: requestId || null, reason: 'not-active' };
    if (requestId && String(context.requestId) !== String(requestId)) {
      return { recovered: false, requestId: context.requestId, reason: 'request-mismatch' };
    }
    if (String(context.target.pid) !== String(target?.pid)
        || String(context.target.windowHandle) !== String(target?.windowHandle)) {
      return { recovered: false, requestId: context.requestId, reason: 'target-mismatch' };
    }
    if (context.forcedFinal) {
      return { recovered: true, requestId: context.requestId, reason: 'already-recovered' };
    }
    if (context.recoveryInFlight) return context.recoveryInFlight;

    const recoveryStartedAt = now();
    context.recoveryInFlight = (async () => {
      const boundWindow = {
        hwnd: context.target.windowHandle,
        pid: context.target.pid,
        title: context.target.title
      };
      const read = async () => {
        const snapshot = await inspect(boundWindow, { includeOffscreen: true, depth: 32 });
        if (String(snapshot.hwnd) !== String(context.target.windowHandle)
            || String(snapshot.pid) !== String(context.target.pid)) {
          return { assessment: { eligible: false, reason: 'target-mismatch' }, snapshot, observed: null };
        }
        const observed = conversation.responseForPrompt(snapshot, {
          baseline: context.baseline,
          prompt: context.prompt,
          includeOffscreen: true
        });
        return {
          assessment: busyRecoveryObservation(snapshot, observed, context.lastText),
          snapshot,
          observed
        };
      };
      const arm = (sample, reason) => {
        const observedAt = now();
        context.forcedFinal = {
          text: sample.assessment.text,
          snapshot: sample.snapshot,
          nativeTurn: sample.observed?.nativeTurn || sample.assessment.nativeTurn || null,
          observedAt,
          completenessHint: reason,
          probeMs: Math.max(0, observedAt - recoveryStartedAt)
        };
        return { recovered: true, requestId: context.requestId, reason };
      };

      const first = await read();
      if (!first.assessment.eligible) {
        return { recovered: false, requestId: context.requestId, reason: first.assessment.reason || 'not-complete' };
      }
      if (first.assessment.authoritative) return arm(first, 'busy-recovered-complete');
      if (now() - context.lastChangedAt < settleMs) {
        return { recovered: false, requestId: context.requestId, reason: 'not-stable-yet' };
      }

      await sleepFn(confirmMs);
      const second = await read();
      if (!second.assessment.eligible) {
        return { recovered: false, requestId: context.requestId, reason: second.assessment.reason || 'not-complete' };
      }
      if (replyProgress.flat(first.assessment.text) !== replyProgress.flat(second.assessment.text)) {
        return { recovered: false, requestId: context.requestId, reason: 'still-changing' };
      }
      return arm(second, second.assessment.authoritative
        ? 'busy-recovered-complete' : 'busy-recovered-stable');
    })();

    try {
      return await context.recoveryInFlight;
    } finally {
      context.recoveryInFlight = null;
    }
  }

  return { start, progress, forcedFinal, finish, probe };
}

module.exports = {
  BUSY_RECOVERY_SETTLE_MS,
  BUSY_RECOVERY_CONFIRM_MS,
  busyRecoveryObservation,
  createBusyRecoveryController
};
