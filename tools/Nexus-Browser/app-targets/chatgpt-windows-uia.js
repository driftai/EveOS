'use strict';

const CHROME_TEXT = new Set([
  'chatgpt', 'chat', 'work', 'new chat', 'share', 'ask chatgpt',
  'chatgpt can make mistakes. check important info.', 'chatgpt can make mistakes. check important info',
  'chatgpt is ai and can make mistakes. check important info.', 'chatgpt is ai and can make mistakes. check important info',
  'home', 'search', 'library', 'projects', 'settings', 'send', 'send message',
  'stop', 'stop generating', 'stop streaming', 'copy', 'good response', 'bad response',
  'read aloud', 'regenerate', 'retry', 'edit message',
  'latest response', 'previous response', 'next response', 'response actions',
  'more actions', 'more options', 'open message actions'
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

function elementsFromSearch(json) {
  const matches = Array.isArray(json?.matches) ? json.matches
    : Array.isArray(json?.result?.matches) ? json.result.matches : [];
  return matches.map((match) => {
    if (match?.element && typeof match.element === 'object') {
      return { ...match.element, selector: match.element.selector || match.selector || match.elementId };
    }
    return match && typeof match === 'object' ? match : null;
  }).filter(Boolean);
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

function rectOf(element = {}) {
  if (!element || typeof element !== 'object') return { x: 0, y: 0, width: 0, height: 0 };
  const bounds = element.bounds || element.boundingRectangle || element.rect || {};
  const x = asNumber(element.x ?? bounds.x ?? bounds.left);
  const y = asNumber(element.y ?? bounds.y ?? bounds.top);
  const width = asNumber(element.width ?? bounds.width ?? (asNumber(bounds.right) - x));
  const height = asNumber(element.height ?? bounds.height ?? (asNumber(bounds.bottom) - y));
  return { x, y, width: Math.max(0, width), height: Math.max(0, height) };
}

function centerOf(element = {}) {
  const rect = rectOf(element);
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function windowRect(windowInfo = {}) {
  const rect = rectOf(windowInfo);
  if (rect.width || rect.height) return rect;
  return { x: 0, y: 0, width: asNumber(windowInfo.width), height: asNumber(windowInfo.height) };
}

function relativeGeometry(element, windowInfo = {}) {
  const rect = rectOf(element), frame = windowRect(windowInfo);
  const center = centerOf(element);
  const right = rect.x + rect.width, bottom = rect.y + rect.height;
  const fx = frame.x || 0, fy = frame.y || 0;
  return {
    rect, frame, center,
    xRatio: frame.width ? (center.x - fx) / frame.width : 0,
    yRatio: frame.height ? (center.y - fy) / frame.height : 0,
    widthRatio: frame.width ? rect.width / frame.width : 0,
    heightRatio: frame.height ? rect.height / frame.height : 0,
    right, bottom
  };
}

function candidateSummary(element, score = null) {
  if (!element) return null;
  return {
    selector: selectorOf(element),
    type: controlType(element),
    name: textOf(element).slice(0, 120),
    automationId: propertyText(element, 'automationId').slice(0, 120),
    rect: rectOf(element),
    ...(score == null ? {} : { score })
  };
}

function composerScore(element = {}, context = {}) {
  const type = controlType(element);
  if (!/(edit|document|textbox|text box)/.test(type)) return -1;
  if (element.isOffscreen === true || propertyText(element, 'IsOffscreen') === 'True') return -1;

  const name = textOf(element).toLowerCase();
  const automation = propertyText(element, 'automationId').toLowerCase();
  const className = propertyText(element, 'className').toLowerCase();
  const semantic = /ask chatgpt|message chatgpt|send a message|prompt/.test(name)
    || /prompt|composer|textarea|chat[-_ ]?input/.test(automation);
  if (/search|rename|filter|sidebar|title/.test(name + ' ' + automation)) return -1;

  const geometry = relativeGeometry(element, context.windowInfo);
  const focusable = element.isKeyboardFocusable === true
    || propertyText(element, 'IsKeyboardFocusable') === 'True';
  const bottomWide = geometry.widthRatio >= 0.28 && geometry.yRatio >= 0.55;
  const unnamedFocusableEditor = !name && !automation && focusable && !!selectorOf(element);
  if (!semantic && !bottomWide && !unnamedFocusableEditor) return -1;

  let score = 0;
  if (/ask chatgpt|message chatgpt|send a message/.test(name)) score += 60;
  else if (/prompt/.test(name)) score += 28;
  if (/prompt|composer|textarea|chat[-_ ]?input/.test(automation)) score += 55;
  if (/editor|textbox|rich|webview|contenteditable/.test(className)) score += 8;
  if (focusable) score += 10;
  if (unnamedFocusableEditor) score += 18;
  if (Number(element.__depth) >= 4) score += Math.min(8, Number(element.__depth));
  if (type.includes('document')) score += 4;
  if (selectorOf(element)) score += 3;
  if (geometry.widthRatio >= 0.28) score += 18;
  if (geometry.widthRatio >= 0.50) score += 8;
  if (geometry.yRatio >= 0.55) score += 18;
  if (geometry.yRatio >= 0.72) score += 10;
  if (geometry.rect.height >= 24 && geometry.rect.height <= 220) score += 5;
  return score;
}

function sendScore(element = {}, context = {}) {
  const type = controlType(element);
  if (!type.includes('button')) return -1;
  if (element.isOffscreen === true || propertyText(element, 'IsOffscreen') === 'True') return -1;

  const name = textOf(element).toLowerCase();
  const automation = propertyText(element, 'automationId').toLowerCase();
  const combined = `${name} ${automation}`;
  if (/voice|dictat|microphone|record|attach|back|previous|menu|sidebar|new chat/.test(combined)) return -1;

  const semantic = /(^|\b)(send|submit)(\b|$)/.test(combined);
  const geometry = relativeGeometry(element, context.windowInfo);
  const composerRect = rectOf(context.composer);
  const buttonRect = geometry.rect;
  const buttonCenter = geometry.center;
  const composerCenterY = composerRect.y + composerRect.height / 2;
  const composerRight = composerRect.x + composerRect.width;
  const nearComposer = composerRect.width > 0
    && buttonRect.width > 0 && buttonRect.height > 0
    && Math.abs(buttonCenter.y - composerCenterY) <= Math.max(48, composerRect.height * 0.85)
    && buttonCenter.x >= composerRect.x + composerRect.width * 0.58
    && buttonCenter.x <= composerRight + Math.max(96, composerRect.width * 0.18)
    && buttonRect.width <= 112 && buttonRect.height <= 112;

  if (!semantic && !nearComposer) return -1;

  let score = 0;
  if (/^send(?: message| prompt)?$/.test(name)) score += 90;
  else if (/\bsend\b|\bsubmit\b/.test(name)) score += 55;
  if (/send|submit/.test(automation)) score += 55;
  if (nearComposer) score += 52;
  if (geometry.yRatio >= 0.60) score += 18;
  if (geometry.xRatio >= 0.60) score += 10;
  if (selectorOf(element)) score += 3;
  return score;
}

function rankCandidates(elements, scoreFn, context = {}) {
  return elements
    .map((element) => ({ element, score: scoreFn(element, context) }))
    .filter((entry) => Number.isFinite(entry.score) && entry.score >= 0)
    .sort((a, b) => b.score - a.score);
}

function chooseBest(elements, scoreFn, context = {}, minimumScore = 1) {
  const best = rankCandidates(elements, scoreFn, context)[0] || null;
  return best && best.score >= minimumScore ? best.element : null;
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
  if (/^(thinking|working|searching|reading|analyzing|generating|chatgpt is responding)(?:\.\.\.|…)?$/i.test(normalized)) return true;
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

function responseScore(element = {}, context = {}) {
  const type = controlType(element);
  if (!/(text|document|paragraph)/.test(type)) return -1;
  if (element.isOffscreen === true || propertyText(element, 'IsOffscreen') === 'True') return -1;

  const text = normalizeCandidate(textOf(element));
  if (!text || isChromeText(text)) return -1;
  const prompt = normalizeCandidate(context.prompt || '');
  if (prompt && (text === prompt || (text.startsWith(prompt) && text.length <= prompt.length + 8))) return -1;
  if (context.baseline?.has(text)) return -1;

  const geometry = relativeGeometry(element, context.windowInfo);
  const rect = geometry.rect;
  if (!rect.width || !rect.height) return -1;

  let score = 0;
  if (type.includes('text')) score += 20;
  if (type.includes('paragraph')) score += 18;
  if (type.includes('document')) score += 10;

  // ChatGPT assistant messages are rendered in the main conversation column,
  // while user bubbles are normally right-aligned. Prefer the conversation-left
  // region but keep the range broad enough for narrow/resized windows.
  if (geometry.xRatio >= 0.07 && geometry.xRatio <= 0.76) score += 28;
  else if (geometry.xRatio > 0.82) score -= 24;
  else score += 4;

  if (geometry.yRatio >= 0.10 && geometry.yRatio <= 0.88) score += 12;
  else if (geometry.yRatio > 0.93) score -= 20;

  if (geometry.widthRatio >= 0.08) score += 8;
  if (text.length >= 8) score += 8;
  if (text.length >= 24) score += 4;
  score += Math.min(12, Math.max(0, geometry.yRatio * 12));
  return score;
}

function contentCandidates(elements = [], windowInfo = {}) {
  return elements
    .map((element) => ({
      element,
      text: normalizeCandidate(textOf(element)),
      score: responseScore(element, { windowInfo }),
      rect: rectOf(element),
      type: controlType(element),
      selector: selectorOf(element)
    }))
    .filter((entry) => entry.score >= 0 && entry.text && !isChromeText(entry.text));
}

function latestResponseCandidate(snapshot = {}, { baseline = new Set(), prompt = '' } = {}) {
  const candidates = (snapshot.responseCandidates || contentCandidates(snapshot.elements || [], snapshot.windowInfo || {}))
    .map((entry) => ({
      ...entry,
      score: responseScore(entry.element, {
        windowInfo: snapshot.windowInfo || {},
        baseline,
        prompt
      })
    }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score
      || (b.rect?.y || 0) - (a.rect?.y || 0)
      || b.text.length - a.text.length);
  return candidates[0] || null;
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
  const inspectedWindow = windowsFromEnvelope(json)[0] || windowInfo || {};
  const frame = { ...windowInfo, ...inspectedWindow };
  const elements = flattenElements(json);
  const composerContext = { windowInfo: frame };
  const composerRanked = rankCandidates(elements, composerScore, composerContext);
  const composer = composerRanked[0]?.score >= 18 ? composerRanked[0].element : null;
  const sendContext = { windowInfo: frame, composer };
  const sendRanked = rankCandidates(elements, sendScore, sendContext);
  const sendButton = sendRanked[0]?.score >= 20 ? sendRanked[0].element : null;
  const texts = contentTexts(elements);
  const responseCandidates = contentCandidates(elements, frame);
  const latestResponse = latestResponseCandidate({ elements, windowInfo: frame, responseCandidates });
  return {
    hwnd: hwndOf(frame),
    pid: pidOf(frame),
    title: String(frame?.title || frame?.name || 'ChatGPT'),
    windowInfo: frame,
    elements,
    composer,
    composerSelector: selectorOf(composer),
    composerValue: composer ? normalizeCandidate(textOf(composer)) : '',
    composerCandidates: composerRanked.slice(0, 5).map((entry) => candidateSummary(entry.element, entry.score)),
    sendButton,
    sendSelector: selectorOf(sendButton),
    sendCandidates: sendRanked.slice(0, 5).map((entry) => candidateSummary(entry.element, entry.score)),
    generating: isGenerating(elements),
    texts,
    responseCandidates,
    latestResponseText: latestResponse?.text || '',
    latestText: latestResponse?.text || texts.at(-1) || ''
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
  elementsFromSearch,
  controlType,
  selectorOf,
  textOf,
  propertyText,
  rectOf,
  centerOf,
  windowRect,
  relativeGeometry,
  candidateSummary,
  composerScore,
  sendScore,
  rankCandidates,
  chooseBest,
  isGenerating,
  normalizeCandidate,
  isChromeText,
  contentTexts,
  responseScore,
  contentCandidates,
  latestResponseCandidate,
  latestCandidate,
  snapshotFromInspect
};
