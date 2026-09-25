(() => {
  if (typeof window !== 'undefined' && globalThis.__browserAiBridgeDexProviderControlLoaded) return;
  if (typeof window !== 'undefined') globalThis.__browserAiBridgeDexProviderControlLoaded = true;

  const PREFIX = '[[DEX:CMD ';
  const DIL_TURN_SELECTOR = '[data-chatgpt-selection-message-id]:has([class*="DilResponseRoot"])';
  const ACTIONS = new Set(['help', 'onboard', 'checkpoint', 'read_checkpoint', 'rooms', 'targets', 'create_room', 'use_room', 'status', 'rename_room', 'configure_room', 'rename_self', 'set_self_relay', 'rename_agent', 'set_agent_relay', 'remove_agent', 'stop_relay', 'continue_relay', 'clear_chat', 'delete_room', 'add_agent', 'spawn_agent', 'despawn_agent', 'send', 'handoff_room', 'reload_extension', 'watch_done', 'unwatch_done',
    'arm_post_idle', 'post_idle_status', 'cancel_post_idle', 'report_post_idle']);
  const PROVIDERS = [
    { id: 'deepseek', answer: 'BrowserAiBridgeDeepSeekAnswer', input: 'BrowserAiBridgeDeepSeekInput' },
    { id: 'grok', answer: 'BrowserAiBridgeGrokAnswer', input: 'BrowserAiBridgeGrokInput' },
    { id: 'claude', answer: 'BrowserAiBridgeClaudeAnswer', input: 'BrowserAiBridgeClaudeInput' },
    { id: 'chatgpt', answer: 'BrowserAiBridgeChatGptAnswer', input: 'BrowserAiBridgeChatGptInput' },
    { id: 'gemini', answer: 'BrowserAiBridgeGeminiAnswer', input: 'BrowserAiBridgeGeminiInput' },
    { id: 'muse', answer: 'BrowserAiBridgeMuseAnswer', input: 'BrowserAiBridgeMuseInput' }
  ];
  const SETTLED_MS = 450, MALFORMED_SETTLED_MS = 1800;

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


  const MALFORMED_CODES = new Set([
    'MALFORMED_DELIMITERS', 'MISSING_CLOSER', 'INCOMPLETE_MARKER',
    'INCOMPLETE_JSON', 'INVALID_JSON', 'UNKNOWN_ACTION', 'TRAILING_TEXT'
  ]);
  function malformedTrailingCommand(value) {
    const lines = String(value || '').trim().split(/\r?\n/);
    const ui = /^(copy|copy response|good response|bad response|read aloud|share|more|retry|regenerate|edit|edit message)$/i;
    while (lines.length && ui.test(lines.at(-1).trim())) lines.pop();
    let start = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (/\[\s*(?:\[\s*)?DEX\s*:\s*CMD\b/i.test(lines[i]) && !/^\s*>/.test(lines[i])) { start = i; break; }
    }
    if (start < 0) return null;
    const prior = lines.slice(0, start).join('\n');
    const markerAt = lines[start].search(/\[\s*(?:\[\s*)?DEX\s*:\s*CMD\b/i);
    const offset = prior.length + (start ? 1 : 0) + markerAt;
    if (insideFence(lines.join('\n'), offset)) return null;
    const raw = [lines[start].slice(markerAt), ...lines.slice(start + 1)].join('\n').trim();
    if (raw.length > 8192) return null;
    if (!raw.startsWith(PREFIX)) return { code: 'MALFORMED_DELIMITERS', raw };
    if (raw.includes(']]') && !raw.endsWith(']]')) return { code: 'TRAILING_TEXT', raw };
    const closed = raw.endsWith(']]');
    const inner = raw.slice(PREFIX.length, closed ? -2 : undefined).trim();
    if (!inner.startsWith('{')) return { code: 'INCOMPLETE_MARKER', raw };
    const candidate = closed ? inner : inner.replace(/\]+$/, '').trim();
    let command;
    try { command = JSON.parse(candidate); }
    catch { return { code: closed ? 'INVALID_JSON' : 'INCOMPLETE_JSON', raw }; }
    if (!ACTIONS.has(String(command?.action || '').trim().toLowerCase())) {
      return { code: 'UNKNOWN_ACTION', raw };
    }
    return closed ? null : { code: 'MISSING_CLOSER', raw };
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
      return node?.closest?.(`[data-message-author-role="assistant"], [data-role="assistant"], [data-message-author="assistant"], .agent-turn, ${DIL_TURN_SELECTOR}`) || null;
    } catch {
      return null;
    }
  }

  function latestCandidateText(answerApi) {
    let projected = '';
    try { projected = String(answerApi?.latestAssistantText?.() || ''); }
    catch {}
    if (parseTrailingCommand(projected) || malformedTrailingCommand(projected)) return projected;

    const nodes = assistantNodes(answerApi);
    const latest = nodes[nodes.length - 1];
    if (!latest) return projected;
    const latestTurn = assistantTurn(latest);
    const latestRaw = String(latest?.innerText || latest?.textContent || '').trim();
    if (!latestTurn) return (parseTrailingCommand(latestRaw) || malformedTrailingCommand(latestRaw)) ? latestRaw : projected;
    for (let index = nodes.length - 1, scanned = 0; index >= 0 && scanned < 8; index -= 1, scanned += 1) {
      const node = nodes[index];
      if (assistantTurn(node) !== latestTurn) break;
      const raw = String(node?.innerText || node?.textContent || '').trim();
      if (parseTrailingCommand(raw) || malformedTrailingCommand(raw)) return raw;
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
  const turnIdentities = new WeakMap();
  const dispatchedTurns = new Map();
  let nextTurnIdentity = 0;
  let lastDuplicateKey = '';
  let repairOriginTurn = '';
  const MAX_DISPATCHED_TURNS = 256;
  const telemetry = { samples: 0, lastScanAt: null, assistantNodes: 0, phase: 'boot', candidateAction: null, dispatchedAt: null, duplicateTurnsSuppressed: 0, malformedDetected: 0, nudgesSent: 0, nudgesSuppressed: 0, lastMalformedCode: null, lastError: null };

  // Use the stable DIL message ID instead of the changing content-block count.
  function commandIdentity(answerApi, parsed = null) {
    const nodes = assistantNodes(answerApi);
    const latest = nodes[nodes.length - 1];
    if (!latest) return `unscoped:${controlHash(parsed?.raw || '')}`;
    const turn = assistantTurn(latest) || latest;
    const stableId = turn.getAttribute?.('data-chatgpt-selection-message-id')
      || turn.getAttribute?.('data-message-id');
    if (stableId) return `message:${stableId}`;
    if (!turnIdentities.has(turn)) turnIdentities.set(turn, `dom:${++nextTurnIdentity}`);
    return turnIdentities.get(turn);
  }

  function controlHash(value) {
    let hash = 2166136261;
    for (const character of String(value || '')) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function rememberDispatch(key, observedAt) {
    dispatchedTurns.set(key, observedAt);
    while (dispatchedTurns.size > MAX_DISPATCHED_TURNS) dispatchedTurns.delete(dispatchedTurns.keys().next().value);
  }

  function diagnostics() { return { ...telemetry }; }

  function schedule(delay = 900) {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      sample();
    }, delay);
  }

  function generationActive(runtime) {
    try {
      const visibleGeneration = !!globalThis[runtime?.input]?.generationLooksActive?.();
      return visibleGeneration || (runtime?.id === 'chatgpt'
        && !!globalThis.BrowserAiBridgeChatGptRuntime?.responsePending?.());
    } catch { return false; }
  }

  function resetCandidate() {
    candidateFingerprint = '';
    candidateSince = 0;
  }

  function sample() {
    telemetry.samples += 1;
    telemetry.lastScanAt = Date.now();
    const runtime = providerRuntime();
    if (!runtime) { telemetry.phase = 'adapter-unavailable'; return; }
    const answerApi = globalThis[runtime.answer];
    telemetry.assistantNodes = nodeCount(answerApi);
    const text = latestCandidateText(answerApi);
    const parsed = parseTrailingCommand(text);
    const malformed = parsed ? null : malformedTrailingCommand(text);
    if (runtime.id === 'chatgpt' && globalThis.BrowserAiBridgeChatGptReturn?.isNotificationReply?.(answerApi, text)) {
      telemetry.phase = 'notification-command-suppressed'; resetCandidate(); return;
    }
    telemetry.candidateAction = parsed?.command?.action || null;
    if (!parsed && !malformed) {
      telemetry.phase = telemetry.assistantNodes ? 'no-trailing-command' : 'no-assistant-nodes';
      resetCandidate();
      return;
    }

    const turnKey = `${runtime.id}:${commandIdentity(answerApi, parsed || malformed)}`;
    const fingerprint = malformed ? `${turnKey}:invalid:${malformed.code}:${controlHash(malformed.raw)}` : `${turnKey}:${parsed.raw}`;
    const observedAt = Date.now();
    if (dispatchedTurns.has(turnKey)) {
      telemetry.phase = 'duplicate-suppressed';
      if (lastDuplicateKey !== turnKey) {
        telemetry.duplicateTurnsSuppressed += 1;
        lastDuplicateKey = turnKey;
      }
      return;
    }
    if (fingerprint !== candidateFingerprint) {
      telemetry.phase = 'stabilizing';
      candidateFingerprint = fingerprint;
      candidateSince = observedAt;
      schedule(malformed ? MALFORMED_SETTLED_MS : SETTLED_MS);
      return;
    }

    const stableMs = Math.max(0, observedAt - candidateSince);
    if (!commandReady(generationActive(runtime), stableMs) || (malformed && stableMs < MALFORMED_SETTLED_MS)) {
      telemetry.phase = 'waiting-for-idle';
      schedule(500);
      return;
    }
    if (fingerprint === lastFingerprint) { telemetry.phase = 'duplicate-suppressed'; return; }

    lastFingerprint = fingerprint;

    if (malformed) {
      telemetry.malformedDetected += 1;
      telemetry.lastMalformedCode = malformed.code;
      rememberDispatch(turnKey, observedAt);
      resetCandidate();
      // A nudge follow-up may execute a corrected marker, but cannot nudge again.
      if (repairOriginTurn && repairOriginTurn !== turnKey) {
        repairOriginTurn = '';
        telemetry.nudgesSuppressed += 1;
        telemetry.phase = 'repair-followup-suppressed';
        return;
      }
      repairOriginTurn = turnKey;
      try {
        const result = chrome.runtime.sendMessage({
          type: 'dex_provider_command_malformed', providerId: runtime.id,
          clientActionId: turnKey, code: malformed.code
        });
        telemetry.nudgesSent += 1;
        telemetry.phase = 'repair-nudge-handed-to-background';
        result?.catch?.((error) => {
          telemetry.phase = 'repair-nudge-background-rejected';
          telemetry.lastError = String(error?.message || error).slice(0, 160);
        });
      } catch (error) {
        telemetry.phase = 'repair-nudge-background-failed';
        telemetry.lastError = String(error?.message || error).slice(0, 160);
      }
      return;
    }
    if (repairOriginTurn && repairOriginTurn !== turnKey) repairOriginTurn = '';
    rememberDispatch(turnKey, observedAt);
    resetCandidate();
    try {
      const result = chrome.runtime.sendMessage({
        type: 'dex_provider_command',
        providerId: runtime.id,
        clientActionId: turnKey,
        command: parsed.command
      });
      telemetry.phase = 'handed-to-background';
      telemetry.dispatchedAt = Date.now();
      telemetry.lastError = null;
      result?.catch?.((error) => {
        telemetry.phase = 'background-send-rejected';
        telemetry.lastError = String(error?.message || error).slice(0, 160);
      });
    } catch (error) {
      telemetry.phase = 'background-send-failed';
      telemetry.lastError = String(error?.message || error).slice(0, 160);
    }
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
    DIL_TURN_SELECTOR,
    ACTIONS,
    PROVIDERS,
    SETTLED_MS,
    providerRuntime,
    insideFence,
    ignorableUiSuffix,
    parseTrailingCommand,
    malformedTrailingCommand,
    MALFORMED_CODES,
    MALFORMED_SETTLED_MS,
    assistantNodes,
    assistantTurn,
    latestCandidateText,
    commandIdentity,
    diagnostics,
    commandReady
  };
  if (typeof window !== 'undefined') globalThis.BrowserAiBridgeDexProviderControlContent = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
