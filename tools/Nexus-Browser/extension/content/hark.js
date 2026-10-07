(() => {
  if (typeof window !== 'undefined' && globalThis.__browserAiBridgeHarkLoaded) return;
  if (typeof window !== 'undefined') globalThis.__browserAiBridgeHarkLoaded = true;

  const input = globalThis.BrowserAiBridgeHarkInput
    || (typeof module !== 'undefined' && module.exports ? require('./hark-input.js') : null);
  const answer = globalThis.BrowserAiBridgeHarkAnswer
    || (typeof module !== 'undefined' && module.exports ? require('./hark-answer.js') : null);
  if (!input || !answer) throw new Error('Hark bridge modules were not loaded in the expected order.');

  const active = new Map();
  const GENERATION_HEARTBEAT_MS = 15000;

  function emit(payload) {
    try { chrome.runtime.sendMessage(payload); } catch {}
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function stripPromptEcho(value, prompt) {
    const text = String(value || '').trim();
    const echo = String(prompt || '').trim();
    if (!text || !echo) return text;
    const pattern = escapeRegExp(echo).replace(/\s+/g, '\\s+');
    const match = text.match(new RegExp(`^${pattern}(?=$|\\s|[:—–-])`));
    if (!match) return text;
    return text.slice(match[0].length).replace(/^[\s:—–-]+/, '').trim();
  }

  function stopWatcher(requestId) {
    const watcher = active.get(requestId);
    if (!watcher) return;
    watcher.observer?.disconnect();
    clearInterval(watcher.timer);
    active.delete(requestId);
  }

  function stopStaleWatchers(exceptRequestId = null) {
    for (const requestId of [...active.keys()]) {
      if (requestId !== exceptRequestId) stopWatcher(requestId);
    }
  }

  function reportGenerationActivity(watcher, requestId, isGenerating, force = false) {
    const stamp = Date.now();
    const state = isGenerating ? 'active' : 'idle';
    if (isGenerating) {
      if (!force && watcher.lastGenerationState === 'active'
          && stamp - watcher.lastHeartbeatAt < GENERATION_HEARTBEAT_MS) return;
    } else if (!force && watcher.lastGenerationState !== 'active') return;
    watcher.lastGenerationState = state;
    watcher.lastHeartbeatAt = stamp;
    emit({ type: 'response_activity', requestId, isGenerating, generationState: state, observedAt: stamp });
  }

  function watchResponse(requestId, baseline, promptText = '') {
    const watcher = {
      baselineCount: baseline.count,
      baselineText: baseline.text,
      promptText: String(promptText || ''),
      lastText: '',
      lastChangedAt: Date.now(),
      started: false,
      sawGenerating: false,
      generatingEndedAt: 0,
      lastHeartbeatAt: 0,
      lastGenerationState: 'unknown',
      observer: null,
      timer: null
    };

    function current() {
      const nodes = answer.assistantNodes(document);
      const rawText = answer.getTurnAssistantText(nodes, watcher.baselineCount);
      return {
        nodes,
        text: stripPromptEcho(rawText, watcher.promptText)
      };
    }

    function finalize() {
      const sample = current();
      const text = sample.text || watcher.lastText;
      if (!text) return;
      emit({ type: 'response_final', requestId, text });
      stopWatcher(requestId);
    }

    function sample() {
      const isGenerating = input.generationLooksActive();
      reportGenerationActivity(watcher, requestId, isGenerating);
      if (isGenerating) {
        watcher.sawGenerating = true;
        watcher.generatingEndedAt = 0;
      } else if (watcher.sawGenerating && !watcher.generatingEndedAt) {
        watcher.generatingEndedAt = Date.now();
        reportGenerationActivity(watcher, requestId, false, true);
      }

      const { nodes, text } = current();
      if (!nodes.length || !text) return;
      const newNode = nodes.length > watcher.baselineCount;
      const changedExisting = text !== watcher.baselineText;
      if (!watcher.started && !newNode && !changedExisting) return;
      watcher.started = true;

      if (text !== watcher.lastText) {
        watcher.lastText = text;
        watcher.lastChangedAt = Date.now();
        emit({ type: 'response_partial', requestId, text });
        return;
      }
      if (isGenerating) return;

      const stableFor = Date.now() - watcher.lastChangedAt;
      if (watcher.sawGenerating && watcher.generatingEndedAt
          && Date.now() - watcher.generatingEndedAt >= 1500 && stableFor >= 1500) {
        finalize();
        return;
      }
      // Hark may not expose an explicit streaming/stop state. Stable text is a conservative fallback.
      if (!watcher.sawGenerating && stableFor >= 8000) finalize();
    }

    watcher.observer = new MutationObserver(sample);
    watcher.observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    watcher.timer = setInterval(sample, 400);
    active.set(requestId, watcher);
  }

  async function waitForComposerText(composer, text, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (input.composerContainsText(composer, text)) return true;
      await sleep(40);
    }
    return input.composerContainsText(composer, text);
  }

  async function waitForDeparture(composer, text, timeoutMs = 1800) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!input.composerContainsText(composer, text)) return true;
      await sleep(50);
    }
    return !input.composerContainsText(composer, text);
  }

  async function waitForSendControl(composer, timeoutMs = 1500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const control = input.findSendControl(composer);
      if (control) return control;
      await sleep(50);
    }
    return input.findSendControl(composer);
  }

  function dispatchEnter(composer) {
    const options = {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true, composed: true
    };
    composer.focus?.();
    composer.dispatchEvent(new KeyboardEvent('keydown', options));
    composer.dispatchEvent(new KeyboardEvent('keypress', options));
    composer.dispatchEvent(new KeyboardEvent('keyup', options));
  }

  async function submitPrompt(requestId, text, { qualification = null } = {}) {
    stopStaleWatchers(requestId);
    const composer = input.findComposer();
    if (!composer) {
      throw new Error('Hark composer was not found on this chat/project page. Keep an authenticated Hark chat or project workspace open and retry.');
    }

    const beforeNodes = answer.assistantNodes(document);
    const baseline = {
      count: beforeNodes.length,
      text: answer.getTurnAssistantText(beforeNodes, beforeNodes.length)
    };

    input.setComposerText(composer, text);
    if (!(await waitForComposerText(composer, text))) {
      throw new Error('Hark composer did not retain the prompt text after insertion.');
    }

    watchResponse(requestId, baseline, text);
    const exactOnce = qualification?.exactOnce === true;
    const sendControl = await waitForSendControl(composer);
    if (sendControl) {
      sendControl.click();
      if (!exactOnce || await waitForDeparture(composer, text)) return;
      stopWatcher(requestId);
      throw new Error('Hark qualification prompt was not committed after the single allowed send-button click.');
    }

    dispatchEnter(composer);
    if (exactOnce && !(await waitForDeparture(composer, text))) {
      stopWatcher(requestId);
      throw new Error('Hark qualification prompt was not committed after the single allowed Enter submission.');
    }
  }

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'bridge_ping') {
        sendResponse({ ok: true, adapter: 'hark' });
        return;
      }
      if (msg.type === 'capture_latest') {
        const text = answer.latestAssistantText();
        const isGenerating = !!input.generationLooksActive();
        sendResponse({
          ok: true,
          text,
          isGenerating,
          generationState: isGenerating ? 'active' : 'idle',
          observedAt: Date.now(),
          completenessHint: isGenerating ? 'unknown' : 'settled'
        });
        return;
      }
      if (msg.type === 'send_prompt') {
        submitPrompt(msg.requestId, msg.text, { qualification: msg.qualification || null })
          .then(() => sendResponse({ ok: true }))
          .catch((error) => {
            stopWatcher(msg.requestId);
            emit({ type: 'adapter_error', requestId: msg.requestId, code: 'PROMPT_SEND_FAILED', message: error.message });
            sendResponse({ ok: false, error: error.message });
          });
        return true;
      }
    });
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      ...input,
      ...answer,
      stripPromptEcho,
      watchResponse,
      submitPrompt,
      stopWatcher,
      stopStaleWatchers,
      waitForComposerText,
      waitForDeparture,
      waitForSendControl,
      dispatchEnter
    };
  }
})();
