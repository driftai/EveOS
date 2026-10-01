'use strict';

const uia = require('./chatgpt-windows-uia');
const conversation = require('./chatgpt-windows-conversation');

const SEARCH_QUERIES = [
  'conversation',
  'thread',
  'chat title',
  'title',
  'header',
  'Heading',
  'Button',
  'Text'
];

function mergedSnapshot(snapshot = {}, elements = []) {
  return {
    ...snapshot,
    elements: [...(snapshot.elements || []), ...elements]
  };
}

async function searchElements(runner, hwnd, query) {
  const result = await runner.runJson(
    ['ui', 'search', query, '-w', String(hwnd), '--max', '40'],
    { allowFailure: true, timeoutMs: 8000 }
  );
  return result.ok ? uia.elementsFromSearch(result.json) : [];
}

function dedupe(elements = []) {
  const seen = new Set();
  return elements.filter((element) => {
    const selector = uia.selectorOf(element);
    const key = selector || [
      uia.controlType(element),
      uia.textOf(element),
      JSON.stringify(uia.rectOf(element))
    ].join('|');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function resolve({ runner, snapshot } = {}) {
  const direct = conversation.activeConversationTitle(snapshot);
  if (direct) return { ...direct, source: 'inspect' };
  if (!runner?.runJson || !snapshot?.hwnd) return null;

  const collected = [];
  for (const query of SEARCH_QUERIES) {
    collected.push(...await searchElements(runner, snapshot.hwnd, query));
    const recovered = conversation.activeConversationTitle(
      mergedSnapshot(snapshot, dedupe(collected))
    );
    if (recovered) return { ...recovered, source: `uia-search:${query}` };
  }
  return null;
}

module.exports = {
  SEARCH_QUERIES,
  mergedSnapshot,
  searchElements,
  dedupe,
  resolve
};
