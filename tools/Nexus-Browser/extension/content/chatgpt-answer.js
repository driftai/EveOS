(() => {
  if (typeof window !== 'undefined' && globalThis.__browserAiBridgeChatGptAnswerLoaded) return;
  if (typeof window !== 'undefined') globalThis.__browserAiBridgeChatGptAnswerLoaded = true;

  // ChatGPT ships multiple headed renderers. Prefer semantic role/turn markers;
  // DIL selection ids remain a guarded fallback because selection ids alone also
  // occur on non-assistant content.
  const DIL_ASSISTANT_SELECTOR = '[data-chatgpt-selection-message-id]:has([class*="DilResponseRoot"])';
  const ARTICLE_ASSISTANT_SELECTOR = 'article:has(.markdown.prose)';
  const ASSISTANT_SELECTOR = [
    '[data-turn="assistant"]',
    '[data-message-author-role="assistant"]',
    '[data-role="assistant"]',
    '[data-message-author="assistant"]',
    '.agent-turn',
    DIL_ASSISTANT_SELECTOR,
    ARTICLE_ASSISTANT_SELECTOR
  ].join(',');
  const USER_SELECTOR = [
    '[data-turn="user"]',
    '[data-message-author-role="user"]',
    '[data-role="user"]',
    '[data-message-author="user"]',
    '.user-turn'
  ].join(',');
  const CONTENT_SELECTOR = '.markdown, .markdown-new-styling, .prose, [class*="markdown"], [class*="DilResponseRoot"]';
  const SKIP_SELECTOR = [
    'script',
    'style',
    'button',
    '[role="button"]',
    '[aria-hidden="true"]',
    'svg',
    '[data-testid*="action" i]',
    '[data-testid*="copy" i]',
    '[data-testid*="thinking" i]',
    '[data-testid*="tool" i]',
    '[class*="thinking" i]'
  ].join(',');

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

  function attr(node, name) {
    return String(node?.getAttribute?.(name) || '').toLowerCase();
  }

  function classText(node) {
    return String(node?.className || '').toLowerCase();
  }

  function parentChain(node) {
    const chain = [];
    for (let current = node; current; current = current.parentElement) chain.push(current);
    return chain;
  }

  function hasUserMarker(node) {
    const role = attr(node, 'data-message-author-role') || attr(node, 'data-role') || attr(node, 'data-message-author');
    return attr(node, 'data-turn') === 'user' || role === 'user' || classText(node).includes('user-turn');
  }

  function hasDilAssistantMessage(node) {
    if (!node?.hasAttribute?.('data-chatgpt-selection-message-id')
        && node?.getAttribute?.('data-chatgpt-selection-message-id') == null) return false;
    try { return !!node.querySelector?.('[class*="DilResponseRoot"]'); }
    catch { return false; }
  }

  // Role-free article fallback from the current headed renderer. An explicit user
  // marker always vetoes this inference; nested articles never confer ownership.
  function hasArticleAssistantMessage(node) {
    if (String(node?.tagName || '').toUpperCase() !== 'ARTICLE' || hasUserMarker(node)) return false;
    try {
      const content = node.querySelector?.('.markdown.prose');
      return !!content && (!content.closest?.('article') || content.closest('article') === node);
    } catch { return false; }
  }

  function hasAssistantMarker(node) {
    const role = attr(node, 'data-message-author-role') || attr(node, 'data-role') || attr(node, 'data-message-author');
    return attr(node, 'data-turn') === 'assistant' || role === 'assistant' || classText(node).includes('agent-turn')
      || (role !== 'user' && (hasDilAssistantMessage(node) || hasArticleAssistantMessage(node)));
  }

  function isUserOwned(node) {
    return parentChain(node).some(hasUserMarker);
  }

  function isAssistantOwned(node) {
    if (!node || isUserOwned(node)) return false;
    return parentChain(node).some(hasAssistantMarker);
  }

  function shouldSkip(node) {
    if (!node || node.nodeType !== 1) return false;
    try { return !!node.matches?.(SKIP_SELECTOR); } catch { return false; }
  }

  function renderedDisplay(node) {
    if (!node || typeof getComputedStyle === 'undefined') return '';
    try { return String(getComputedStyle(node).display || '').toLowerCase(); } catch { return ''; }
  }

  function emojiAlt(node) {
    if (!node || node.nodeType !== 1) return '';
    const tag = String(node.tagName || '').toUpperCase();
    if (tag !== 'IMG' && attr(node, 'role') !== 'img') return '';
    const alt = String(node.getAttribute?.('alt') || node.getAttribute?.('aria-label') || '').trim();
    if (!alt || alt.length > 32) return '';
    try {
      return /[\p{Extended_Pictographic}\p{Emoji_Presentation}]/u.test(alt) ? alt : '';
    } catch {
      return alt.length <= 4 ? alt : '';
    }
  }

  function normalizeText(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function codeLanguage(node) {
    const direct = node?.getAttribute?.('data-language') || node?.getAttribute?.('data-lang') || '';
    if (direct) return String(direct).trim();
    const className = String(node?.className || '');
    const match = className.match(/(?:language|lang)-([\w+-]+)/i);
    return match?.[1] || '';
  }

  function structuralText(root) {
    if (!root) return '';
    if (!root.childNodes || typeof root.childNodes[Symbol.iterator] !== 'function') {
      return normalizeText(root.innerText || root.textContent || '');
    }

    const paragraphTags = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE']);
    const blockTags = new Set(['DIV', 'SECTION', 'ARTICLE', 'TABLE', 'TR', 'UL', 'OL']);
    const blockDisplays = new Set(['block', 'flex', 'grid', 'list-item', 'table', 'flow-root']);
    let out = '';

    function newline(count = 1) {
      if (!out) return;
      const current = (out.match(/\n+$/) || [''])[0].length;
      if (current < count) out += '\n'.repeat(count - current);
    }

    function walk(node, context = {}) {
      if (!node) return;
      if (node.nodeType === 3) {
        out += node.nodeValue || '';
        return;
      }
      if (node.nodeType !== 1 || shouldSkip(node)) return;

      const emoji = emojiAlt(node);
      if (emoji) {
        out += emoji;
        return;
      }

      const tag = String(node.tagName || '').toUpperCase();
      if (tag === 'BR') {
        newline(1);
        return;
      }
      if (tag === 'PRE') {
        const code = node.querySelector?.('code') || node;
        const text = String(code.innerText || code.textContent || '').replace(/^\n+|\n+$/g, '');
        if (!text) return;
        newline(2);
        const language = codeLanguage(code);
        out += `\`\`\`${language}\n${text}\n\`\`\``;
        newline(2);
        return;
      }
      if (tag === 'LI') {
        if (!String(node.textContent || '').trim()) return;
        newline(1);
        out += '• ';
        for (const child of node.childNodes) walk(child, { ...context, listItemText: true });
        newline(1);
        return;
      }

      const display = renderedDisplay(node);
      const atListItemStart = !!context.listItemText && /(?:^|\n)• $/.test(out);
      const paragraph = paragraphTags.has(tag) && !atListItemStart;
      const block = !atListItemStart
        && (blockTags.has(tag) || blockDisplays.has(display) || display.startsWith('table-'));
      if (paragraph) newline(2);
      else if (block) newline(1);
      for (const child of node.childNodes) walk(child, context);
      if (paragraph) newline(2);
      else if (block) newline(1);
    }

    walk(root);
    return normalizeText(out);
  }

  function pruneNestedNodes(nodes) {
    return nodes.filter((node) => !nodes.some((other) => other !== node && other.contains?.(node)));
  }

  function contentNodesForTurn(turn) {
    if (!turn?.querySelectorAll) return [];
    const blocks = [...turn.querySelectorAll(CONTENT_SELECTOR)]
      .filter((node) => !isUserOwned(node))
      .filter((node) => visible(node) || String(node.textContent || '').trim());
    return pruneNestedNodes(blocks);
  }

  function assistantNodes(root = document) {
    if (!root?.querySelectorAll) return [];
    const turns = [...root.querySelectorAll(ASSISTANT_SELECTOR)]
      .filter((turn) => !isUserOwned(turn))
      .filter((turn) => isAssistantOwned(turn))
      .filter((turn) => visible(turn) || String(turn.textContent || '').trim());

    const nodes = [];
    for (const turn of pruneNestedNodes(turns)) {
      const blocks = contentNodesForTurn(turn);
      if (blocks.length) nodes.push(...blocks);
      else nodes.push(turn);
    }
    return pruneNestedNodes(nodes);
  }

  function assistantText(node) {
    if (!node || isUserOwned(node) || !isAssistantOwned(node)) return '';
    return structuralText(node);
  }

  function userNodes(root = document) {
    if (!root?.querySelectorAll) return [];
    const turns = [...root.querySelectorAll(USER_SELECTOR)]
      .filter((turn) => isUserOwned(turn))
      .filter((turn) => visible(turn) || String(turn.textContent || '').trim());
    return pruneNestedNodes(turns);
  }

  function userText(node) {
    return !node || !isUserOwned(node) ? '' : structuralText(node);
  }

  function getTurnUserText(nodes, baselineCount = 0) {
    if (!nodes?.length || nodes.length <= baselineCount) return '';
    return nodes.slice(baselineCount).map(userText).filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function getTurnAssistantText(nodes, baselineCount = 0) {
    if (!nodes?.length) return '';
    const target = baselineCount > 0 && nodes.length > baselineCount
      ? nodes.slice(baselineCount)
      : [nodes[nodes.length - 1]];
    return target.map(assistantText).filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function conversationTurns(root = document) {
    if (!root?.querySelectorAll) return [];
    return pruneNestedNodes([...root.querySelectorAll(`${USER_SELECTOR},${ASSISTANT_SELECTOR}`)]
      .filter((turn) => isUserOwned(turn) || isAssistantOwned(turn))
      .filter((turn) => visible(turn) || String(turn.textContent || '').trim()));
  }

  function assistantTurnText(turn) {
    if (!turn || !isAssistantOwned(turn)) return '';
    const blocks = contentNodesForTurn(turn);
    return (blocks.length ? blocks : [turn])
      .map((node) => structuralText(node)).filter(Boolean).join('\n\n')
      .replace(/\n{3,}/g, '\n\n').trim();
  }

  function responseTextForUserPrompt(expectedText, baselineUserCount = 0, root = document) {
    const wanted = normalizeText(expectedText);
    if (!wanted) return '';
    const users = userNodes(root);
    const userTurn = users.slice(Math.max(0, baselineUserCount))
      .find((node) => normalizeText(userText(node)).includes(wanted));
    if (!userTurn) return '';
    const turns = conversationTurns(root);
    const start = turns.indexOf(userTurn);
    if (start < 0) return '';
    let latest = '';
    for (let index = start + 1; index < turns.length; index += 1) {
      if (isUserOwned(turns[index])) break;
      if (isAssistantOwned(turns[index])) {
        const text = assistantTurnText(turns[index]);
        if (text) latest = text;
      }
    }
    return latest;
  }

  function latestAssistantText() {
    return getTurnAssistantText(assistantNodes(), 0);
  }

  const api = {
    ASSISTANT_SELECTOR,
    DIL_ASSISTANT_SELECTOR,
    ARTICLE_ASSISTANT_SELECTOR,
    USER_SELECTOR,
    CONTENT_SELECTOR,
    hasUserMarker,
    hasAssistantMarker,
    hasDilAssistantMessage,
    hasArticleAssistantMessage,
    isUserOwned,
    isAssistantOwned,
    emojiAlt,
    normalizeText,
    structuralText,
    pruneNestedNodes,
    contentNodesForTurn,
    assistantNodes,
    assistantText,
    userNodes,
    userText,
    getTurnUserText,
    getTurnAssistantText,
    conversationTurns,
    assistantTurnText,
    responseTextForUserPrompt,
    latestAssistantText
  };

  if (typeof window !== 'undefined') globalThis.BrowserAiBridgeChatGptAnswer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
