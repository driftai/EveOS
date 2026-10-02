'use strict';

const { createHash } = require('node:crypto');
const uia = require('./chatgpt-windows-uia');

const TIME_CHROME = /^(?:(?:today|yesterday)(?:\s+at)?\s*)?\d{1,2}:\d{2}\s*(?:am|pm)$/i;
const DATE_CHROME = /^(?:today|yesterday|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)$/i;
const SURFACE_CHROME = /^(?:codex|chatgpt|do anything|create, learn, and explore|build, debug, and ship)$/i;

function rawText(element = {}) {
  for (const value of [element?.text, element?.value, element?.name]) {
    const text = String(value || '').replace(/\r/g, '').trim();
    if (text) return text;
  }
  return '';
}

function sameText(left = '', right = '') {
  const a = uia.normalizeCandidate(left).replace(/\s+/g, ' ');
  const b = uia.normalizeCandidate(right).replace(/\s+/g, ' ');
  return !!a && !!b && (a === b || a.replace(/\s+/g, '') === b.replace(/\s+/g, ''));
}

function markerlessChrome(text = '') {
  const value = uia.normalizeCandidate(text);
  return !value || uia.isChromeText(value) || TIME_CHROME.test(value)
    || DATE_CHROME.test(value) || SURFACE_CHROME.test(value)
    || /^today\s+\d{1,2}:\d{2}\s*(?:am|pm)$/i.test(value);
}

function semanticType(type = '') {
  return /(?:paragraph|listitem|heading)/.test(String(type || '').toLowerCase());
}

function rectContains(outer = {}, inner = {}, tolerance = 3) {
  const values = [outer.x, outer.y, outer.width, outer.height, inner.x, inner.y, inner.width, inner.height];
  if (!values.every((value) => Number.isFinite(Number(value)))) return false;
  const ox = Number(outer.x), oy = Number(outer.y), ow = Number(outer.width), oh = Number(outer.height);
  const ix = Number(inner.x), iy = Number(inner.y), iw = Number(inner.width), ih = Number(inner.height);
  return ix >= ox - tolerance && iy >= oy - tolerance
    && ix + iw <= ox + ow + tolerance && iy + ih <= oy + oh + tolerance;
}

function recordFor(element, index, snapshot = {}, { includeOffscreen = false } = {}) {
  const type = uia.controlType(element);
  if (!/(text|paragraph|document|listitem|heading)/.test(type)) return null;
  if (!includeOffscreen && (element?.isOffscreen === true || uia.propertyText(element, 'IsOffscreen') === 'True')) return null;
  if (Array.isArray(element.children) && element.children.length
      && !type.includes('paragraph') && !type.includes('listitem')) return null;
  const selector = uia.selectorOf(element);
  if (/rootwebarea/i.test(selector)) return null;
  const text = rawText(element);
  if (markerlessChrome(text)) return null;
  const rect = uia.rectOf(element), frame = uia.windowRect(snapshot.windowInfo || {});
  if (!rect.width || !rect.height || !frame.width || !frame.height) return null;
  const xRatio = ((rect.x + rect.width / 2) - frame.x) / frame.width;
  const yRatio = ((rect.y + rect.height / 2) - frame.y) / frame.height;
  const widthRatio = rect.width / frame.width;
  if (xRatio < 0.22 || xRatio > 0.87 || yRatio < 0.12 || (!includeOffscreen && yRatio > 0.93)) return null;
  return {
    index, element, selector, type, text,
    normalized: uia.normalizeCandidate(text),
    rect, xRatio, yRatio, widthRatio
  };
}

function records(snapshot = {}, options = {}) {
  return (snapshot.elements || [])
    .map((element, index) => recordFor(element, index, snapshot, options))
    .filter(Boolean);
}

function isLikelyUser(record = {}) {
  return record.xRatio >= 0.62 && record.widthRatio <= 0.60;
}

function isLikelyAssistant(record = {}, prompt = null) {
  if (!record) return false;
  if (prompt?.xRatio >= 0.58) return record.xRatio <= Math.min(0.79, prompt.xRatio - 0.035);
  return record.xRatio <= 0.76;
}

function joinInline(left = '', right = '') {
  if (!left) return right;
  if (!right) return left;
  const noSpaceAfter = /[-_\/(]$/.test(left) || left.endsWith('[') || left.endsWith('{');
  const noSpaceBefore = /^[,.;:!?%)]/.test(right) || right.startsWith(']') || right.startsWith('}');
  return noSpaceAfter || noSpaceBefore ? left + right : left + ' ' + right;
}

function addPart(parts, record) {
  if (parts.some((part) => part.normalized === record.normalized)) return;
  const containing = parts.find((part) => semanticType(part.type)
    && part.normalized.length > record.normalized.length
    && part.normalized.includes(record.normalized)
    && rectContains(part.rect, record.rect));
  if (containing) return;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (semanticType(record.type)
        && record.normalized.length > part.normalized.length
        && record.normalized.includes(part.normalized)
        && rectContains(record.rect, part.rect)) parts.splice(index, 1);
  }
  parts.push(record);
}

function formatParts(parts = []) {
  if (!parts.length) return '';
  const blocks = [];
  let inline = '';
  for (const part of parts) {
    const value = String(part.text || '').trim();
    if (!value) continue;
    if (semanticType(part.type)) {
      if (inline) { blocks.push(inline); inline = ''; }
      blocks.push(value);
    } else {
      inline = joinInline(inline, value);
    }
  }
  if (inline) blocks.push(inline);
  return blocks.join('\n\n');
}

function findPromptRecord(snapshot = {}, prompt = '', options = {}) {
  const expected = uia.normalizeCandidate(prompt);
  if (!expected) return null;
  const matches = records(snapshot, options).filter((record) => sameText(record.normalized, expected));
  return matches.sort((a, b) => a.index - b.index || a.rect.y - b.rect.y).at(-1) || null;
}

function answerAfterPrompt(snapshot = {}, prompt = '', options = {}) {
  const all = records(snapshot, options), promptRecord = findPromptRecord(snapshot, prompt, options);
  if (!promptRecord) return { foundPrompt: false, text: '', parts: [], promptRecord: null };
  const parts = [];
  const promptCenterY = promptRecord.rect.y + promptRecord.rect.height / 2;
  for (const record of all) {
    if (record.index <= promptRecord.index) continue;
    if (sameText(record.normalized, promptRecord.normalized)) continue;
    const centerY = record.rect.y + record.rect.height / 2;
    if (centerY < promptCenterY - 8) continue;
    if (isLikelyUser(record)) {
      if (parts.length) break;
      continue;
    }
    if (!isLikelyAssistant(record, promptRecord)) continue;
    addPart(parts, record);
  }
  return {
    foundPrompt: true,
    text: formatParts(parts),
    parts,
    promptRecord
  };
}

function markerlessPairs(snapshot = {}, options = {}) {
  const all = records(snapshot, options);
  const users = all.filter(isLikelyUser);
  const pairs = [];
  for (const user of users) {
    const parts = [];
    const userCenterY = user.rect.y + user.rect.height / 2;
    for (const record of all) {
      if (record.index <= user.index) continue;
      const centerY = record.rect.y + record.rect.height / 2;
      if (centerY < userCenterY - 8) continue;
      if (isLikelyUser(record)) break;
      if (!isLikelyAssistant(record, user)) continue;
      addPart(parts, record);
    }
    const assistantText = formatParts(parts);
    if (!assistantText) continue;
    pairs.push({
      userText: user.text,
      assistantText,
      selectors: parts.map((part) => part.selector).filter(Boolean),
      partCount: parts.length,
      promptIndex: user.index
    });
  }
  return pairs;
}

function fingerprintPairs(pairs = []) {
  const occurrences = new Map();
  return pairs.map((pair, order) => {
    const userText = uia.normalizeCandidate(pair.userText);
    const assistantText = uia.normalizeCandidate(pair.assistantText);
    const pairDigest = createHash('sha256')
      .update('eveos-chatgpt-native-turn-pair-v1\0').update(userText).update('\0').update(assistantText).digest('hex');
    const occurrence = Number(occurrences.get(pairDigest) || 0) + 1;
    occurrences.set(pairDigest, occurrence);
    return {
      ...pair,
      order,
      fingerprint: createHash('sha256')
        .update('eveos-chatgpt-native-turn-fingerprint-v1\0')
        .update(pairDigest).update('\0').update(String(occurrence)).digest('hex')
    };
  });
}

function completedTurns(snapshot = {}, { limit = 64, includeOffscreen = true } = {}) {
  return fingerprintPairs(markerlessPairs(snapshot, { includeOffscreen }))
    .map((pair) => ({
      fingerprint: pair.fingerprint,
      text: pair.assistantText,
      selectors: pair.selectors,
      partCount: pair.partCount,
      order: pair.order
    }))
    .slice(-Math.max(1, Number(limit) || 64));
}

function completedTurnForPrompt(snapshot = {}, prompt = '', options = {}) {
  const pairs = fingerprintPairs(markerlessPairs(snapshot, options));
  const matched = pairs.filter((pair) => sameText(pair.userText, prompt)).at(-1);
  return matched ? {
    fingerprint: matched.fingerprint,
    text: matched.assistantText,
    selectors: matched.selectors,
    partCount: matched.partCount,
    order: matched.order
  } : null;
}

function hasPrompt(snapshot = {}, prompt = '', options = {}) {
  return !!findPromptRecord(snapshot, prompt, options);
}

function latestAssistantReply(snapshot = {}, options = {}) {
  const pair = markerlessPairs(snapshot, options).at(-1);
  return pair ? {
    text: pair.assistantText,
    selectors: pair.selectors,
    partCount: pair.partCount,
    firstY: null,
    lastY: null
  } : null;
}

function conversationAnchors(snapshot = {}, { limit = 8 } = {}) {
  const anchors = markerlessPairs(snapshot, { includeOffscreen: true }).map((pair) =>
    createHash('sha256')
      .update('eveos-chatgpt-native-conversation-anchor-v1\0')
      .update(uia.normalizeCandidate(pair.userText)).update('\0')
      .update(uia.normalizeCandidate(pair.assistantText)).digest('hex'));
  return [...new Set(anchors)].slice(-Math.max(1, Number(limit) || 8));
}

module.exports = {
  TIME_CHROME,
  markerlessChrome,
  recordFor,
  records,
  isLikelyUser,
  isLikelyAssistant,
  findPromptRecord,
  answerAfterPrompt,
  markerlessPairs,
  completedTurns,
  completedTurnForPrompt,
  hasPrompt,
  latestAssistantReply,
  conversationAnchors
};
