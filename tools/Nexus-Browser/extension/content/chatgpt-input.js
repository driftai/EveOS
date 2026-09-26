(() => {
  if (typeof window !== 'undefined' && globalThis.__browserAiBridgeChatGptInputLoaded) return;
  if (typeof window !== 'undefined') globalThis.__browserAiBridgeChatGptInputLoaded = true;

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

  function composerSelectors() {
    return [
      '#prompt-textarea[contenteditable="true"]',
      'div#prompt-textarea.ProseMirror[contenteditable="true"]',
      'textarea[name="prompt-textarea"]',
      'textarea[name="prompt"]',
      '[contenteditable="true"][role="textbox"][aria-label*="ChatGPT" i]',
      'div.ProseMirror[contenteditable="true"][role="textbox"]'
    ];
  }

  function usableComposer(element) {
    if (!element || !visible(element)) return false;
    const tag = String(element.tagName || '').toUpperCase();
    return tag === 'TEXTAREA' || tag === 'INPUT' || !!element.isContentEditable;
  }

  function findComposer() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null;
    for (const selector of composerSelectors()) {
      const match = [...document.querySelectorAll(selector)].find(usableComposer);
      if (match) return match;
    }
    return null;
  }

  function composerText(composer) {
    if (!composer) return '';
    const tag = String(composer.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'INPUT') return String(composer.value || '');
    return String(composer.innerText || composer.textContent || '');
  }

  function setNativeValue(element, value) {
    const proto = Object.getPrototypeOf(element);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
  }

  function emitInput(element, text) {
    try {
      element.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text
      }));
    } catch {}
    try {
      element.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text
      }));
    } catch {
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setComposerText(composer, text) {
    if (!composer) throw new Error('ChatGPT composer is missing.');
    composer.focus();
    const tag = String(composer.tagName || '').toUpperCase();

    if (tag === 'TEXTAREA' || tag === 'INPUT') {
      setNativeValue(composer, text);
      emitInput(composer, text);
      return;
    }

    if (!composer.isContentEditable) throw new Error('Unsupported ChatGPT composer element.');
    const range = document.createRange();
    range.selectNodeContents(composer);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    let inserted = false;
    try { inserted = document.execCommand('insertText', false, text); } catch {}
    if (!inserted || !normalized(composerText(composer)).includes(normalized(text))) {
      composer.textContent = text;
    }
    emitInput(composer, text);
  }

  function normalized(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function composerContainsText(composer, text) {
    const wanted = normalized(text);
    const actual = normalized(composerText(composer));
    return !!wanted && (actual === wanted || actual.includes(wanted));
  }

  function controlMetadata(control) {
    if (!control) return '';
    return [
      control.id,
      control.getAttribute?.('aria-label'),
      control.getAttribute?.('data-testid'),
      control.getAttribute?.('name'),
      control.getAttribute?.('type'),
      control.getAttribute?.('title'),
      control.className,
      control.textContent
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function isDisabledControl(control) {
    return !!control?.disabled || control?.getAttribute?.('aria-disabled') === 'true';
  }

  function isUnsafeSendControl(control) {
    const meta = controlMetadata(control);
    return /\b(mic|microphone|voice|audio|record|dictat\w*|speech|listen|attach|upload|camera)\b/.test(meta);
  }

  function sendControlScore(control) {
    if (!control || isDisabledControl(control) || isUnsafeSendControl(control)) return -1000;
    const id = String(control.id || '').toLowerCase();
    const aria = String(control.getAttribute?.('aria-label') || '').trim().toLowerCase();
    const testId = String(control.getAttribute?.('data-testid') || '').trim().toLowerCase();
    const type = String(control.getAttribute?.('type') || '').trim().toLowerCase();
    let score = 0;
    if (id === 'composer-submit-button') score += 300;
    if (testId === 'send-button') score += 280;
    else if (testId.endsWith('send-button')) score += 230;
    else if (testId.includes('send')) score += 120;
    if (aria === 'send prompt') score += 260;
    else if (aria === 'send message') score += 240;
    else if (/\bsend\b/.test(aria)) score += 150;
    if (type === 'submit') score += 40;
    if (control.matches?.('button, [role="button"]')) score += 10;
    return score;
  }

  function findSendControl(composer) {
    // Real form ownership is authoritative. Form-less ChatGPT places Send in an
    // outer sibling action bar, so walk bounded ancestors instead of document.
    // A second visible editor at any wider scope is an ownership ambiguity.
    if (!composer) return null;
    const form = composer.closest?.('form');
    const selectors = [
      '#composer-submit-button',
      'button[data-testid="send-button"]',
      'button[data-testid$="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Send"]',
      'button.composer-submit-btn'
    ];
    function otherEditorIn(scope) {
      const editors = [...(scope?.querySelectorAll?.('input, textarea, [contenteditable="true"]') || [])]
        .filter(usableComposer);
      return editors.some((editor) => editor !== composer
        && !composer.contains?.(editor) && !editor.contains?.(composer));
    }
    function scopedControl(scope) {
      if (!scope?.querySelectorAll) return null;
      for (const selector of selectors) {
        const matches = [...scope.querySelectorAll(selector)]
          .filter(visible)
          .map((control) => ({ control, score: sendControlScore(control) }))
          .filter((entry) => entry.score >= 100)
          .sort((a, b) => b.score - a.score);
        if (matches[0]) return matches[0].control;
      }
      const candidates = [...scope.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .map((control) => ({ control, score: sendControlScore(control) }))
        .filter((entry) => entry.score >= 100)
        .sort((a, b) => b.score - a.score);
      return candidates[0]?.control || null;
    }
    if (form) return otherEditorIn(form) ? null : scopedControl(form);
    for (let scope = composer, depth = 0; scope && depth <= 7; scope = scope.parentElement, depth++) {
      if (String(scope.tagName || '').toUpperCase() === 'BODY'
          || (typeof document !== 'undefined' && scope === document.body)) break;
      if (scope !== composer && otherEditorIn(scope)) return null;
      const control = scopedControl(scope);
      if (control) return control;
    }
    return null;
  }

  function generationLooksActive(root = document) {
    const assistantBusy = '[data-message-author-role="assistant"][aria-busy="true"], [data-role="assistant"][aria-busy="true"]';
    try {
      if ([...root.querySelectorAll(assistantBusy)].some(visible)) return true;
    } catch {}
    const selectors = [
      'button[data-testid="stop-button"]',
      '[data-testid="stop-button"]',
      'button[data-testid*="stop" i]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop generating response"]',
      'button[aria-label="Stop response"]',
      'button[aria-label="Stop streaming"]',
      '[role="button"][aria-label="Stop generating"]',
      '[role="button"][aria-label="Stop generating response"]',
      '[role="button"][aria-label="Stop response"]',
      '[role="button"][aria-label="Stop streaming"]'
    ];
    return selectors.some((selector) => {
      try { return [...root.querySelectorAll(selector)].some(visible); }
      catch { return false; }
    });
  }

  function dispatchComposerEnter(composer) {
    if (!composer) return;
    try { composer.focus?.(); } catch {}
    if (typeof KeyboardEvent === 'undefined') return;
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    const target = (active && composer.contains?.(active)) ? active : (composer.querySelector?.('p') || composer);
    const keyOptions = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      charCode: 13,
      bubbles: true,
      cancelable: true,
      composed: true
    };
    target.dispatchEvent(new KeyboardEvent('keydown', keyOptions));
    target.dispatchEvent(new KeyboardEvent('keypress', keyOptions));
    target.dispatchEvent(new KeyboardEvent('keyup', keyOptions));
    if (target !== composer) {
      composer.dispatchEvent(new KeyboardEvent('keydown', keyOptions));
      composer.dispatchEvent(new KeyboardEvent('keypress', keyOptions));
      composer.dispatchEvent(new KeyboardEvent('keyup', keyOptions));
    }
  }

  const api = {
    dispatchComposerEnter,
    visible,
    composerSelectors,
    usableComposer,
    findComposer,
    composerText,
    setComposerText,
    composerContainsText,
    controlMetadata,
    isDisabledControl,
    isUnsafeSendControl,
    sendControlScore,
    findSendControl,
    generationLooksActive
  };

  if (typeof window !== 'undefined') globalThis.BrowserAiBridgeChatGptInput = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
