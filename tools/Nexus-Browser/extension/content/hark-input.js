(() => {
  if (typeof window !== 'undefined' && globalThis.__browserAiBridgeHarkInputLoaded) return;
  if (typeof window !== 'undefined') globalThis.__browserAiBridgeHarkInputLoaded = true;

  function visible(element) {
    if (!element) return false;
    if (typeof getComputedStyle === 'undefined') return true;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect?.();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0'
      && (!rect || (rect.width > 0 && rect.height > 0));
  }

  function normalized(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  const HUMAN_SUBMISSION_TTL_MS = 5 * 60 * 1000;
  const MAX_HUMAN_SUBMISSIONS = 32;
  const humanSubmissions = [];
  let submissionTrackingInstalled = false;

  function submissionFingerprint(value) {
    const text = normalized(value);
    let first = 2166136261, second = 2246822507;
    for (const character of text) {
      const code = character.charCodeAt(0);
      first = Math.imul(first ^ code, 16777619);
      second = Math.imul(second ^ code, 3266489909);
    }
    return `${text.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
  }

  function pruneHumanSubmissions(at = Date.now()) {
    while (humanSubmissions.length && at - humanSubmissions[0].at > HUMAN_SUBMISSION_TTL_MS) humanSubmissions.shift();
  }

  function rememberHumanSubmission(value, at = Date.now()) {
    const text = normalized(value);
    if (!text || text.length > 65536) return false;
    pruneHumanSubmissions(at);
    const fingerprint = submissionFingerprint(text);
    const existing = humanSubmissions.find((entry) => entry.fingerprint === fingerprint && entry.text === text);
    if (existing) existing.at = at;
    else humanSubmissions.push({ fingerprint, text, at });
    while (humanSubmissions.length > MAX_HUMAN_SUBMISSIONS) humanSubmissions.shift();
    return true;
  }

  function wasHumanSubmittedText(value, at = Date.now()) {
    const text = normalized(value);
    if (!text) return false;
    pruneHumanSubmissions(at);
    const fingerprint = submissionFingerprint(text);
    return humanSubmissions.some((entry) => entry.fingerprint === fingerprint && entry.text === text);
  }

  function composerMetadata(element) {
    if (!element) return '';
    return [
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('placeholder'),
      element.getAttribute?.('data-testid'),
      element.getAttribute?.('name'),
      element.getAttribute?.('role'),
      element.className
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function composerScore(element) {
    if (!element || !visible(element) || element.disabled || element.getAttribute?.('aria-disabled') === 'true') return -1000;
    const meta = composerMetadata(element);
    if (/\b(search|filter|rename|title)\b/.test(meta)) return -500;
    let score = 0;
    if (/\b(message|prompt|ask|chat|composer)\b/.test(meta)) score += 120;
    if (element.matches?.('textarea')) score += 55;
    if (element.matches?.('[contenteditable="true"][role="textbox"]')) score += 60;
    if (element.matches?.('.ProseMirror[contenteditable="true"]')) score += 45;
    if (element.closest?.('form')) score += 20;
    const rect = element.getBoundingClientRect?.();
    if (rect && rect.width >= 240) score += 20;
    return score;
  }

  function findComposer() {
    const selectors = [
      '[data-testid*="composer" i] textarea',
      '[data-testid*="prompt" i] textarea',
      'textarea[placeholder*="message" i]',
      'textarea[placeholder*="prompt" i]',
      'textarea[placeholder*="ask" i]',
      '[contenteditable="true"][role="textbox"]',
      '.ProseMirror[contenteditable="true"]',
      'textarea',
      '[contenteditable="true"]'
    ];
    const seen = new Set();
    const candidates = [];
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        if (seen.has(node)) continue;
        seen.add(node);
        candidates.push({ node, score: composerScore(node) });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates.find((entry) => entry.score > 0)?.node || null;
  }

  function composerText(composer) {
    if (!composer) return '';
    const tag = String(composer.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'INPUT') return String(composer.value || '');
    return String(composer.innerText || composer.textContent || '');
  }

  function setComposerText(composer, text) {
    if (!composer) throw new Error('Hark composer is missing.');
    composer.focus?.();
    const tag = String(composer.tagName || '').toUpperCase();
    const isTextControl = tag === 'TEXTAREA' || tag === 'INPUT';
    if (isTextControl) {
      const proto = Object.getPrototypeOf(composer);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(composer, text);
      else composer.value = text;
      if (composer._valueTracker) {
        try { composer._valueTracker.setValue(''); } catch {}
      }
      try {
        composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      } catch {
        composer.dispatchEvent(new Event('input', { bubbles: true }));
      }
      composer.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    if (!composer.isContentEditable) throw new Error('Unsupported Hark composer element.');
    const range = document.createRange();
    range.selectNodeContents(composer);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    let inserted = false;
    try { inserted = document.execCommand('insertText', false, text); } catch {}
    if (!inserted) composer.textContent = text;
    try {
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    } catch {
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    }
    composer.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function composerContainsText(composer, text) {
    const wanted = normalized(text);
    const actual = normalized(composerText(composer));
    return !!wanted && (actual === wanted || actual.includes(wanted));
  }

  function controlMetadata(control) {
    if (!control) return '';
    return [
      control.getAttribute?.('aria-label'),
      control.getAttribute?.('data-testid'),
      control.getAttribute?.('name'),
      control.getAttribute?.('type'),
      control.getAttribute?.('title'),
      control.className,
      control.textContent
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function sendControlScore(control, scope) {
    if (!control || !visible(control) || control.disabled || control.getAttribute?.('aria-disabled') === 'true') return -1000;
    const meta = controlMetadata(control);
    if (/\b(stop|cancel|mic|microphone|voice|audio|record|attach|upload|image|file)\b/.test(meta)) return -1000;
    let score = 0;
    if (/\bsend message\b/.test(meta)) score += 260;
    else if (/\b(send|submit)\b/.test(meta)) score += 180;
    if (/send/.test(String(control.getAttribute?.('data-testid') || '').toLowerCase())) score += 160;
    if (String(control.getAttribute?.('type') || '').toLowerCase() === 'submit') score += 90;
    if (scope && scope.contains?.(control)) score += 25;
    return score;
  }

  function findSendControl(composer) {
    if (!composer) return null;
    const scope = composer.closest?.('form')
      || composer.closest?.('[data-testid*="composer" i]')
      || composer.parentElement?.parentElement
      || document;
    const selectors = [
      'button[data-testid*="send" i]',
      '[role="button"][data-testid*="send" i]',
      'button[aria-label*="send" i]',
      '[role="button"][aria-label*="send" i]',
      'button[title*="send" i]',
      'button[type="submit"]',
      '[role="button"]'
    ];
    const seen = new Set();
    const candidates = [];
    for (const selector of selectors) {
      for (const control of scope.querySelectorAll?.(selector) || []) {
        if (seen.has(control)) continue;
        seen.add(control);
        candidates.push({ control, score: sendControlScore(control, scope) });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates.find((entry) => entry.score >= 90)?.control || null;
  }

  function recordTrustedSubmission(event, { composer = null, sendControl = null, at = Date.now() } = {}) {
    if (event?.isTrusted !== true) return false;
    const activeComposer = composer || findComposer();
    if (!activeComposer) return false;
    const target = event.target || null;
    const insideComposer = target === activeComposer || !!activeComposer.contains?.(target);
    let committed = false;
    if (event.type === 'keydown') {
      committed = event.key === 'Enter' && event.shiftKey !== true && insideComposer;
    } else if (event.type === 'click') {
      const control = sendControl || findSendControl(activeComposer);
      committed = !!control && (target === control || !!control.contains?.(target));
    } else if (event.type === 'submit') {
      const form = activeComposer.closest?.('form');
      committed = !!form && (target === form || !!target?.contains?.(activeComposer));
    }
    return committed && rememberHumanSubmission(composerText(activeComposer), at);
  }

  function installHumanSubmissionTracking(root = typeof document === 'undefined' ? null : document) {
    if (submissionTrackingInstalled || !root?.addEventListener) return false;
    submissionTrackingInstalled = true;
    const capture = (event) => { recordTrustedSubmission(event); };
    root.addEventListener('keydown', capture, true);
    root.addEventListener('click', capture, true);
    root.addEventListener('submit', capture, true);
    return true;
  }

  function generationLooksActive() {
    const busy = [
      '[aria-busy="true"]',
      '[data-generating="true"]',
      '[data-streaming="true"]',
      '[data-is-streaming="true"]'
    ].some((selector) => [...document.querySelectorAll(selector)].some(visible));
    if (busy) return true;
    const controls = [...document.querySelectorAll('button, [role="button"]')].filter(visible);
    return controls.some((control) => /\b(stop generating|stop response|cancel generation|stop)\b/i.test(controlMetadata(control)));
  }

  const api = {
    visible,
    normalized,
    composerMetadata,
    composerScore,
    findComposer,
    composerText,
    setComposerText,
    composerContainsText,
    submissionFingerprint,
    rememberHumanSubmission,
    wasHumanSubmittedText,
    recordTrustedSubmission,
    installHumanSubmissionTracking,
    controlMetadata,
    sendControlScore,
    findSendControl,
    generationLooksActive
  };

  installHumanSubmissionTracking();

  if (typeof window !== 'undefined') globalThis.BrowserAiBridgeHarkInput = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
