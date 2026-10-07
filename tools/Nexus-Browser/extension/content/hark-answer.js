(() => {
  if (typeof window !== 'undefined' && globalThis.__browserAiBridgeHarkAnswerLoaded) return;
  if (typeof window !== 'undefined') globalThis.__browserAiBridgeHarkAnswerLoaded = true;

  function visible(element) {
    const shared = globalThis.BrowserAiBridgeHarkInput?.visible;
    if (shared) return shared(element);
    if (!element) return false;
    if (typeof getComputedStyle === 'undefined') return true;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect?.();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && (!rect || (rect.width > 0 && rect.height > 0));
  }

  function normalized(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function pruneNestedNodes(nodes) {
    const unique = [...new Set((nodes || []).filter(Boolean))];
    const leaves = unique.filter((node) => !unique.some((other) => (
      other !== node && node.contains?.(other)
    )));
    return leaves.sort((a, b) => {
      const relation = a.compareDocumentPosition?.(b) || 0;
      if (relation & 4) return -1;
      if (relation & 2) return 1;
      return 0;
    });
  }

  function metadata(node) {
    if (!node) return '';
    return [
      node.getAttribute?.('data-message-author-role'),
      node.getAttribute?.('data-role'),
      node.getAttribute?.('data-author'),
      node.getAttribute?.('data-testid'),
      node.getAttribute?.('aria-label'),
      node.className
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  const TIMESTAMP_ONLY = /^(?:(?:today|yesterday|mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?$/i;

  function excluded(node) {
    if (!node || !visible(node)) return true;
    if (node.matches?.('textarea, input, [contenteditable="true"]')) return true;
    if (node.closest?.('form, nav, aside, header')) return true;
    const meta = metadata(node);
    if (/\b(user|human|prompt-input|composer|sidebar|navigation)\b/.test(meta)
        && !/\b(assistant|agent|response|answer)\b/.test(meta)) return true;
    const text = normalized(node.innerText || node.textContent || '');
    if (!text) return true;
    // Message timestamps ("11:28 PM") render as their own leaves; never treat one as a reply.
    return TIMESTAMP_ONLY.test(text);
  }

  function assistantNodes(root = document) {
    const strongSelectors = [
      '[data-message-author-role="assistant"]',
      '[data-role="assistant"]',
      '[data-author="assistant"]',
      '[data-testid*="assistant" i]',
      '[aria-label*="assistant" i]',
      '[class*="assistant" i][class*="message" i]',
      '[class*="agent" i][class*="message" i]',
      '[class*="assistant" i][class*="response" i]'
    ];
    const strong = [];
    const seen = new Set();
    for (const selector of strongSelectors) {
      for (const node of root.querySelectorAll?.(selector) || []) {
        if (seen.has(node) || excluded(node)) continue;
        seen.add(node);
        strong.push(node);
      }
    }
    if (strong.length) return pruneNestedNodes(strong);

    const fallbackSelectors = [
      '[data-testid*="message" i]',
      '[class*="message" i]',
      '[class*="response" i]',
      '[class*="answer" i]',
      '[class*="markdown" i]',
      '.prose',
      'article'
    ];
    const fallback = [];
    for (const selector of fallbackSelectors) {
      for (const node of root.querySelectorAll?.(selector) || []) {
        if (seen.has(node) || excluded(node)) continue;
        const meta = metadata(node);
        const text = normalized(node.innerText || node.textContent || '');
        if (text.length < 2) continue;
        const assistantSignal = /\b(assistant|agent|response|answer|markdown|prose)\b/.test(meta);
        const messageSignal = /\bmessage\b/.test(meta) && !/\b(user|human)\b/.test(meta);
        if (!assistantSignal && !messageSignal && node.tagName !== 'ARTICLE') continue;
        seen.add(node);
        fallback.push(node);
      }
    }
    return pruneNestedNodes(fallback);
  }

  function cleanClone(node) {
    if (!node) return null;
    const clone = node.cloneNode(true);
    clone.querySelectorAll?.([
      'script', 'style', 'button', '[role="button"]',
      'textarea', 'input', '[contenteditable="true"]',
      '[data-testid*="copy" i]', '[aria-label*="copy" i]',
      '[data-testid*="toolbar" i]', '[class*="toolbar" i]',
      '[class*="actions" i]'
    ].join(',')).forEach((child) => child.remove());
    return clone;
  }

  function structuralText(root) {
    if (!root) return '';
    const paragraphTags = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE']);
    let out = '';
    function newline(count = 1) {
      if (!out) return;
      const current = (out.match(/\n+$/) || [''])[0].length;
      if (current < count) out += '\n'.repeat(count - current);
    }
    function walk(node) {
      if (!node) return;
      if (node.nodeType === 3) {
        out += node.nodeValue || '';
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = String(node.tagName || '').toUpperCase();
      if (tag === 'BR') return newline(1);
      if (tag === 'LI') {
        newline(1);
        const parent = node.parentElement;
        if (String(parent?.tagName || '').toUpperCase() === 'OL') {
          const siblings = [...(parent.children || [])].filter((child) => String(child.tagName || '').toUpperCase() === 'LI');
          out += `${Math.max(1, siblings.indexOf(node) + 1)}. `;
        } else out += '• ';
        for (const child of node.childNodes || []) walk(child);
        newline(1);
        return;
      }
      const paragraph = paragraphTags.has(tag);
      if (paragraph) newline(1);
      for (const child of node.childNodes || []) walk(child);
      if (paragraph) newline(1);
    }
    walk(root);
    return normalized(out);
  }

  function assistantText(node) {
    return structuralText(cleanClone(node));
  }

  function getTurnAssistantText(nodes, baselineCount = 0) {
    if (!nodes?.length) return '';
    const selected = baselineCount >= 0 && nodes.length > baselineCount
      ? nodes.slice(baselineCount)
      : [nodes[nodes.length - 1]];
    return selected.map(assistantText).filter(Boolean).join('\n\n').trim();
  }

  function latestAssistantText() {
    const nodes = assistantNodes(document);
    return nodes.length ? assistantText(nodes[nodes.length - 1]) : '';
  }

  const api = {
    visible,
    normalized,
    pruneNestedNodes,
    metadata,
    excluded,
    assistantNodes,
    cleanClone,
    structuralText,
    assistantText,
    getTurnAssistantText,
    latestAssistantText
  };

  if (typeof window !== 'undefined') globalThis.BrowserAiBridgeHarkAnswer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
