'use strict';

const defaultRunner = require('./winapp-runner');
const uia = require('./chatgpt-windows-uia');
const conversation = require('./chatgpt-windows-conversation');
const titleResolver = require('./chatgpt-windows-title');
const stability = require('./chatgpt-windows-stability');
const capture = require('./chatgpt-windows-capture');
const busyRecovery = require('./chatgpt-windows-busy-recovery');
const { createPromptSender } = require('./chatgpt-windows-send');
const { createSubmitter } = require('./chatgpt-windows-submit');

const {
  windowsFromEnvelope, pickMainWindow, hwndOf, pidOf, selectorOf,
  composerScore, sendScore, rankCandidates, elementsFromSearch,
  snapshotFromInspect
} = uia;
const TARGET_ID = 'app-chatgpt-windows';
const PROVIDER_ID = 'chatgpt-desktop';
const PROVIDER_NAME = 'ChatGPT App';
const APP_MATCH = 'ChatGPT';
const FIRST_POLL_MS = 75;
const POLL_MS = 180;
const SETTLE_MS = 850;
const POST_GENERATION_SETTLE_MS = 650;
const {
  FIRST_RESPONSE_RESCUE_AFTER_MS,
  FIRST_RESPONSE_RESCUE_INTERVAL_MS,
  FIRST_RESPONSE_RESCUE_MAX_ATTEMPTS
} = stability;
const RESPONSE_TIMEOUT_MS = 8 * 60 * 1000;
let lastDiagnostics = {
  available: false,
  helper: null,
  lastError: null,
  lastProbeAt: 0,
  lastWindow: null
};
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
  firstResponseRescueAfterMs = FIRST_RESPONSE_RESCUE_AFTER_MS,
  firstResponseRescueIntervalMs = FIRST_RESPONSE_RESCUE_INTERVAL_MS,
  firstResponseRescueMaxAttempts = FIRST_RESPONSE_RESCUE_MAX_ATTEMPTS,
  responseTimeoutMs = RESPONSE_TIMEOUT_MS
} = {}) {
  let lastVerifiedTarget = null;

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
      const match = rankCandidates(found, scoreFn, context)
        .find((entry) => entry.score >= minimumScore);
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

  function targetFromIdentity(windowInfo, identity = {}) {
    const hwnd = hwndOf(windowInfo), pid = pidOf(windowInfo);
    const conversationTitle = String(identity.conversationTitle || '').trim();
    const conversationAnchors = Array.isArray(identity.conversationAnchors)
      ? identity.conversationAnchors.filter(Boolean).map(String) : [];
    const conversationAnchor = String(identity.conversationAnchor || conversationAnchors.at(-1) || '');
    const exactConversationIdentity = !!conversationTitle || !!conversationAnchor;
    return {
      id: TARGET_ID,
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
      capabilities: {
        chat: true,
        captureLatest: true,
        activity: false,
        exactConversationIdentity
      }
    };
  }

  async function listTargets() {
    if (platform !== 'win32') return [];
    try {
      if (lastVerifiedTarget) {
        const verified = await stability.verifyCachedTarget({
          cachedTarget: lastVerifiedTarget,
          inspect,
          conversationIdentity: conversation.conversationIdentity,
          targetFromIdentity
        });
        if (verified) {
          lastVerifiedTarget = verified;
          return [verified];
        }
      }

      const windowInfo = await findWindow();
      if (!windowInfo) return [];
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
      const target = targetFromIdentity(windowInfo, {
        conversationTitle,
        conversationAnchor: conversationAnchors.at(-1) || '',
        conversationAnchors
      });
      lastVerifiedTarget = target.capabilities.exactConversationIdentity ? target : null;
      return [target];
    } catch (error) {
      lastDiagnostics = {
        ...lastDiagnostics,
        available: false,
        lastError: error.message,
        lastProbeAt: now()
      };
      return [];
    }
  }

  const stageAndSubmit = createSubmitter({
    runner, inspect, recoverComposer, recoverSend, sleepFn
  });
  const busyRecoveryController = busyRecovery.createBusyRecoveryController({ inspect, sleepFn, now });
  const sendPrompt = createPromptSender({
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
    providerId: PROVIDER_ID,
    providerName: PROVIDER_NAME
  });

  async function captureLatest({ target }) {
    return capture.captureLatest({
      target,
      findWindow,
      inspect,
      remembered: turnState.get(target.id)?.latestText || '',
      now
    });
  }

  async function probeActiveCompletion({ target, requestId }) {
    return busyRecoveryController.probe({ target, requestId });
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
    probeActiveCompletion,
    status,
    diagnostics,
    inspect,
    probeControls,
    findWindow,
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
  FIRST_RESPONSE_RESCUE_AFTER_MS,
  FIRST_RESPONSE_RESCUE_INTERVAL_MS,
  FIRST_RESPONSE_RESCUE_MAX_ATTEMPTS,
  RESPONSE_TIMEOUT_MS,
  ...stability,
  ...busyRecovery,
  ...uia,
  createAdapter,
  ...defaultAdapter
};
