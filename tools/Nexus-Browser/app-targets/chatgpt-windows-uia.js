'use strict';

const CHROME_TEXT = new Set([
  'chatgpt', 'chat', 'work', 'new chat', 'share', 'ask chatgpt',
  'chatgpt can make mistakes. check important info.', 'chatgpt can make mistakes. check important info',
  'home', 'search', 'library', 'projects', 'settings', 'send', 'send message',
  'stop', 'stop generating', 'stop streaming', 'copy', 'good response', 'bad response',
  'read aloud', 'regenerate', 'retry', 'edit message'
]);

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function windowArea(windowInfo = {}) {
  const bounds = windowInfo.bounds || windowInfo.boundingRectangle || windowInfo.rect || {};
  const width = asNumber(windowInfo.width || bounds.width || (bounds.right - bounds.left));
  const height = asNumber(windowInfo.height || bounds.height || (bounds.bottom - bounds.top));
  return Math.max(0, width) * Math.max(0, height);
}

function windowsFromEnvelope(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.windows)) return json.windows;
  if (Array.isArray(json?.result?.windows)) return json.result.windows;
  if (Array.isArray(json?.data?.windows)) return json.data.windows;
  return [];
}

function pickMainWindow(windows = []) {
  const visible = windows.filter((entry) => entry && (entry.title || entry.name || entry.hwnd || entry.handle));
  if (!visible.length) return null;
  return [...visible].sort((a, b) => {
    const titleA = String(a.title || a.name || '').toLowerCase();
    const titleB = String(b.title || b.name || '').toLowerCase();
    const scoreA = windowArea(a) + (titleA.includes('chatgpt') ? 1000 : 0);
    const scoreB = windowArea(b) + (titleB.includes('chatgpt') ? 1000 : 0);
    return scoreB - scoreA;
  })[0];
}

function hwndOf(windowInfo = {}) {
  return windowInfo.hwnd ?? windowInfo.handle ?? windowInfo.windowHandle ?? windowInfo.id ?? null;
}

function pidOf(windowInfo = {}) {
  return asNumber(windowInfo.pid || windowInfo.processId || windowInfo.process?.id) || null;
}

function flattenElements(json) {
  const roots = [];
  for (const windowInfo of windowsFromEnvelope(json)) {
    if (Array.isArray(windowInfo.elements)) roots.push(...windowInfo.elements);
    if (windowInfo.root) roots.push(windowInfo.root);
  }
  if (Array.isArray(json?.elements)) roots.push(...json.elements);
  const out = [];
  const visit = (node, depth = 0) => {
    if (!node || typeof node !== 'object') return;
    out.push({ ...node, __depth: depth });
    for (const child of node.children || []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root);
  return out;
}

function controlType(element = {}) {
  if (!element || typeof element !== 'object') return '';
  return String(element.controlType || element.type || element.localizedControlType || '').toLowerCase();
}

function selectorOf(element = {}) {
  if (!element || typeof element !== 'object') return '';
  return String(element.elementId || element.slug || element.selector || element.id || '').trim();
}

function textOf(element = {}) {
  if (!element || typeof element !== 'object') return '';
  for (const value of [element.text, element.value, element.name]) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return '';
}

function propertyText(element = {}, key) {
  if (!element || typeof element !== 'object') return '';
  const direct = element[key];
  if (direct != null) return String(direct);
  const props = element.properties || {};
  const found = Object.entries(props).find(([name]) => name.toLowerCase() === key.toLowerCase());
  return found ? String(found[1] ?? '') : '';
}

function composerScore(element = {}) {
  const type = controlType(element);
  if (!/(edit|document|textbox|text box)/.test(type)) return -1;
  const name = textOf(element).toLowerCase();
  const automation = propertyText(element, 'automationId').toLowerCase();
  const className = propertyText(element, 'className').toLowerCase();
  let score = 1;
  if (/ask chatgpt|message chatgpt|send a message/.test(name)) score += 30;
  if (/prompt|composer|textarea|chat-input/.test(automation)) score += 20;
  if (/editor|textbox|rich|webview/.test(className)) score += 4;
  if (element.isKeyboardFocusable === true || propertyText(element, 'IsKeyboardFocusable') === 'True') score += 3;
  if (selectorOf(element)) score += 2;
  return score;
}

function sendScore(element = {}) {
  const type = controlType(element);
  if (!type.includes('button')) return -1;
  const name = textOf(element).toLowerCase();
  const automation = propertyText(element, 'automationId').toLowerCase();
  if (/voice|dictat|microphone|record|attach/.test(name)) return -1;
  let score = 0;
  if (/^send(?: message)?$/.test(name)) score += 40;
  else if (/send|submit/.test(name)) score += 12;
  if (/send|submit/.test(automation)) score += 12;
  if (selectorOf(element)) score += 2;
  return score;
}

function chooseBest(elements, scoreFn) {
  return elements.reduce((best, element) => {
    const score = scoreFn(element);
    return score > (best?.score ?? -1) ? { element, score } : best;
  }, null)?.element || null;
}

function isGenerating(elements = []) {
  return elements.some((element) => {
    if (!controlType(element).includes('button')) return false;
    return /^(stop|stop generating|stop streaming|cancel response)$/i.test(textOf(element));
  });
}

function normalizeCandidate(text) {
  return String(text || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();
}

function isChromeText(text) {
  const normalized = normalizeCandidate(text);
  if (!normalized) return true;
  const lower = normalized.toLowerCase();
  if (CHROME_TEXT.has(lower)) return true;
  if (/^(thinking|working|searching|reading|analyzing|generating)(\.\.\.)?$/i.test(normalized)) return true;
  if (/^thought for \d+(?:\.\d+)?s$/i.test(normalized)) return true;
  if (/^\d+\s*\/\s*\d+$/.test(normalized)) return true;
  return false;
}

function contentTexts(elements = []) {
  const values = [], seen = new Set();
  for (const element of elements) {
    const type = controlType(element), text = normalizeCandidate(textOf(element));
    if (!text || isChromeText(text)) continue;
    const hasChildren = Array.isArray(element.children) && element.children.length > 0;
    if (!/(text|document|paragraph|listitem|group|pane)/.test(type)) continue;
    if (hasChildren && !/(document|paragraph)/.test(type)) continue;
    if (text.length > 120000 || seen.has(text)) continue;
    seen.add(text); values.push(text);
  }
  return values;
}

function latestCandidate(texts = [], { baseline = new Set(), prompt = '' } = {}) {
  const promptNormalized = normalizeCandidate(prompt);
  const candidates = texts.filter((text) => {
    const normalized = normalizeCandidate(text);
    if (!normalized || normalized === promptNormalized || baseline.has(normalized)) return false;
    if (normalized.startsWith(promptNormalized) && normalized.length <= promptNormalized.length + 8) return false;
    return !isChromeText(normalized);
  });
  return candidates.at(-1) || '';
}

function snapshotFromInspect({ windowInfo, json }) {
  const elements = flattenElements(json);
  const composer = chooseBest(elements, composerScore);
  const sendButton = chooseBest(elements, sendScore);
  const texts = contentTexts(elements);
  return {
    hwnd: hwndOf(windowInfo),
    pid: pidOf(windowInfo),
    title: String(windowInfo?.title || windowInfo?.name || 'ChatGPT'),
    elements,
    composer,
    composerSelector: selectorOf(composer),
    composerValue: composer ? normalizeCandidate(textOf(composer)) : '',
    sendButton,
    sendSelector: selectorOf(sendButton),
    generating: isGenerating(elements),
    texts,
    latestText: texts.at(-1) || ''
  };
}

module.exports = {
  CHROME_TEXT,
  asNumber,
  windowArea,
  windowsFromEnvelope,
  pickMainWindow,
  hwndOf,
  pidOf,
  flattenElements,
  controlType,
  selectorOf,
  textOf,
  propertyText,
  composerScore,
  sendScore,
  chooseBest,
  isGenerating,
  normalizeCandidate,
  isChromeText,
  contentTexts,
  latestCandidate,
  snapshotFromInspect
};
