'use strict';

const defaultRunner = require('./winapp-runner'), uia = require('./chatgpt-windows-uia'),
  conversation = require('./chatgpt-windows-conversation'), replyProgress = require('./chatgpt-windows-reply-progress'),
  titleResolver = require('./chatgpt-windows-title');
const {
  windowsFromEnvelope, pickMainWindow, hwndOf, pidOf, selectorOf,
  composerScore, sendScore, rankCandidates, elementsFromSearch,
  normalizeCandidate, latestResponseCandidate, latestCandidate, snapshotFromInspect
} = uia;

const TARGET_ID = 'app-chatgpt-windows', PROVIDER_ID = 'chatgpt-desktop', PROVIDER_NAME = 'ChatGPT App', APP_MATCH = 'ChatGPT';
const FIRST_POLL_MS = 75, POLL_MS = 180, SETTLE_MS = 850, POST_GENERATION_SETTLE_MS = 650;
const RESPONSE_TIMEOUT_MS = 8 * 60 * 1000;
let lastDiagnostics = { available: false, helper: null, lastError: null, lastProbeAt: 0, lastWindow: null };
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
  async function inspect(windowInfo = null, { includeOffscreen = false } = {}) {
    const resolved = windowInfo || await findWindow();
    if (!resolved) {
      const error = new Error('ChatGPT Windows app is not running or no visible app window was found.');
      error.code = 'APP_TARGET_NOT_FOUND';
      throw error;
    }
    const hwnd = hwndOf(resolved);
    const args = ['ui', 'inspect', '-w', String(hwnd), '--depth', '12'];
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
        let snapshot = await inspect(windowInfo);
        conversationTitle = conversation.activeConversationTitle(snapshot)?.text || '';
        conversationAnchors = conversation.conversationAnchorDigests(snapshot);
        if (!conversationTitle) {
          conversationTitle = (await titleResolver.resolve({ runner, snapshot }))?.text || '';
        }
        if (!conversationAnchors.length && !conversationTitle) {
          snapshot = await inspect(windowInfo, { includeOffscreen: true });
          conversationAnchors = conversation.conversationAnchorDigests(snapshot);
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
  async function stageAndSubmit(text, baselineSnapshot) {
    let selector = baselineSnapshot.composerSelector;
    if (!selector) selector = await recoverComposer(baselineSnapshot);
    if (!selector) {
      const error = new Error('ChatGPT app composer was not found in the UI Automation tree.');
      error.code = 'APP_COMPOSER_NOT_FOUND';
      error.detail = {
        composerCandidates: baselineSnapshot.composerCandidates || []
      };
      throw error;
    }
    const hwnd = String(baselineSnapshot.hwnd);
    const setValue = (candidate) => runner.runJson(
      ['ui', 'set-value', candidate, String(text), '-w', hwnd],
      { allowFailure: true, timeoutMs: 12000 }
    );

    let staged = await setValue(selector);
    if (!staged.ok) {
      const recovered = await recoverComposer(baselineSnapshot);
      if (recovered && recovered !== selector) {
        selector = recovered;
        staged = await setValue(selector);
      }
    }
    if (!staged.ok) {
      const focused = await runner.runJson(
        ['ui', 'focus', selector, '-w', hwnd],
        { allowFailure: true, timeoutMs: 10000 }
      );
      if (focused.ok) {
        staged = await runner.runJson(
          ['ui', 'send-keys', String(text), '--verbatim', '--target', selector, '--via', 'send-input', '-w', hwnd],
          { allowFailure: true, timeoutMs: 20000 }
        );
      }
    }
    if (!staged.ok) {
      const error = new Error('ChatGPT app composer rejected programmatic text entry.');
      error.code = 'APP_INPUT_FAILED';
      error.detail = staged.json || staged.stderr || null;
      throw error;
    }
    let stagedSnapshot = await inspect({
      hwnd: baselineSnapshot.hwnd,
      pid: baselineSnapshot.pid,
      title: baselineSnapshot.title
    });
    let sendSelector = stagedSnapshot.sendSelector;
    if (!sendSelector) sendSelector = await recoverSend(stagedSnapshot, stagedSnapshot.composer || baselineSnapshot.composer);

    if (sendSelector) {
      const invoked = await runner.runJson(
        ['ui', 'invoke', sendSelector, '--action', 'invoke', '-w', hwnd],
        { allowFailure: true, timeoutMs: 10000 }
      );
      if (!invoked.ok) {
        const error = new Error('ChatGPT app Send control could not be invoked.');
        error.code = 'APP_SEND_FAILED';
        error.detail = invoked.json || invoked.stderr || null;
        throw error;
      }
    } else {
      const currentComposer = stagedSnapshot.composerSelector || selector
        || await recoverComposer(stagedSnapshot);
      const focused = currentComposer
        ? await runner.runJson(
            ['ui', 'focus', currentComposer, '-w', hwnd],
            { allowFailure: true, timeoutMs: 10000 }
          )
        : { ok: false };
      if (!focused.ok) {
        const error = new Error('ChatGPT app Send control was not found and the composer could not be focused safely.');
        error.code = 'APP_SEND_CONTROL_NOT_FOUND';
        error.detail = {
          sendCandidates: stagedSnapshot.sendCandidates || [],
          composerCandidates: stagedSnapshot.composerCandidates || []
        };
        throw error;
      }
      const enter = await runner.runJson(
        ['ui', 'send-keys', 'enter', '--target', currentComposer, '--via', 'send-input', '-w', hwnd],
        { allowFailure: true, timeoutMs: 10000 }
      );
      if (!enter.ok) {
        const error = new Error('ChatGPT app has no invokable Send control and focused Enter fallback failed.');
        error.code = 'APP_SEND_FAILED';
        error.detail = enter.json || enter.stderr || null;
        throw error;
      }
    }
    await sleepFn(80);
    const committed = await inspect({
      hwnd: baselineSnapshot.hwnd,
      pid: baselineSnapshot.pid,
      title: baselineSnapshot.title
    });
    const prompt = normalizeCandidate(text);
    const visiblePrompt = committed.texts.some((candidate) => normalizeCandidate(candidate) === prompt);
    const committedComposer = normalizeCandidate(committed.composerValue);
    const composerCleared = !committedComposer
      || /^(?:Ask ChatGPT|Message ChatGPT|Do anything)$/i.test(committedComposer);
    if (!visiblePrompt && !composerCleared && !committed.generating) {
      const error = new Error('ChatGPT app input gesture was not confirmed by the app UI.');
      error.code = 'APP_PROMPT_UNCONFIRMED';
      error.detail = {
        composerSelector: committed.composerSelector || null,
        sendSelector: committed.sendSelector || null
      };
      throw error;
    }
    return committed;
  }
  async function sendPrompt({ requestId, text, target, emit }) {
    const dispatchStartedAt = now();
    const baseline = await probeControls({
      hwnd: target.windowHandle,
      pid: target.pid,
      title: target.title
    }, { recoverComposer: true, recoverSend: false });
    const baselineSet = new Set(baseline.texts.map(normalizeCandidate));
    const committedSnapshot = await stageAndSubmit(text, baseline);

    const acceptedAt = now(), dispatchToAppMs = Math.max(0, acceptedAt - dispatchStartedAt);
    emit?.({ type: 'prompt_accepted', requestId, targetClassId: 'app-origin',
      targetId: target.id, providerId: PROVIDER_ID, providerName: PROVIDER_NAME,
      observedAt: acceptedAt, detail: { dispatchToAppMs } });

    const deadline = acceptedAt + responseTimeoutMs;
    let lastText = '', lastChangedAt = acceptedAt, firstResponseAt = 0, lastSnapshot = null, nativeTurn = null, accumulating = false;
    let sawGenerating = false, firstPoll = true, pollCount = 0, committedPending = true, tailStablePasses = 0;
    turnState.set(target.id, { phase: 'waiting', requestId, startedAt: acceptedAt, latestText: '' });

    while (now() < deadline) {
      if (committedPending) { lastSnapshot = committedSnapshot; committedPending = false; }
      else {
        await sleepFn(firstPoll ? firstPollMs : pollMs); firstPoll = false;
        lastSnapshot = await inspect({
          hwnd: target.windowHandle, pid: target.pid, title: target.title
        });
      }
      pollCount += 1;
      const observedAt = now();
      if (lastSnapshot.generating) sawGenerating = true;
      const observed = conversation.responseForPrompt(lastSnapshot, { baseline: baselineSet, prompt: text });
      const candidate = observed.text; if (observed.nativeTurn) nativeTurn = observed.nativeTurn; if (observed.progressMode === 'accumulate' && accumulating !== 'native') accumulating = true;
      const mergedText = accumulating === 'native' ? lastText : accumulating
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
      const stableFor = observedAt - lastChangedAt;
      const baseSettle = sawGenerating ? postGenerationSettleMs : settleMs;
      const requiredSettle = accumulating && replyProgress.needsTailGuard(lastText) ? Math.max(baseSettle, 2500) : lastText.length < 32 ? Math.max(baseSettle, shortReplySettleMs) : baseSettle;
      if (lastText && !lastSnapshot.generating && (requiredSettle > 0 ? stableFor >= requiredSettle : stableFor > 0)) {
        try {
          const fullSnapshot = await inspect({
            hwnd: target.windowHandle, pid: target.pid, title: target.title
          }, { includeOffscreen: true });
          const full = conversation.responseForPrompt(fullSnapshot, {
            baseline: baselineSet, prompt: text, includeOffscreen: true
          });
          if (full.correlated && !full.nativeTurn) { lastSnapshot = fullSnapshot; lastChangedAt = now(); continue; }
          nativeTurn = full.nativeTurn || nativeTurn; if (full.progressMode === 'accumulate' && !accumulating) accumulating = true;
          const reconstructed = full.progressMode === 'accumulate' ? replyProgress.preferFinalReply(lastText, full.nativeTurn?.text || full.text) : full.nativeTurn?.text || (full.progressMode === 'replace' && full.text ? full.text : conversation.preferExpandedReply(lastText, full.text));
          lastSnapshot = fullSnapshot; if (full.nativeTurn?.text && reconstructed === full.nativeTurn.text) accumulating = 'native';
          if (reconstructed && reconstructed !== lastText) {
            lastText = reconstructed; lastChangedAt = now(); tailStablePasses = 0;
            emit?.({ type: 'response_partial', requestId, text: lastText,
              targetClassId: 'app-origin', targetId: target.id,
              providerId: PROVIDER_ID, providerName: PROVIDER_NAME });
            if (full.progressMode === 'accumulate') continue;
          }
          if (full.progressMode === 'accumulate' && replyProgress.needsTailGuard(lastText) && ++tailStablePasses < 3) continue;
        } catch {}
        const finalizedAt = now();
        const timing = {
          dispatchToAppMs,
          timeToFirstResponseMs: firstResponseAt ? Math.max(0, firstResponseAt - acceptedAt) : null,
          totalResponseMs: Math.max(0, finalizedAt - acceptedAt),
          nexusRoundTripMs: Math.max(0, finalizedAt - dispatchStartedAt),
          adapterSettleMs: stableFor, pollCount, sawGenerating
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
    const stored = replyProgress.mergeReplyProgress(remembered, live);
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
