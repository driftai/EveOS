(() => {
  if (typeof window !== 'undefined' && globalThis.__browserAiBridgeChatGptPageStateLoaded) return;
  if (typeof window !== 'undefined') globalThis.__browserAiBridgeChatGptPageStateLoaded = true;

  const STATUS_ONLY_RE = /^(?:thinking|working|searching(?: the web)?|browsing|reading|analyzing|reasoning|generating|loading|preparing)(?:\s*(?:\.{1,3}|…))?(?:\s+for\s+\d+(?:\.\d+)?\s*(?:ms|s|sec(?:onds?)?|m|min(?:utes?)?))?$/i;
  const ELAPSED_STATUS_RE = /^(?:worked|thought|reasoned|searched|browsed)\s+for\s+\d+(?:\.\d+)?\s*(?:ms|s|sec(?:onds?)?|m|min(?:utes?)?)$/i;

  function transientStatusLine(value) {
    const line = String(value || '').replace(/^[\s•●○◆▶►▸]+/u, '').trim();
    if (!line || line.length > 120) return false;
    return STATUS_ONLY_RE.test(line) || ELAPSED_STATUS_RE.test(line);
  }

  function substantiveAssistantText(value) {
    const lines = String(value || '').replace(/\r/g, '').replace(/\u00a0/g, ' ').split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    while (lines.length && transientStatusLine(lines[0])) lines.shift();
    while (lines.length && transientStatusLine(lines[lines.length - 1])) lines.pop();
    return lines.join('\n').trim();
  }


  const CONNECTION_GRACE_MS = 60 * 1000;
  const SURFACE_SELECTORS = [
    '[role="alert"]',
    '[aria-live="assertive"]',
    '[data-testid*="error" i]',
    '[data-testid*="toast" i]',
    '[data-testid*="warning" i]',
    '[data-testid*="notice" i]'
  ];
  const HIGH_CONFIDENCE_TEXT = /(connection interrupted|network error|lost connection|unable to connect|reconnect(?:ing)?|maximum length for this conversation|conversation (?:is |has )?(?:too long|reached)|start a new chat to continue|unable to load conversation|conversation not found|error generating (?:a )?response|something went wrong|too many requests|rate limit|usage limit|session expired|sign in to continue|log in to continue)/i;

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function visible(element) {
    if (!element) return false;
    if (typeof getComputedStyle === 'undefined') return true;
    try {
      const style = getComputedStyle(element);
      const unrendered = (typeof document !== 'undefined' && !!document.hidden)
        || (typeof window !== 'undefined' && (window.outerWidth === 0 || window.outerHeight === 0));
      const rect = element.getBoundingClientRect?.();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && (unrendered || style.opacity !== '0')
        && (unrendered || !rect || (rect.width > 0 && rect.height > 0));
    } catch {
      return true;
    }
  }

  function classifyIssueText(value, { trustedSurface = false } = {}) {
    const providerText = normalizeText(value);
    if (!providerText || providerText.length > 900) return null;
    const lower = providerText.toLowerCase();

    if (/maximum length for this conversation|conversation (?:is |has )?(?:too long|reached (?:its|the) (?:maximum )?length)|start a new chat to continue|conversation.*context.*limit/.test(lower)) {
      return {
        code: 'CHATGPT_CONVERSATION_LIMIT',
        category: 'conversation_limit',
        terminal: true,
        retryable: false,
        rebindRecommended: true,
        providerText,
        message: 'ChatGPT reports that this conversation reached its limit. Open a replacement ChatGPT chat, then Edit this Dex participant and rebind it to the new chat; the Dex room history can continue.'
      };
    }

    if (/unable to load conversation|conversation not found|failed to load conversation|conversation is unavailable/.test(lower)) {
      return {
        code: 'CHATGPT_CONVERSATION_UNAVAILABLE',
        category: 'conversation_unavailable',
        terminal: true,
        retryable: false,
        rebindRecommended: true,
        providerText,
        message: 'ChatGPT can no longer use this conversation. Open an available replacement chat and rebind this Dex participant to it.'
      };
    }

    if (/connection interrupted|network error|lost connection|unable to connect|connection (?:was )?lost|reconnect(?:ing)?/.test(lower)) {
      return {
        code: 'CHATGPT_CONNECTION_INTERRUPTED',
        category: 'connection',
        terminal: false,
        graceMs: CONNECTION_GRACE_MS,
        retryable: true,
        rebindRecommended: false,
        providerText,
        message: 'ChatGPT reported a connection interruption that did not recover within the bridge grace period.'
      };
    }

    if (/too many requests|rate limit|usage limit|you(?:'|’)ve reached .* limit|limit .* reached|try again after|limit resets/.test(lower)) {
      return {
        code: 'CHATGPT_RATE_LIMIT',
        category: 'rate_limit',
        terminal: true,
        retryable: true,
        rebindRecommended: false,
        providerText,
        message: `ChatGPT rejected this turn because of a usage or rate limit: ${providerText}`
      };
    }

    if (/session expired|sign in to continue|log in to continue|authentication (?:failed|error)|unauthorized/.test(lower)) {
      return {
        code: 'CHATGPT_AUTH_REQUIRED',
        category: 'auth',
        terminal: true,
        retryable: true,
        rebindRecommended: false,
        providerText,
        message: `ChatGPT requires account/session attention before the bridge can continue: ${providerText}`
      };
    }

    if (/there was an error generating a response|error generating (?:a )?response|failed to generate|something went wrong|internal server error|server error/.test(lower)) {
      return {
        code: 'CHATGPT_RESPONSE_FAILED',
        category: 'generation',
        terminal: true,
        retryable: true,
        rebindRecommended: false,
        providerText,
        message: `ChatGPT reported a response-generation failure: ${providerText}`
      };
    }

    if (/request .* (?:blocked|flagged)|message .* blocked|unable to respond .* policy|violat(?:es|ed|ion).*policy/.test(lower)) {
      return {
        code: 'CHATGPT_REQUEST_BLOCKED',
        category: 'request_blocked',
        terminal: true,
        retryable: false,
        rebindRecommended: false,
        providerText,
        message: `ChatGPT blocked this request: ${providerText}`
      };
    }

    if (trustedSurface && /\b(error|failed|unable|problem|interrupted|limit|warning)\b/.test(lower)) {
      return {
        code: 'CHATGPT_PROVIDER_ERROR',
        category: 'provider',
        terminal: true,
        retryable: true,
        rebindRecommended: false,
        providerText,
        message: `ChatGPT reported an error: ${providerText}`
      };
    }

    return null;
  }

  function isInsideUserMessage(element) {
    return !!element?.closest?.('[data-message-author-role="user"], [data-role="user"]');
  }

  function collectCandidates(root = typeof document !== 'undefined' ? document : null) {
    const candidates = new Map();
    if (!root?.querySelectorAll) return candidates;
    for (const selector of SURFACE_SELECTORS) {
      for (const element of root.querySelectorAll(selector)) {
        if (visible(element) && !isInsideUserMessage(element)) candidates.set(element, true);
      }
    }
    for (const element of root.querySelectorAll('div, span, p')) {
      if (!visible(element) || isInsideUserMessage(element)) continue;
      const text = normalizeText(element.innerText || element.textContent);
      if (text.length <= 320 && HIGH_CONFIDENCE_TEXT.test(text)) candidates.set(element, candidates.get(element) || false);
    }
    return candidates;
  }

  function issueSnapshot(root) {
    const snapshot = new Map();
    for (const [element, trustedSurface] of collectCandidates(root)) {
      const text = normalizeText(element.innerText || element.textContent);
      if (classifyIssueText(text, { trustedSurface })) snapshot.set(element, text);
    }
    return snapshot;
  }

  function findChangedIssue(snapshot = new Map(), root) {
    const found = [];
    for (const [element, trustedSurface] of collectCandidates(root)) {
      const text = normalizeText(element.innerText || element.textContent);
      if (!text || snapshot.get(element) === text) continue;
      const issue = classifyIssueText(text, { trustedSurface });
      if (!issue) continue;
      found.push({
        ...issue,
        fingerprint: `${issue.code}:${text.toLowerCase()}`,
        element
      });
    }
    found.sort((a, b) => Number(b.terminal) - Number(a.terminal) || a.providerText.length - b.providerText.length);
    return found[0] || null;
  }

  const api = {
    CONNECTION_GRACE_MS,
    transientStatusLine, substantiveAssistantText,
    normalizeText,
    visible,
    classifyIssueText,
    issueSnapshot,
    findChangedIssue
  };

  if (typeof window !== 'undefined') globalThis.BrowserAiBridgeChatGptPageState = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();