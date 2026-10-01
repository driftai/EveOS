'use strict';

const defaultRunner = require('./winapp-runner');
const uia = require('./chatgpt-windows-uia');
const {
  windowsFromEnvelope, pickMainWindow, hwndOf, pidOf,
  normalizeCandidate, latestCandidate, snapshotFromInspect
} = uia;

const TARGET_ID = 'app-chatgpt-windows';
const PROVIDER_ID = 'chatgpt-desktop';
const PROVIDER_NAME = 'ChatGPT App';
const APP_MATCH = 'ChatGPT';
const POLL_MS = 800;
const SETTLE_MS = 3200;
const RESPONSE_TIMEOUT_MS = 4 * 60 * 1000;

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
  pollMs = POLL_MS,
  settleMs = SETTLE_MS,
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

  async function inspect(windowInfo = null) {
    const resolved = windowInfo || await findWindow();
    if (!resolved) {
      const error = new Error('ChatGPT Windows app is not running or no visible app window was found.');
      error.code = 'APP_TARGET_NOT_FOUND';
      throw error;
    }
    const hwnd = hwndOf(resolved);
    const result = await runner.runJson([
      'ui', 'inspect', '-w', String(hwnd), '--depth', '12', '--hide-offscreen'
    ], { timeoutMs: 12000 });
    const snapshot = snapshotFromInspect({ windowInfo: resolved, json: result.json });
    if (!snapshot.composerSelector) {
      lastDiagnostics = { ...lastDiagnostics, lastError: 'ChatGPT composer was not exposed through Windows UI Automation.' };
    }
    return snapshot;
  }

  async function listTargets() {
    if (platform !== 'win32') return [];
    try {
      const windowInfo = await findWindow();
      if (!windowInfo) return [];
      const hwnd = hwndOf(windowInfo), pid = pidOf(windowInfo);
      return [{
        id: TARGET_ID,
        title: String(windowInfo.title || windowInfo.name || 'ChatGPT'),
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
          windowHandle: hwnd
        },
        capabilities: { chat: true, captureLatest: true, activity: false }
      }];
    } catch (error) {
      lastDiagnostics = { ...lastDiagnostics, available: false, lastError: error.message, lastProbeAt: now() };
      return [];
    }
  }

  async function stageAndSubmit(text, baselineSnapshot) {
    const selector = baselineSnapshot.composerSelector;
    if (!selector) {
      const error = new Error('ChatGPT app composer was not found in the UI Automation tree.');
      error.code = 'APP_COMPOSER_NOT_FOUND';
      throw error;
    }
    const hwnd = String(baselineSnapshot.hwnd);
    let staged = await runner.runJson(
      ['ui', 'set-value', selector, String(text), '-w', hwnd],
      { allowFailure: true, timeoutMs: 12000 }
    );
    if (!staged.ok) {
      staged = await runner.runJson(
        ['ui', 'send-keys', String(text), '--verbatim', '--target', selector, '--via', 'send-input', '-w', hwnd],
        { allowFailure: true, timeoutMs: 20000 }
      );
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
    if (stagedSnapshot.sendSelector) {
      const invoked = await runner.runJson(
        ['ui', 'invoke', stagedSnapshot.sendSelector, '-w', hwnd],
        { allowFailure: true, timeoutMs: 10000 }
      );
      if (!invoked.ok) {
        const error = new Error('ChatGPT app Send control could not be invoked.');
        error.code = 'APP_SEND_FAILED';
        error.detail = invoked.json || invoked.stderr || null;
        throw error;
      }
    } else {
      const enter = await runner.runJson(
        ['ui', 'send-keys', 'enter', '--target', selector, '--via', 'send-input', '-w', hwnd],
        { allowFailure: true, timeoutMs: 10000 }
      );
      if (!enter.ok) {
        const error = new Error('ChatGPT app has no invokable Send control and Enter fallback failed.');
        error.code = 'APP_SEND_FAILED';
        error.detail = enter.json || enter.stderr || null;
        throw error;
      }
    }

    await sleepFn(250);
    const committed = await inspect({
      hwnd: baselineSnapshot.hwnd,
      pid: baselineSnapshot.pid,
      title: baselineSnapshot.title
    });
    const prompt = normalizeCandidate(text);
    const visiblePrompt = committed.texts.some((candidate) => normalizeCandidate(candidate) === prompt);
    const composerCleared = !normalizeCandidate(committed.composerValue)
      || normalizeCandidate(committed.composerValue) === 'Ask ChatGPT';
    if (!visiblePrompt && !composerCleared && !committed.generating) {
      const error = new Error('ChatGPT app input gesture was not confirmed by the app UI.');
      error.code = 'APP_PROMPT_UNCONFIRMED';
      throw error;
    }
    return committed;
  }

  async function sendPrompt({ requestId, text, target, emit }) {
    const baseline = await inspect({
      hwnd: target.windowHandle,
      pid: target.pid,
      title: target.title
    });
    const baselineSet = new Set(baseline.texts.map(normalizeCandidate));
    await stageAndSubmit(text, baseline);

    emit?.({
      type: 'prompt_accepted',
      requestId,
      targetClassId: 'app-origin',
      targetId: target.id,
      providerId: PROVIDER_ID,
      providerName: PROVIDER_NAME,
      observedAt: now()
    });

    const deadline = now() + responseTimeoutMs;
    let lastText = '';
    let lastChangedAt = now();
    let lastSnapshot = null;
    turnState.set(target.id, { phase: 'waiting', requestId, startedAt: now(), latestText: '' });

    while (now() < deadline) {
      await sleepFn(pollMs);
      lastSnapshot = await inspect({
        hwnd: target.windowHandle,
        pid: target.pid,
        title: target.title
      });
      const candidate = latestCandidate(lastSnapshot.texts, { baseline: baselineSet, prompt: text });
      if (candidate && candidate !== lastText) {
        lastText = candidate;
        lastChangedAt = now();
        turnState.set(target.id, { phase: 'streaming', requestId, startedAt: turnState.get(target.id)?.startedAt || now(), latestText: candidate });
        emit?.({
          type: 'response_partial',
          requestId,
          text: candidate,
          targetClassId: 'app-origin',
          targetId: target.id,
          providerId: PROVIDER_ID,
          providerName: PROVIDER_NAME
        });
      }
      if (lastText && !lastSnapshot.generating && now() - lastChangedAt >= settleMs) {
        turnState.set(target.id, { phase: 'idle', requestId, latestText: lastText, completedAt: now() });
        emit?.({
          type: 'response_final',
          requestId,
          text: lastText,
          observedAt: now(),
          completenessHint: 'settled',
          targetClassId: 'app-origin',
          targetId: target.id,
          providerId: PROVIDER_ID,
          providerName: PROVIDER_NAME
        });
        return { text: lastText, snapshot: lastSnapshot };
      }
    }

    const error = new Error('Timed out waiting for a stable ChatGPT app reply.');
    error.code = 'APP_RESPONSE_TIMEOUT';
    turnState.set(target.id, { phase: 'error', requestId, latestText: lastText, error: error.message, at: now() });
    throw error;
  }

  async function captureLatest({ target }) {
    const snapshot = await inspect({
      hwnd: target.windowHandle,
      pid: target.pid,
      title: target.title
    });
    const remembered = turnState.get(target.id)?.latestText || '';
    return { text: remembered || snapshot.latestText || '', snapshot };
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
    diagnostics,
    inspect,
    findWindow
  };
}

const defaultAdapter = createAdapter();

module.exports = {
  TARGET_ID,
  PROVIDER_ID,
  PROVIDER_NAME,
  APP_MATCH,
  POLL_MS,
  SETTLE_MS,
  RESPONSE_TIMEOUT_MS,
  ...uia,
  createAdapter,
  ...defaultAdapter
};
