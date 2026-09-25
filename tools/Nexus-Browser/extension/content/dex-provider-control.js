(() => {
  if (typeof window !== 'undefined' && globalThis.__browserAiBridgeDexProviderControlLoaded) return;
  if (typeof window !== 'undefined') globalThis.__browserAiBridgeDexProviderControlLoaded = true;

  const PREFIX = '[[DEX:CMD ';
  const ACTIONS = new Set(['help', 'onboard', 'checkpoint', 'read_checkpoint', 'rooms', 'targets', 'create_room', 'use_room', 'status', 'rename_room', 'configure_room', 'rename_self', 'set_self_relay', 'rename_agent', 'set_agent_relay', 'remove_agent', 'stop_relay', 'continue_relay', 'clear_chat', 'delete_room', 'add_agent', 'spawn_agent', 'despawn_agent', 'send', 'handoff_room', 'reload_extension']);
  const PROVIDERS = [
    { id: 'deepseek', answer: 'BrowserAiBridgeDeepSeekAnswer', input: 'BrowserAiBridgeDeepSeekInput' },
    { id: 'grok', answer: 'BrowserAiBridgeGrokAnswer', input: 'BrowserAiBridgeGrokInput' },
    { id: 'claude', answer: 'BrowserAiBridgeClaudeAnswer', input: 'BrowserAiBridgeClaudeInput' },
    { id: 'chatgpt', answer: 'BrowserAiBridgeChatGptAnswer', input: 'BrowserAiBridgeChatGptInput' },
    { id: 'gemini', answer: 'BrowserAiBridgeGeminiAnswer', input: 'BrowserAiBridgeGeminiInput' },
    { id: 'muse', answer: 'BrowserAiBridgeMuseAnswer', input: 'BrowserAiBridgeMuseInput' }
  ];
  const SETTLED_MS = 450;

  function providerRuntime() {
    return PROVIDERS.find((entry) => globalThis[entry.answer]?.latestAssistantText) || null;
  }

  function insideFence(text, index) {
    const before = String(text || '').slice(0, index);
    return (before.match(/```/g) || []).length % 2 === 1;
  }

  function ignorableUiSuffix(value) {
    const lines = String(value || '').split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (!lines.length) return true;
    const allowed = /^(copy|copy response|good response|bad response|read aloud|share|more|retry|regenerate|edit|edit message)$/i;
    return lines.every((line) => allowed.test(line));
  }

  function parseTrailingCommand(value) {
    const text = String(value || '').trim();
    const closeIndex = text.lastIndexOf(']]');
    if (closeIndex < 0 || !ignorableUiSuffix(text.slice(closeIndex + 2))) return null;
    let index = text.indexOf(PREFIX);
    while (index >= 0 && index < closeIndex) {
      if (!insideFence(text, index)) {
        const jsonText = text.slice(index + PREFIX.length, closeIndex).trim();
        if (jsonText.startsWith('{') && jsonText.endsWith('}')) {
          try {
            const command = JSON.parse(jsonText);
            const action = String(command?.action || '').trim().toLowerCase();
            if (ACTIONS.has(action)) { command.action = action; return { command, raw: jsonText, index }; }
          } catch {}
        }
      }
      index = text.indexOf(PREFIX, index + PREFIX.length);
    }
    return null;
  }

  function assistantNodes(answerApi) {
    try {
      const nodes = answerApi?.assistantNodes?.();
      return Array.isArray(nodes) ? nodes : [];
    } catch {
      return [];
    }
  }

  function assistantTurn(node) {
    try {
      return node?.closest?.('[data-message-author-role="assistant"], [data-role="assistant"], [data-message-author="assistant"], .agent-turn') || null;
    } catch {
      return null;
    }
  }

  function latestCandidateText(answerApi) {
    let projected = '';
    try { projected = String(answerApi?.latestAssistantText?.() || ''); }
    catch {}
    if (parseTrailingCommand(projected)) return projected;

    const nodes = assistantNodes(answerApi);
    const latest = nodes[nodes.length - 1];
    if (!latest) return projected;
    const latestTurn = assistantTurn(latest);
    const latestRaw = String(latest?.innerText || latest?.textContent || '').trim();
    if (!latestTurn) return parseTrailingCommand(latestRaw) ? latestRaw : projected;
    for (let index = nodes.length - 1, scanned = 0; index >= 0 && scanned < 8; index -= 1, scanned += 1) {
      const node = nodes[index];
      if (assistantTurn(node) !== latestTurn) break;
      const raw = String(node?.innerText || node?.textContent || '').trim();
      if (parseTrailingCommand(raw)) return raw;
    }
    return projected;
  }

  function nodeCount(answerApi) {
    return assistantNodes(answerApi).length;
  }

  function commandReady(active, stableMs) {
    return !active && stableMs >= SETTLED_MS;
  }

  let timer = null;
  let lastFingerprint = '';
  let candidateFingerprint = '';
  let candidateSince = 0;

  function schedule(delay = 900) {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      sample();
    }, delay);
  }

  function generationActive(runtime) {
    try { return !!globalThis[runtime?.input]?.generationLooksActive?.(); }
    catch { return false; }
  }

  function resetCandidate() {
    candidateFingerprint = '';
    candidateSince = 0;
  }

  function sample() {
    const runtime = providerRuntime();
    if (!runtime) return;
    const answerApi = globalThis[runtime.answer];
    const text = latestCandidateText(answerApi);
    const parsed = parseTrailingCommand(text);
    if (!parsed) {
      resetCandidate();
      return;
    }

    const fingerprint = `${runtime.id}:${nodeCount(answerApi)}:${parsed.raw}`;
    const observedAt = Date.now();
    if (fingerprint !== candidateFingerprint) {
      candidateFingerprint = fingerprint;
      candidateSince = observedAt;
      schedule(SETTLED_MS);
      return;
    }

    const stableMs = Math.max(0, observedAt - candidateSince);
    if (!commandReady(generationActive(runtime), stableMs)) {
      schedule(500);
      return;
    }
    if (fingerprint === lastFingerprint) return;

    lastFingerprint = fingerprint;
    resetCandidate();
    try {
      const result = chrome.runtime.sendMessage({
        type: 'dex_provider_command',
        providerId: runtime.id,
        command: parsed.command
      });
      result?.catch?.(() => {});
    } catch {}
  }

  if (typeof chrome !== 'undefined' && chrome.runtime) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type !== 'dex_provider_control_ping') return;
      sendResponse({ ok: true, adapter: 'dex-provider-control' });
      return true;
    });
  }

  if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
    const start = () => {
      if (!document.body) return setTimeout(start, 100);
      const observer = new MutationObserver(() => schedule());
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['aria-busy']
      });
      schedule(250);
    };
    start();
  }

  const api = {
    PREFIX,
    ACTIONS,
    PROVIDERS,
    SETTLED_MS,
    providerRuntime,
    insideFence,
    ignorableUiSuffix,
    parseTrailingCommand,
    assistantNodes,
    assistantTurn,
    latestCandidateText,
    commandReady
  };
  if (typeof window !== 'undefined') globalThis.BrowserAiBridgeDexProviderControlContent = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
