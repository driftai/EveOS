'use strict';

const conversation = require('./chatgpt-windows-conversation');
const replyProgress = require('./chatgpt-windows-reply-progress');
const timeoutRecovery = require('./chatgpt-windows-timeout-recovery');
const {
  authoritativePartial,
  currentTurnComplete,
  monotonicPartial,
  shouldRunOffscreenRescue
} = require('./chatgpt-windows-stability');
const { normalizeCandidate } = require('./chatgpt-windows-uia');

function createPromptSender({
  probeControls,
  stageAndSubmit,
  inspect,
  busyRecoveryController,
  turnState,
  sleepFn,
  now,
  firstPollMs,
  pollMs,
  settleMs,
  postGenerationSettleMs,
  shortReplySettleMs,
  firstResponseRescueAfterMs,
  firstResponseRescueIntervalMs,
  firstResponseRescueMaxAttempts,
  responseTimeoutMs,
  providerId,
  providerName
}) {
  return async function sendPrompt({ requestId, text, target, emit, transportTiming = {} }) {
    const dispatchWallStartedAt = Date.now();
    const dispatchStartedAt = now();
    const baselineStartedAt = Date.now();
    const baseline = await probeControls({
      hwnd: target.windowHandle,
      pid: target.pid,
      title: target.title
    }, { recoverComposer: true, recoverSend: false });
    const baselineInspectMs = Math.max(0, Date.now() - baselineStartedAt);
    const baselineSet = new Set(baseline.texts.map(normalizeCandidate));
    const submitted = await stageAndSubmit(text, baseline);
    const committedSnapshot = submitted.snapshot;
    const acceptedAt = now(), dispatchToAppMs = Math.max(0, acceptedAt - dispatchStartedAt);
    const dispatchTiming = {
      ...transportTiming,
      serverToAdapterMs: Number.isFinite(Number(transportTiming.serverReceivedAt))
        ? Math.max(0, dispatchWallStartedAt - Number(transportTiming.serverReceivedAt)) : 0,
      baselineInspectMs,
      ...submitted.timing,
      dispatchToAppMs
    };
    emit?.({ type: 'prompt_accepted', requestId, targetClassId: 'app-origin',
      targetId: target.id, providerId, providerName,
      observedAt: acceptedAt, detail: dispatchTiming });
    const deadline = acceptedAt + responseTimeoutMs;
    let lastText = '', publishedText = '', lastChangedAt = acceptedAt;
    let firstResponseAt = 0, lastSnapshot = null, nativeTurn = null, progressState = 'replace';
    let sawGenerating = false, firstPoll = true, pollCount = 0;
    let committedPending = true, tailStablePasses = 0, hasFreshVisiblePoll = false;
    let pollInspectMs = 0, finalReconstructionMs = 0, firstResponseRescueInspectMs = 0;
    let firstResponseRescueAttempts = 0, rescueAttemptsSinceProgress = 0;
    let visiblePollsSinceProgress = 0, lastFirstResponseRescueAt = 0;
    let finalized = false;
    turnState.set(target.id, { phase: 'waiting', requestId, startedAt: acceptedAt, latestText: '' });
    busyRecoveryController.start({ target, requestId, prompt: text, baseline: baselineSet, acceptedAt });

    function finalizeResponse({
      text: finalText,
      snapshot: finalSnapshot,
      nativeTurn: finalNativeTurn = nativeTurn,
      completenessHint = 'settled',
      adapterSettleMs = Math.max(0, now() - lastChangedAt),
      extraTiming = {}
    }) {
      if (finalized) return { text: finalText, snapshot: finalSnapshot, nativeTurn: finalNativeTurn };
      finalized = true;
      const finalizedAt = now();
      if (!firstResponseAt && finalText) firstResponseAt = finalizedAt;
      lastText = finalText || lastText;
      lastSnapshot = finalSnapshot || lastSnapshot;
      nativeTurn = finalNativeTurn || nativeTurn;
      const timing = {
        ...dispatchTiming,
        timeToFirstResponseMs: firstResponseAt ? Math.max(0, firstResponseAt - acceptedAt) : null,
        totalResponseMs: Math.max(0, finalizedAt - acceptedAt),
        nexusRoundTripMs: Math.max(0, finalizedAt - dispatchStartedAt),
        adapterSettleMs,
        pollInspectMs,
        finalReconstructionMs,
        pollCount,
        sawGenerating,
        firstResponseRescueAttempts,
        firstResponseRescueInspectMs,
        ...extraTiming
      };
      turnState.set(target.id, { phase: 'idle', requestId, latestText: lastText,
        completedAt: finalizedAt, sawGenerating, timing });
      emit?.({
        type: 'response_final', requestId, text: lastText, observedAt: finalizedAt,
        completenessHint,
        detail: timing,
        targetClassId: 'app-origin', targetId: target.id,
        providerId, providerName
      });
      return { text: lastText, snapshot: lastSnapshot, nativeTurn };
    }

    try {
      while (now() < deadline) {
        const forced = busyRecoveryController.forcedFinal(target.id, requestId);
        if (forced) {
          if (!firstResponseAt) firstResponseAt = forced.observedAt || now();
          return finalizeResponse({
            text: forced.text,
            snapshot: forced.snapshot,
            nativeTurn: forced.nativeTurn,
            completenessHint: forced.completenessHint || 'busy-recovered',
            extraTiming: { busyRecoveryProbeMs: Number(forced.probeMs || 0), busyRecovered: true }
          });
        }

        if (committedPending) { lastSnapshot = committedSnapshot; committedPending = false; }
        else {
          await sleepFn(firstPoll ? firstPollMs : pollMs); firstPoll = false;
          const pollInspectStartedAt = Date.now();
          lastSnapshot = await inspect({
            hwnd: target.windowHandle, pid: target.pid, title: target.title
          });
          hasFreshVisiblePoll = true;
          visiblePollsSinceProgress += 1;
          pollInspectMs += Math.max(0, Date.now() - pollInspectStartedAt);
        }
        pollCount += 1;
        let observedAt = now();
        if (lastSnapshot.generating) sawGenerating = true;
        let observed = conversation.responseForPrompt(lastSnapshot, { baseline: baselineSet, prompt: text });
        const visibleCandidate = observed.text;
        if (visibleCandidate && visibleCandidate !== lastText) {
          rescueAttemptsSinceProgress = 0;
          visiblePollsSinceProgress = 0;
        }

        const rescueDue = hasFreshVisiblePoll && shouldRunOffscreenRescue({
          observed,
          candidate: visibleCandidate,
          lastText,
          observedAt,
          acceptedAt,
          lastChangedAt,
          attemptsSinceProgress: rescueAttemptsSinceProgress,
          visiblePollsSinceProgress,
          lastRescueAt: lastFirstResponseRescueAt,
          rescueAfterMs: firstResponseRescueAfterMs,
          rescueIntervalMs: firstResponseRescueIntervalMs,
          rescueMaxAttempts: firstResponseRescueMaxAttempts
        });
        if (rescueDue) {
          firstResponseRescueAttempts += 1;
          rescueAttemptsSinceProgress += 1;
          lastFirstResponseRescueAt = observedAt;
          const rescueStartedAt = Date.now();
          try {
            const rescueSnapshot = await inspect({
              hwnd: target.windowHandle, pid: target.pid, title: target.title
            }, { includeOffscreen: true, depth: 32 });
            const rescued = conversation.responseForPrompt(rescueSnapshot, {
              baseline: baselineSet, prompt: text, includeOffscreen: true
            });
            if (rescued.text || rescued.nativeTurn || rescued.correlated) {
              lastSnapshot = rescueSnapshot;
              observed = rescued;
              observedAt = now();
              if (lastSnapshot.generating) sawGenerating = true;
            }
          } catch {} finally {
            firstResponseRescueInspectMs += Math.max(0, Date.now() - rescueStartedAt);
          }
        }

        const candidate = observed.text;
        if (observed.nativeTurn) nativeTurn = observed.nativeTurn;
        progressState = replyProgress.transitionProgressMode(progressState, observed);
        const mergedText = progressState === 'native' ? lastText : progressState === 'accumulate'
          ? replyProgress.mergeReplyProgress(lastText, candidate) : (candidate || lastText);
        if (candidate && mergedText !== lastText) {
          lastText = mergedText; tailStablePasses = 0;
          rescueAttemptsSinceProgress = 0; visiblePollsSinceProgress = 0;
          if (!firstResponseAt) firstResponseAt = observedAt;
          lastChangedAt = observedAt;
          busyRecoveryController.progress(target.id, requestId, mergedText, observedAt);
          turnState.set(target.id, { phase: 'streaming', requestId, startedAt: acceptedAt,
            latestText: mergedText, sawGenerating });
          const publishable = monotonicPartial(publishedText, mergedText);
          if (publishable !== publishedText) {
            publishedText = publishable;
            emit?.({ type: 'response_partial', requestId, text: publishedText,
              targetClassId: 'app-origin', targetId: target.id,
              providerId, providerName });
          }
        }
        if (observed.provisional) { lastChangedAt = observedAt; continue; }
        const stableFor = observedAt - lastChangedAt;
        const baseSettle = sawGenerating ? postGenerationSettleMs : settleMs;
        const requiredSettle = progressState === 'role' && !observed.nativeTurn?.completeHint
          ? Math.max(baseSettle, 5000)
          : progressState === 'accumulate' && replyProgress.needsTailGuard(lastText)
            ? Math.max(baseSettle, 2500)
            : lastText.length < 32 ? Math.max(baseSettle, shortReplySettleMs) : baseSettle;
        const turnOwnedComplete = currentTurnComplete(observed);
        if (lastText && (!lastSnapshot.generating || turnOwnedComplete)
            && (turnOwnedComplete || (requiredSettle > 0 ? stableFor >= requiredSettle : stableFor > 0))) {
          const reconstructionStartedAt = Date.now();
          try {
            const fullSnapshot = await inspect({
              hwnd: target.windowHandle, pid: target.pid, title: target.title
            }, { includeOffscreen: true, depth: 32 });
            const full = conversation.responseForPrompt(fullSnapshot, {
              baseline: baselineSet, prompt: text, includeOffscreen: true
            });
            if (full.correlated && !full.nativeTurn) {
              lastSnapshot = fullSnapshot; lastChangedAt = now(); continue;
            }
            nativeTurn = full.nativeTurn || nativeTurn;
            progressState = replyProgress.transitionProgressMode(progressState, full);
            const fullText = full.nativeTurn?.text || full.text;
            const reconstructed = full.progressMode === 'accumulate'
              ? (full.nativeTurn
                ? replyProgress.preferOffscreenTurn(lastText, full.nativeTurn)
                : replyProgress.preferFinalReply(lastText, fullText))
              : full.nativeTurn?.completeHint ? fullText
                : observed.nativeTurn?.completeHint
                  ? conversation.preferExpandedReply(lastText, fullText)
                  : fullText || conversation.preferExpandedReply(lastText, full.text);
            lastSnapshot = fullSnapshot;
            if (full.progressMode === 'accumulate' && full.nativeTurn?.text
                && reconstructed === full.nativeTurn.text && !replyProgress.needsTailGuard(reconstructed)) {
              progressState = 'native';
            }
            if (reconstructed && reconstructed !== lastText) {
              lastText = reconstructed; lastChangedAt = now(); tailStablePasses = 0;
              busyRecoveryController.progress(target.id, requestId, lastText, lastChangedAt);
              const publishable = authoritativePartial(publishedText, lastText, full);
              if (publishable !== publishedText) {
                publishedText = publishable;
                emit?.({ type: 'response_partial', requestId, text: publishedText,
                  targetClassId: 'app-origin', targetId: target.id,
                  providerId, providerName });
              }
              if (full.progressMode === 'accumulate') continue;
            }
            if (!(observed.nativeTurn?.completeHint || full.nativeTurn?.completeHint)
                && replyProgress.needsCompletionGuard(lastText, progressState)
                && ++tailStablePasses < 3) continue;
          } catch {} finally {
            finalReconstructionMs += Math.max(0, Date.now() - reconstructionStartedAt);
          }
          return finalizeResponse({
            text: lastText,
            snapshot: lastSnapshot,
            nativeTurn,
            completenessHint: turnOwnedComplete ? 'turn-complete'
              : sawGenerating ? 'generation-ended' : 'settled',
            adapterSettleMs: stableFor
          });
        }
      }
      const recoveryStartedAt = Date.now();
      const recovered = await timeoutRecovery.recoverAuthoritativeReply({
        inspect, target, baseline: baselineSet, prompt: text
      });
      finalReconstructionMs += Math.max(0, Date.now() - recoveryStartedAt);
      if (recovered) {
        if (!firstResponseAt) firstResponseAt = now();
        return finalizeResponse({
          text: recovered.text,
          snapshot: recovered.snapshot,
          nativeTurn: recovered.nativeTurn,
          completenessHint: 'timeout-recovered',
          extraTiming: { timeoutRecovered: true }
        });
      }
      const error = new Error('Timed out waiting for a stable ChatGPT app reply.');
      error.code = 'APP_RESPONSE_TIMEOUT';
      turnState.set(target.id, { phase: 'error', requestId, latestText: lastText,
        error: error.message, at: now() });
      throw error;
    } catch (error) {
      if (turnState.get(target.id)?.phase !== 'idle') {
        turnState.set(target.id, { phase: 'error', requestId, latestText: lastText,
          error: error.message, at: now() });
      }
      throw error;
    } finally {
      busyRecoveryController.finish(target.id, requestId);
    }
  };
}

module.exports = { createPromptSender };
