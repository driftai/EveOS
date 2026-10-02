'use strict';

const { createHash } = require('node:crypto');
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

function joinInlineFragments(left = '', right = '') {
  const a = String(left || ''), b = String(right || '');
  if (!a) return b;
  if (!b) return a;
  const noSpaceAfter = /[-_\/(]$/.test(a) || a.endsWith('[') || a.endsWith('{');
  const noSpaceBefore = /^[,.;:!?%)]/.test(b) || b.startsWith(']') || b.startsWith('}');
  return noSpaceAfter || noSpaceBefore ? a + b : a + ' ' + b;
}

function normalizeSyntheticFragmentBreaks(text = '') {
  const raw = String(text || '').replace(/\r/g, '').trim();
  const parts = raw.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) return raw;
  const out = [parts[0]];
  for (let index = 1; index < parts.length; index += 1) {
    const previous = out.at(-1), next = parts[index];
    const explicitBlock = /\n/.test(previous) || /\n/.test(next)
      || /^(?:[-*•]|\d+[.)]|#{1,6}\s|\x60\x60\x60)/.test(next)
      || ((previous.length >= 32 || next.length >= 32)
        && /[.!?]["')\]]?$/.test(previous) && next.length >= 20);
    if (explicitBlock) out.push(next);
    else out[out.length - 1] = joinInlineFragments(previous, next);
  }
  return out.join('\n\n');
}

function groupedMessageText(group = {}) {
  return normalizeSyntheticFragmentBreaks((group.parts || []).join('\n\n'));
}

function latestAssistantReply(snapshot = {}, options = {}) {
  const group = assistantReplyGroups(snapshot, options).at(-1);
  if (!group) return null;
  return {
    text: groupedMessageText(group),
    selectors: group.selectors,
    partCount: group.parts.length,
    firstY: group.firstY,
    lastY: group.lastY
  };
}

function roleMessageGroups(snapshot = {}) {
  const groups = [];
  let current = null;
  for (const element of snapshot.elements || []) {
    const normalized = uia.normalizeCandidate(nodeText(element));
    if (USER_MARKER.test(normalized)) {
      current = { role: 'user', parts: [], normalizedParts: [], selectors: [] };
      groups.push(current);
      continue;
    }
    if (ASSISTANT_MARKER.test(normalized)) {
      current = { role: 'assistant', parts: [], normalizedParts: [], selectors: [] };
      groups.push(current);
      continue;
    }
    if (!current) continue;

    const type = uia.controlType(element);
    if (!/(text|paragraph|document|listitem|heading)/.test(type)) continue;
    const rawText = nodeText(element);
    const text = uia.normalizeCandidate(rawText);
    if (!text || uia.isChromeText(text) || LIVE_STATUS.test(text)
        || USER_MARKER.test(text) || ASSISTANT_MARKER.test(text)) continue;
    const selector = uia.selectorOf(element);
    if (/rootwebarea/i.test(selector)) continue;
    if (Array.isArray(element.children) && element.children.length
        && !type.includes('paragraph') && !type.includes('listitem')) continue;

    if (current.normalizedParts.includes(text)) continue;
    if (current.normalizedParts.some((part) => part.length > text.length && part.includes(text))) continue;
    const retained = current.normalizedParts.map((part, index) => ({
      part,
      text: current.parts[index],
      selector: current.selectors[index]
    })).filter((entry) => !(text.length > entry.part.length && text.includes(entry.part)));
    current.normalizedParts = retained.map((entry) => entry.part);
    current.parts = retained.map((entry) => entry.text);
    current.selectors = retained.map((entry) => entry.selector);
    current.normalizedParts.push(text);
    current.parts.push(rawText);
    current.selectors.push(selector);
  }
  return groups
    .filter((group) => group.parts.length)
    .map(({ normalizedParts, ...group }) => group);
}

function hasRoleMarkers(snapshot = {}) {
  return (snapshot.elements || []).some((element) => {
    const text = uia.normalizeCandidate(nodeText(element));
    return USER_MARKER.test(text) || ASSISTANT_MARKER.test(text);
  });
}

function sameMessageText(left = '', right = '') {
  const a = uia.normalizeCandidate(left).replace(/\s+/g, ' ');
  const b = uia.normalizeCandidate(right).replace(/\s+/g, ' ');
  return !!a && !!b && (a === b || a.replace(/\s+/g, '') === b.replace(/\s+/g, ''));
}

function expandGroupedText(snapshot = {}, rawText = '') {
  const normalized = uia.normalizeCandidate(rawText);
  const compact = normalized.replace(/\s+/g, '');
  if (!compact) return rawText;
  const limit = Math.max(128, normalized.length * 4);
  const candidates = [];
  for (const element of snapshot.elements || []) {
    const type = uia.controlType(element), selector = uia.selectorOf(element);
    if (!type.includes('document') && !/rootwebarea/i.test(selector)) continue;
    const raw = nodeText(element), text = uia.normalizeCandidate(raw);
    if (!text || text.length <= normalized.length || text.length > limit || uia.isChromeText(text)) continue;
    if (text.replace(/\s+/g, '').includes(compact)) candidates.push({ raw, length: text.length });
  }
  candidates.sort((a, b) => a.length - b.length);
  return candidates[0]?.raw || rawText;
}

function completedAssistantTurnForPrompt(snapshot = {}, prompt = '') {
  const groups = roleMessageGroups(snapshot), occurrences = new Map();
  let matched = null;
  for (let index = 1; index < groups.length; index += 1) {
    const user = groups[index - 1], assistant = groups[index];
    if (user.role !== 'user' || assistant.role !== 'assistant') continue;
    const userText = uia.normalizeCandidate(groupedMessageText(user));
    const assistantRaw = normalizeSyntheticFragmentBreaks(expandGroupedText(snapshot, groupedMessageText(assistant)));
    const assistantText = uia.normalizeCandidate(assistantRaw);
    if (!userText || !assistantText) continue;
    const pairDigest = createHash('sha256')
      .update('eveos-chatgpt-native-turn-pair-v1\0').update(userText).update('\0').update(assistantText).digest('hex');
    const occurrence = Number(occurrences.get(pairDigest) || 0) + 1;
    occurrences.set(pairDigest, occurrence);
    if (!sameMessageText(userText, prompt)) continue;
    matched = {
      fingerprint: createHash('sha256')
        .update('eveos-chatgpt-native-turn-fingerprint-v1\0').update(pairDigest).update('\0').update(String(occurrence)).digest('hex'),
      text: assistantRaw, selectors: [...assistant.selectors],
      partCount: assistant.parts.length, order: index
    };
  }
  return matched;
}

function responseForPrompt(snapshot = {}, { prompt = '', baseline = new Set(), includeOffscreen = false } = {}) {
  const turn = completedAssistantTurnForPrompt(snapshot, prompt);
  if (turn) return { text: turn.text, nativeTurn: turn, correlated: true };
  if (hasRoleMarkers(snapshot)) return { text: '', nativeTurn: null, correlated: true };
  const grouped = latestAssistantReply(snapshot, { baseline, prompt, includeOffscreen });
  const fallback = grouped?.text
    || uia.latestResponseCandidate(snapshot, { baseline, prompt })?.text
    || uia.latestCandidate(snapshot.texts || [], { baseline, prompt });
  return { text: fallback || '', nativeTurn: null, correlated: false };
}

function conversationAnchorDigests(snapshot = {}, { limit = 8 } = {}) {
  const groups = roleMessageGroups(snapshot);
  const anchors = [];
  for (let index = 1; index < groups.length; index += 1) {
    const user = groups[index - 1], assistant = groups[index];
    if (user.role !== 'user' || assistant.role !== 'assistant') continue;
    const userText = uia.normalizeCandidate(groupedMessageText(user));
    const assistantText = uia.normalizeCandidate(normalizeSyntheticFragmentBreaks(
      expandGroupedText(snapshot, groupedMessageText(assistant))));
    if (!userText || !assistantText || userText.length + assistantText.length < 24) continue;
    const digest = createHash('sha256')
      .update('eveos-chatgpt-native-conversation-anchor-v1\0')
      .update(userText)
      .update('\0')
      .update(assistantText)
      .digest('hex');
    anchors.push(digest);
  }
  return [...new Set(anchors)].slice(-Math.max(1, Number(limit) || 8));
}

function completedAssistantTurns(snapshot = {}, { limit = 64 } = {}) {
  const groups = roleMessageGroups(snapshot);
  const turns = [], occurrences = new Map();
  for (let index = 1; index < groups.length; index += 1) {
    const user = groups[index - 1], assistant = groups[index];
    if (user.role !== 'user' || assistant.role !== 'assistant') continue;
    const userText = uia.normalizeCandidate(groupedMessageText(user));
    const assistantRaw = normalizeSyntheticFragmentBreaks(expandGroupedText(snapshot, groupedMessageText(assistant)));
    const assistantText = uia.normalizeCandidate(assistantRaw);
    if (!userText || !assistantText) continue;
    const pairDigest = createHash('sha256')
      .update('eveos-chatgpt-native-turn-pair-v1\0').update(userText).update('\0').update(assistantText).digest('hex');
    const occurrence = Number(occurrences.get(pairDigest) || 0) + 1;
    occurrences.set(pairDigest, occurrence);
    const fingerprint = createHash('sha256')
      .update('eveos-chatgpt-native-turn-fingerprint-v1\0').update(pairDigest).update('\0').update(String(occurrence)).digest('hex');
    turns.push({
      fingerprint,
      text: assistantRaw,
      selectors: [...assistant.selectors],
      partCount: assistant.parts.length,
      order: turns.length
    });
  }
  return turns.slice(-Math.max(1, Number(limit) || 64));
}

function conversationIdentity(snapshot = {}) {
  const conversationTitle = activeConversationTitle(snapshot)?.text || '';
  const conversationAnchors = conversationAnchorDigests(snapshot);
  return {
    conversationTitle,
    conversationAnchor: conversationAnchors.at(-1) || '',
    conversationAnchors
  };
}

function activeConversationTitle(snapshot = {}) {
  const frame = uia.windowRect(snapshot.windowInfo || {});
  const candidates = [];
  for (const element of snapshot.elements || []) {
    const type = uia.controlType(element);
    if (!/(text|heading|button|group|document|custom|tabitem|listitem|pane)/.test(type)) continue;
    const text = uia.normalizeCandidate(nodeText(element));
    if (!text || text.length < 2 || text.length > 120) continue;
    if (/^(chatgpt|chat|work|new chat|share|search|library|projects|settings|home|back|forward)$/i.test(text)) continue;
    if (ASSISTANT_MARKER.test(text) || USER_MARKER.test(text) || uia.isChromeText(text)) continue;

    const rect = uia.rectOf(element);
    if (!rect.width || !rect.height || !frame.width || !frame.height) continue;
    const xRatio = ((rect.x + rect.width / 2) - frame.x) / frame.width;
    const yRatio = ((rect.y + rect.height / 2) - frame.y) / frame.height;

    const automationId = uia.propertyText(element, 'automationId').toLowerCase();
    const className = uia.propertyText(element, 'className').toLowerCase();
    const semantic = /conversation|thread|chat[-_ ]?title|header[-_ ]?title/.test(automationId + ' ' + className);
    const strictHeader = yRatio >= 0.01 && yRatio <= 0.12 && xRatio >= 0.09 && xRatio <= 0.90
      && rect.height <= Math.max(72, frame.height * 0.11);
    const semanticHeader = semantic && yRatio >= 0.01 && yRatio <= 0.20 && xRatio >= 0.06 && xRatio <= 0.92;
    if (!strictHeader && !semanticHeader) continue;
    if (!semantic && /^(group|document|pane)$/.test(type)) continue;

    let score = type.includes('heading') ? 58
      : type.includes('text') ? 34
        : type.includes('button') ? 30
          : type.includes('tabitem') ? 26
            : type.includes('custom') ? 20 : 12;
    if (semantic) score += 48;
    if (strictHeader) score += 24;
    if (xRatio >= 0.12 && xRatio <= 0.74) score += 14;
    if (yRatio <= 0.09) score += 14;
    if (rect.width >= 50 && rect.width <= frame.width * 0.70) score += 8;
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
  const compactCurrent = flatCurrent.replace(/\s+/g, ''), compactExpanded = flatExpanded.replace(/\s+/g, '');
  if (flatExpanded === flatCurrent || flatExpanded.includes(flatCurrent) || compactExpanded.includes(compactCurrent)) return expandedText;
  if (flatCurrent.includes(flatExpanded) || compactCurrent.includes(compactExpanded)) return currentText;
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
  roleMessageGroups,
  hasRoleMarkers,
  sameMessageText,
  expandGroupedText,
  completedAssistantTurnForPrompt,
  responseForPrompt,
  conversationAnchorDigests,
  completedAssistantTurns,
  conversationIdentity,
  activeConversationTitle,
  preferExpandedReply,
  normalizeSyntheticFragmentBreaks,
  groupedMessageText
};
