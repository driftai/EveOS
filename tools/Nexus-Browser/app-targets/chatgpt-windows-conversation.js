'use strict';

const uia = require('./chatgpt-windows-uia');

const ASSISTANT_MARKER = /^(?:chatgpt|assistant)\s+said\s*:?$/i;
const USER_MARKER = /^(?:you|user)\s+said\s*:?$/i;
const LIVE_STATUS = /^(?:chatgpt\s+is\s+responding|responding|generating)(?:\.{3}|…)?$/i;

function nodeText(element = {}) {
  for (const value of [element?.text, element?.value, element?.name]) {
    const text = String(value || '').replace(/\r/g, '').trim();
    if (text) return text;
  }
  return '';
}

function eligibleReplyNode(element, snapshot, { baseline = new Set(), prompt = '', includeOffscreen = false } = {}) {
  const type = uia.controlType(element);
  if (!/(text|paragraph|document|listitem|heading)/.test(type)) return null;
  if (!includeOffscreen && (element?.isOffscreen === true || uia.propertyText(element, 'IsOffscreen') === 'True')) return null;
  const rawText = nodeText(element);
  const text = uia.normalizeCandidate(rawText);
  if (!text || uia.isChromeText(text) || LIVE_STATUS.test(text)) return null;
  if (ASSISTANT_MARKER.test(text) || USER_MARKER.test(text)) return null;
  const normalizedPrompt = uia.normalizeCandidate(prompt);
  if (normalizedPrompt && (text === normalizedPrompt
      || (text.startsWith(normalizedPrompt) && text.length <= normalizedPrompt.length + 8))) return null;
  if (baseline?.has(text)) return null;

  const rect = uia.rectOf(element), frame = uia.windowRect(snapshot.windowInfo || {});
  if (!rect.width || !rect.height) return null;
  const xRatio = frame.width ? ((rect.x + rect.width / 2) - frame.x) / frame.width : 0;
  const yRatio = frame.height ? ((rect.y + rect.height / 2) - frame.y) / frame.height : 0;
  if (xRatio > 0.84 || (!includeOffscreen && yRatio > 0.94)) return null;

  const selector = uia.selectorOf(element);
  if (/rootwebarea/i.test(selector)) return null;
  if (Array.isArray(element.children) && element.children.length
      && !type.includes('paragraph') && !type.includes('listitem')) return null;
  return { text: rawText, normalizedText: text, rect, selector, type };
}

function assistantReplyGroups(snapshot = {}, options = {}) {
  const groups = [];
  let role = null, current = null;
  for (const element of snapshot.elements || []) {
    const text = uia.normalizeCandidate(uia.textOf(element));
    if (USER_MARKER.test(text)) {
      role = 'user';
      current = null;
      continue;
    }
    if (ASSISTANT_MARKER.test(text)) {
      role = 'assistant';
      current = { parts: [], normalizedParts: [], selectors: [], firstY: null, lastY: null };
      groups.push(current);
      continue;
    }
    if (role !== 'assistant' || !current) continue;
    const node = eligibleReplyNode(element, snapshot, options);
    if (!node) continue;
    const normalized = node.normalizedText;
    if (current.normalizedParts.includes(normalized)) continue;
    if (current.normalizedParts.some((part) => part.length > normalized.length && part.includes(normalized))) continue;
    const retained = current.normalizedParts.map((part, index) => ({ part, text: current.parts[index], selector: current.selectors[index] }))
      .filter((entry) => !(normalized.length > entry.part.length && normalized.includes(entry.part)));
    current.normalizedParts = retained.map((entry) => entry.part);
    current.parts = retained.map((entry) => entry.text);
    current.selectors = retained.map((entry) => entry.selector);
    current.normalizedParts.push(normalized);
    current.parts.push(node.text);
    current.selectors.push(node.selector);
    current.firstY = current.firstY == null ? node.rect.y : Math.min(current.firstY, node.rect.y);
    current.lastY = current.lastY == null ? node.rect.y : Math.max(current.lastY, node.rect.y);
  }
  return groups.filter((group) => group.parts.length).map(({ normalizedParts, ...group }) => group);
}

function latestAssistantReply(snapshot = {}, options = {}) {
  const group = assistantReplyGroups(snapshot, options).at(-1);
  if (!group) return null;
  return {
    text: group.parts.join('\n\n'),
    selectors: group.selectors,
    partCount: group.parts.length,
    firstY: group.firstY,
    lastY: group.lastY
  };
}

function activeConversationTitle(snapshot = {}) {
  const frame = uia.windowRect(snapshot.windowInfo || {});
  const candidates = [];
  for (const element of snapshot.elements || []) {
    const type = uia.controlType(element);
    if (!/(text|heading|button|group|document)/.test(type)) continue;
    const text = uia.normalizeCandidate(nodeText(element));
    if (!text || text.length < 2 || text.length > 120) continue;
    if (/^(chatgpt|chat|work|new chat|share|search|library|projects|settings|home|back|forward)$/i.test(text)) continue;
    if (ASSISTANT_MARKER.test(text) || USER_MARKER.test(text) || uia.isChromeText(text)) continue;

    const rect = uia.rectOf(element);
    if (!rect.width || !rect.height || !frame.width || !frame.height) continue;
    const xRatio = ((rect.x + rect.width / 2) - frame.x) / frame.width;
    const yRatio = ((rect.y + rect.height / 2) - frame.y) / frame.height;
    if (yRatio < 0.01 || yRatio > 0.19 || xRatio < 0.07 || xRatio > 0.88) continue;

    const automationId = uia.propertyText(element, 'automationId').toLowerCase();
    const className = uia.propertyText(element, 'className').toLowerCase();
    const semantic = /conversation|thread|chat[-_ ]?title|header[-_ ]?title/.test(automationId + ' ' + className);

    let score = type.includes('heading') ? 50
      : type.includes('text') ? 30
        : type.includes('button') ? 24 : 12;
    if (semantic) score += 45;
    if (xRatio >= 0.10 && xRatio <= 0.72) score += 14;
    if (yRatio <= 0.11) score += 14;
    if (rect.width >= 60 && rect.width <= frame.width * 0.65) score += 8;
    if (text.length >= 4 && text.length <= 80) score += 5;
    candidates.push({ text, selector: uia.selectorOf(element), rect, type, automationId, score });
  }
  candidates.sort((a, b) => b.score - a.score || a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  return candidates[0] || null;
}

function preferExpandedReply(currentText = '', expandedText = '') {
  const current = uia.normalizeCandidate(currentText);
  const expanded = uia.normalizeCandidate(expandedText);
  if (!expanded) return currentText || '';
  if (!current) return expandedText;
  const flatCurrent = current.replace(/\s+/g, ' ');
  const flatExpanded = expanded.replace(/\s+/g, ' ');
  if (flatExpanded === flatCurrent || flatExpanded.includes(flatCurrent)) return expandedText;
  if (flatCurrent.includes(flatExpanded)) return currentText;
  return currentText;
}

module.exports = {
  ASSISTANT_MARKER,
  USER_MARKER,
  LIVE_STATUS,
  nodeText,
  eligibleReplyNode,
  assistantReplyGroups,
  latestAssistantReply,
  activeConversationTitle,
  preferExpandedReply
};
