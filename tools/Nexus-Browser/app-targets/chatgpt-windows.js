'use strict';
const defaultRunner = require('./winapp-runner'), uia = require('./chatgpt-windows-uia'),
  conversation = require('./chatgpt-windows-conversation'), replyProgress = require('./chatgpt-windows-reply-progress'),
  titleResolver = require('./chatgpt-windows-title'), timeoutRecovery = require('./chatgpt-windows-timeout-recovery'),
  { createSubmitter } = require('./chatgpt-windows-submit');
const {
  windowsFromEnvelope, pickMainWindow, hwndOf, pidOf, selectorOf,
  composerScore, sendScore, rankCandidates, elementsFromSearch,
  normalizeCandidate, latestResponseCandidate, latestCandidate, snapshotFromInspect
} = uia;
const TARGET_ID = 'app-chatgpt-windows', PROVIDER_ID = 'chatgpt-desktop', PROVIDER_NAME = 'ChatGPT App', APP_MATCH = 'ChatGPT';
const FIRST_POLL_MS = 75, POLL_MS = 180, SETTLE_MS = 850, POST_GENERATION_SETTLE_MS = 650;
const RESPONSE_TIMEOUT_MS = 8 * 60 * 1000; let lastDiagnostics = { available: false, helper: null, lastError: null, lastProbeAt: 0, lastWindow: null };
const turnState = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function createAdapter({
  runner = defaultRunner,
  platform = process.platform,
  sleepFn = sleep,
  now = () => Date.now(),
  firstPollMs = FIRST_POLL_MS,
  pollMs = POLL_MS,
  settleMs = SETTLE_MS,
  postGenerationSettleMs = POST_GENERATION_SETTLE_MS,
  shortReplySettleMs = 1400,
  responseTimeoutMs = RESPONSE_TIMEOUT_MS
} = {}) {
  async function helperStatus() {
    const helper = await runner.availability();
    lastDiagnostics = { ...lastDiagnostics, available: !!helper.available, helper, lastProbeAt: now() };
    return helper;
  }
  async function findWindow() {
    const helper = await helperStatus();
    if (!helper.available || platform !== 'win32') return null;
    const result = await runner.runJson(['ui', 'list-windows', '-a', APP_MATCH], {
      allowFailure: true,
      timeoutMs: 7000
    });
    const windowInfo = pickMainWindow(windowsFromEnvelope(result.json));
    lastDiagnostics = {
      ...lastDiagnostics,
      available: !!windowInfo,
      lastError: windowInfo ? null : (result.json?.message || result.stderr || 'ChatGPT app window not found'),
      lastProbeAt: now(),
      lastWindow: windowInfo ? {
        hwnd: hwndOf(windowInfo),
        pid: pidOf(windowInfo),
        title: String(windowInfo.title || windowInfo.name || '')
      } : null
    };
    return windowInfo;
  }
  async function inspect(windowInfo = null, { includeOffscreen = false, depth = 12 } = {}) {
    const resolved = windowInfo || await findWindow();
    if (!resolved) {
      const error = new Error('ChatGPT Windows app is not running or no visible app window was found.');
      error.code = 'APP_TARGET_NOT_FOUND';
      throw error;
    }
    const hwnd = hwndOf(resolved);
    const args = ['ui', 'inspect', '-w', String(hwnd), '--depth', String(depth)];
    if (!includeOffscreen) args.push('--hide-offscreen');
    const result = await runner.runJson(args, { timeoutMs: 12000 });
    return snapshotFromInspect({ windowInfo: resolved, json: result.json });
  }
  async function searchCandidates(hwnd, queries, scoreFn, context, minimumScore) {
    const found = [];
    for (const query of queries) {
      const result = await runner.runJson(
        ['ui', 'search', query, '-w', String(hwnd), '--max', '20'],
        { allowFailure: true, timeoutMs: 8000 }
      );
      if (!result.ok) continue;
      found.push(...elementsFromSearch(result.json));
      const match = rankCandidates(found, scoreFn, context).find((entry) => entry.score >= minimumScore);
      if (match) return match.element;
    }
    return null;
  }
  async function recoverComposerElement(snapshot) {
    return searchCandidates(
      snapshot.hwnd,
      ['Do anything', 'Ask ChatGPT', 'Message ChatGPT', 'prompt', 'composer', 'Edit', 'TextBox', 'Document', 'Pane', 'Group', 'Custom'],
      composerScore,
      { windowInfo: snapshot.windowInfo },
      18
    );
  }
  async function recoverSendElement(snapshot, composer = snapshot.composer) {
    return searchCandidates(
      snapshot.hwnd,
      ['Send', 'Submit', 'Button'],
      sendScore,
      { windowInfo: snapshot.windowInfo, composer },
      20
    );
  }
  async function recoverComposer(snapshot) {
    const found = await recoverComposerElement(snapshot);
    return found ? selectorOf(found) : '';
  }
  async function recoverSend(snapshot, composer = snapshot.composer) {
    const found = await recoverSendElement(snapshot, composer);
    return found ? selectorOf(found) : '';
  }
  async function probeControls(windowInfo = null, {
    recoverComposer = true,
    recoverSend = true
  } = {}) {
    const snapshot = await inspect(windowInfo);
    const composer = snapshot.composer
      || (recoverComposer ? await recoverComposerElement(snapshot) : null);
    const sendButton = snapshot.sendButton
      || (recoverSend ? await recoverSendElement(snapshot, composer) : null);
    lastDiagnostics = {
      ...lastDiagnostics,
      available: !!composer,
      lastError: composer ? null : 'ChatGPT composer was not exposed through Windows UI Automation.',
      lastProbeAt: now()
    };
    return {
      ...snapshot,
      composer,
      composerSelector: selectorOf(composer),
      sendButton,
      sendSelector: selectorOf(sendButton),
      recoveredComposer: !snapshot.composerSelector && !!composer,
      recoveredSend: !snapshot.sendSelector && !!sendButton
    };
  }
  async function listTargets() {
    if (platform !== 'win32') return [];
    try {
      const windowInfo = await findWindow();
      if (!windowInfo) return [];
      const hwnd = hwndOf(windowInfo), pid = pidOf(windowInfo);
      let conversationTitle = '', conversationAnchors = [];
      try {
        const snapshot = await inspect(windowInfo, { includeOffscreen: true });
        const identity = conversation.conversationIdentity(snapshot);
        conversationTitle = identity.conversationTitle || '';
        conversationAnchors = identity.conversationAnchors || [];
        if (!conversationTitle) {
          conversationTitle = (await titleResolver.resolve({ runner, snapshot }))?.text || '';
        }
      } catch {}
      const conversationAnchor = conversationAnchors.at(-1) || '';
      const exactConversationIdentity = !!conversationTitle || !!conversationAnchor;
      return [{ id: TARGET_ID,
        title: conversationTitle
          ? `ChatGPT · ${conversationTitle}`
          : exactConversationIdentity ? 'ChatGPT · verified native conversation'
            : String(windowInfo.title || windowInfo.name || 'ChatGPT'),
        providerId: PROVIDER_ID,
        providerName: PROVIDER_NAME,
        targetTypeId: 'desktop-app',
        targetTypeName: 'Desktop App',
        transport: 'windows-uia-winapp',
        sessionOrigin: 'existing-app',
        pid,
        windowHandle: hwnd,
        concreteTargetIdentity: {
          kind: 'windows-app-window',
          app: 'ChatGPT',
          processId: pid,
          windowHandle: hwnd,
          ...(conversationTitle ? { conversationTitle } : {}),
          ...(conversationAnchor ? { conversationAnchor } : {}),
          ...(conversationAnchors.length ? { conversationAnchors } : {})
        },
        capabilities: { chat: true, captureLatest: true, activity: false,
          exactConversationIdentity }
      }];
    } catch (error) {
      lastDiagnostics = { ...lastDiagnostics, available: false, lastError: error.message, lastProbeAt: now() };
      return [];
    }
  }
  const stageAndSubmit = createSubmitter({
    runner, inspect, recoverComposer, recoverSend, sleepFn
  });
  async function sendPrompt({ requestId, text, target, emit, transportTiming = {} }) {
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
      targetId: target.id, providerId: PROVIDER_ID, providerName: PROVIDER_NAME,
      observedAt: acceptedAt, detail: dispatchTiming });
    const deadline = acceptedAt + responseTimeoutMs;
    let lastText = '', lastChangedAt = acceptedAt, firstResponseAt = 0, lastSnapshot = null, nativeTurn = null, progressState = 'replace';
    let sawGenerating = false, firstPoll = true, pollCount = 0, committedPending = true, tailStablePasses = 0;
    let pollInspectMs = 0, finalReconstructionMs = 0;
    turnState.set(target.id, { phase: 'waiting', requestId, startedAt: acceptedAt, latestText: '' });
    while (now() < deadline) {
      if (committedPending) { lastSnapshot = committedSnapshot; committedPending = false; }
      else {
        await sleepFn(firstPoll ? firstPollMs : pollMs); firstPoll = false;
        const pollInspectStartedAt = Date.now();
        lastSnapshot = await inspect({
          hwnd: target.windowHandle, pid: target.pid, title: target.title
        });
        pollInspectMs += Math.max(0, Date.now() - pollInspectStartedAt);
      }
      pollCount += 1;
      const observedAt = now();
      if (lastSnapshot.generating) sawGenerating = true;
      const observed = conversation.responseForPrompt(lastSnapshot, { baseline: baselineSet, prompt: text });
      const candidate = observed.text; if (observed.nativeTurn) nativeTurn = observed.nativeTurn;
      progressState = replyProgress.transitionProgressMode(progressState, observed);
      const mergedText = progressState === 'native' ? lastText : progressState === 'accumulate'
        ? replyProgress.mergeReplyProgress(lastText, candidate) : (candidate || lastText);
      if (candidate && mergedText !== lastText) {
        lastText = mergedText; tailStablePasses = 0;
        if (!firstResponseAt) firstResponseAt = observedAt;
        lastChangedAt = observedAt;
        turnState.set(target.id, { phase: 'streaming', requestId, startedAt: acceptedAt,
          latestText: mergedText, sawGenerating });
        emit?.({
          type: 'response_partial', requestId, text: mergedText,
          targetClassId: 'app-origin',
          targetId: target.id,
          providerId: PROVIDER_ID,
          providerName: PROVIDER_NAME
        });
      }
      if (observed.provisional) { lastChangedAt = observedAt; continue; }
      const stableFor = observedAt - lastChangedAt, baseSettle = sawGenerating ? postGenerationSettleMs : settleMs;
      const requiredSettle = progressState === 'role' && !observed.nativeTurn?.completeHint ? Math.max(baseSettle, 5000) : progressState === 'accumulate' && replyProgress.needsTailGuard(lastText) ? Math.max(baseSettle, 2500) : lastText.length < 32 ? Math.max(baseSettle, shortReplySettleMs) : baseSettle;
      if (lastText && !lastSnapshot.generating && (observed.nativeTurn?.completeHint || (requiredSettle > 0 ? stableFor >= requiredSettle : stableFor > 0))) {
        const reconstructionStartedAt = Date.now();
        try {
          const fullSnapshot = await inspect({
            hwnd: target.windowHandle, pid: target.pid, title: target.title
          }, { includeOffscreen: true, depth: 32 });
          const full = conversation.responseForPrompt(fullSnapshot, {
            baseline: baselineSet, prompt: text, includeOffscreen: true
          });
          if (full.correlated && !full.nativeTurn) { lastSnapshot = fullSnapshot; lastChangedAt = now(); continue; }
          nativeTurn = full.nativeTurn || nativeTurn; progressState = replyProgress.transitionProgressMode(progressState, full);
          const fullText = full.nativeTurn?.text || full.text; const reconstructed = full.progressMode === 'accumulate' ? replyProgress.preferFinalReply(lastText, fullText) : full.nativeTurn?.completeHint ? fullText : observed.nativeTurn?.completeHint ? conversation.preferExpandedReply(lastText, fullText) : fullText || conversation.preferExpandedReply(lastText, full.text);
          lastSnapshot = fullSnapshot; if (full.progressMode === 'accumulate' && full.nativeTurn?.text && reconstructed === full.nativeTurn.text && !replyProgress.needsTailGuard(reconstructed)) progressState = 'native';
          if (reconstructed && reconstructed !== lastText) {
            lastText = reconstructed; lastChangedAt = now(); tailStablePasses = 0;
            emit?.({ type: 'response_partial', requestId, text: lastText,
              targetClassId: 'app-origin', targetId: target.id,
              providerId: PROVIDER_ID, providerName: PROVIDER_NAME });
            if (full.progressMode === 'accumulate') continue;
          }
          if (!(observed.nativeTurn?.completeHint || full.nativeTurn?.completeHint) && replyProgress.needsCompletionGuard(lastText, progressState) && ++tailStablePasses < 3) continue;
        } catch {} finally {
          finalReconstructionMs += Math.max(0, Date.now() - reconstructionStartedAt);
        }
        const finalizedAt = now();
        const timing = {
          ...dispatchTiming,
          timeToFirstResponseMs: firstResponseAt ? Math.max(0, firstResponseAt - acceptedAt) : null,
          totalResponseMs: Math.max(0, finalizedAt - acceptedAt),
          nexusRoundTripMs: Math.max(0, finalizedAt - dispatchStartedAt),
          adapterSettleMs: stableFor, pollInspectMs, finalReconstructionMs, pollCount, sawGenerating
        };
        turnState.set(target.id, { phase: 'idle', requestId, latestText: lastText,
          completedAt: finalizedAt, sawGenerating, timing });
        emit?.({
          type: 'response_final', requestId, text: lastText, observedAt: finalizedAt,
          completenessHint: sawGenerating ? 'generation-ended' : 'settled',
          detail: timing,
          targetClassId: 'app-origin', targetId: target.id,
          providerId: PROVIDER_ID, providerName: PROVIDER_NAME
        });
        return { text: lastText, snapshot: lastSnapshot, nativeTurn };
      }
    }
    const recoveryStartedAt = Date.now();
    const recovered = await timeoutRecovery.recoverAuthoritativeReply({ inspect, target, baseline: baselineSet, prompt: text });
    finalReconstructionMs += Math.max(0, Date.now() - recoveryStartedAt);
    if (recovered) {
      const finalizedAt = now(), firstAt = firstResponseAt || finalizedAt;
      const timing = { ...dispatchTiming, timeToFirstResponseMs: Math.max(0, firstAt - acceptedAt), totalResponseMs: Math.max(0, finalizedAt - acceptedAt), nexusRoundTripMs: Math.max(0, finalizedAt - dispatchStartedAt), adapterSettleMs: Math.max(0, finalizedAt - lastChangedAt), pollInspectMs, finalReconstructionMs, pollCount, sawGenerating, timeoutRecovered: true };
      turnState.set(target.id, { phase: 'idle', requestId, latestText: recovered.text, completedAt: finalizedAt, sawGenerating, timing });
      emit?.({ type: 'response_final', requestId, text: recovered.text, observedAt: finalizedAt, completenessHint: 'timeout-recovered', detail: timing, targetClassId: 'app-origin', targetId: target.id, providerId: PROVIDER_ID, providerName: PROVIDER_NAME });
      return recovered;
    }
    const error = new Error('Timed out waiting for a stable ChatGPT app reply.');
    error.code = 'APP_RESPONSE_TIMEOUT';
    turnState.set(target.id, { phase: 'error', requestId, latestText: lastText, error: error.message, at: now() });
    throw error;
  }
  async function captureLatest({ target }) {
    const liveWindow = await findWindow();
    if (!liveWindow || String(pidOf(liveWindow)) !== String(target.pid)
        || String(hwndOf(liveWindow)) !== String(target.windowHandle)) {
      const error = new Error('The bound ChatGPT app process/window changed; explicit rebind is required.');
      error.code = 'APP_TARGET_REBIND_REQUIRED'; throw error;
    }
    const snapshot = await inspect(liveWindow, { includeOffscreen: true });
    const remembered = turnState.get(target.id)?.latestText || '';
    const grouped = conversation.latestAssistantReply(snapshot, { includeOffscreen: true });
    const live = grouped?.text || latestResponseCandidate(snapshot)?.text || snapshot.latestResponseText || '';
    const stored = conversation.hasRoleMarkers(snapshot) ? (live || remembered) : replyProgress.mergeReplyProgress(remembered, live);
    return { text: stored || snapshot.latestText || '', snapshot,
      replyParts: grouped?.partCount || (live ? 1 : 0), observedAt: now(),
      isGenerating: !!snapshot.generating, generationState: snapshot.generating ? 'active' : 'idle',
      completenessHint: snapshot.generating ? 'incomplete' : 'settled' };
  }
  function status(targetId = TARGET_ID) {
    return {
      ...(turnState.get(targetId) || { phase: 'idle' }),
      diagnostics: { ...lastDiagnostics }
    };
  }
  function diagnostics() {
    return { ...lastDiagnostics };
  }
  return {
    TARGET_ID,
    ownsTarget: (targetId) => targetId === TARGET_ID,
    listTargets,
    sendPrompt,
    captureLatest,
    status,
    diagnostics, inspect, probeControls, findWindow,
    completedTurns: conversation.completedAssistantTurns,
    conversationIdentity: conversation.conversationIdentity
  };
}
const defaultAdapter = createAdapter();
module.exports = {
  TARGET_ID,
  PROVIDER_ID,
  PROVIDER_NAME,
  APP_MATCH,
  FIRST_POLL_MS,
  POLL_MS,
  SETTLE_MS,
  POST_GENERATION_SETTLE_MS,
  RESPONSE_TIMEOUT_MS,
  ...uia,
  createAdapter,
  ...defaultAdapter
};
