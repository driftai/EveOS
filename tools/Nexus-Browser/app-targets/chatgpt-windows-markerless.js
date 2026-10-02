'use strict';

const { createHash } = require('node:crypto');
const uia = require('./chatgpt-windows-uia');

const TIME_CHROME = /^(?:(?:today|yesterday)(?:\s+at)?\s*)?\d{1,2}:\d{2}\s*(?:am|pm)$/i;
const DATE_CHROME = /^(?:today|yesterday|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)$/i;
const SURFACE_CHROME = /^(?:codex|chatgpt|do anything|show more|show less|create, learn, and explore|build, debug, and ship)$/i;
const COMPLETION_CHROME = /^(?:response complete|response completed|generation complete)(?:\s*[:—-].*)?$/i;
const WORK_STATUS_CHROME = /^(?:working|worked)\s+for\s+(?:(?:\d+(?:\.\d+)?\s*(?:ms|s|sec(?:ond)?s?|m|min(?:ute)?s?|h|hr(?:s)?|hour(?:s)?))\s*)+$/i;

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

function promptComparable(text = '') {
  return uia.normalizeCandidate(text)
    .replace(/(?:\s*(?:show more|show less))$/i, '')
    .replace(/(?:\s*(?:…|\.\.\.))$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function promptOwnsVisibleText(visible = '', expected = '') {
  if (sameText(visible, expected)) return true;
  const shown = promptComparable(visible), full = promptComparable(expected);
  if (full.length < 160 || shown.length < 80 || shown.length >= full.length) return false;
  if (full.startsWith(shown)) return true;
  const compactShown = shown.replace(/\s+/g, ''), compactFull = full.replace(/\s+/g, '');
  return compactShown.length >= 72 && compactFull.startsWith(compactShown);
}

function promptOwnsFragment(visible = '', expected = '') {
  if (promptOwnsVisibleText(visible, expected)) return true;
  const shown = promptComparable(visible), full = promptComparable(expected);
  if (!shown || !full || shown.length >= full.length) return false;
  const words = shown.split(/\s+/).filter(Boolean);
  if (shown.length >= 24 && words.length >= 4 && full.includes(shown)) return true;
  const compactShown = shown.replace(/\s+/g, ''), compactFull = full.replace(/\s+/g, '');
  return compactShown.length >= 24 && words.length >= 4 && compactFull.includes(compactShown);
}

function markerlessChrome(text = '') {
  const value = uia.normalizeCandidate(text);
  return !value || uia.isChromeText(value) || TIME_CHROME.test(value)
    || DATE_CHROME.test(value) || SURFACE_CHROME.test(value) || COMPLETION_CHROME.test(value)
    || WORK_STATUS_CHROME.test(value)
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
  if (xRatio < 0.22 || xRatio > 0.87) return null;
  if (!includeOffscreen && (yRatio < 0.12 || yRatio > 0.93)) return null;
  return {
    index, element, selector, type, text,
    normalized: uia.normalizeCandidate(text),
    rect, xRatio, yRatio, widthRatio,
    centerY: rect.y + rect.height / 2
  };
}

function records(snapshot = {}, options = {}) {
  return (snapshot.elements || [])
    .map((element, index) => recordFor(element, index, snapshot, options))
    .filter(Boolean);
}

function visualRecords(snapshot = {}, options = {}) {
  return records(snapshot, options).sort((a, b) =>
    a.centerY - b.centerY || a.rect.x - b.rect.x || a.index - b.index);
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

function layoutParagraphBreak(previous = null, next = null) {
  if (!previous || !next) return false;
  if (semanticType(previous.type) || semanticType(next.type)) return true;
  const a = previous.rect || {}, b = next.rect || {};
  if (![a.x, a.y, a.width, a.height, b.x, b.y, b.width, b.height]
      .every((value) => Number.isFinite(Number(value)))) return false;
  const gap = Number(b.y) - (Number(a.y) + Number(a.height));
  if (gap <= 0) return false;
  const sameColumn = Math.abs(Number(a.x) - Number(b.x))
    <= Math.max(28, Math.min(Number(a.width), Number(b.width)) * 0.12);
  if (!sameColumn) return false;
  if (gap >= 18) return true;
  const previousText = String(previous.text || '').trim();
  const sentenceEnded = /[.!?]["')\]]?$/.test(previousText);
  const gapThreshold = Math.min(12, Math.max(8,
    Math.min(Number(a.height), Number(b.height)) * 0.25));
  return sentenceEnded && gap >= gapThreshold;
}

function formatParts(parts = []) {
  if (!parts.length) return '';
  const blocks = [];
  let inline = '', previous = null;
  for (const part of parts) {
    const value = String(part.text || '').trim();
    if (!value) continue;
    const blockBoundary = previous && layoutParagraphBreak(previous, part);
    if (semanticType(part.type) || blockBoundary) {
      if (inline) { blocks.push(inline); inline = ''; }
      if (semanticType(part.type)) blocks.push(value);
      else inline = value;
    } else {
      inline = joinInline(inline, value);
    }
    previous = part;
  }
  if (inline) blocks.push(inline);
  return blocks.join('\n\n');
}

function findPromptRecord(snapshot = {}, prompt = '', options = {}) {
  const expected = uia.normalizeCandidate(prompt);
  if (!expected) return null;
  const all = visualRecords(snapshot, options);
  const exact = all.filter((record) => sameText(record.normalized, expected));
  if (exact.length) return exact.at(-1);
  const collapsed = all.filter((record) => promptOwnsVisibleText(record.normalized, expected));
  return collapsed.at(-1) || null;
}

function answerAfterPrompt(snapshot = {}, prompt = '', options = {}) {
  const all = visualRecords(snapshot, options), promptRecord = findPromptRecord(snapshot, prompt, options);
  if (!promptRecord) return { foundPrompt: false, text: '', parts: [], promptRecord: null };
  const parts = [];
  for (const record of all) {
    if (sameText(record.normalized, promptRecord.normalized)) continue;
    if (promptOwnsFragment(record.normalized, prompt)) continue;
    if (record.centerY <= promptRecord.centerY + 6) continue;
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
  const all = visualRecords(snapshot, options);
  const users = all.filter(isLikelyUser);
  const pairs = [];
  for (let userIndex = 0; userIndex < users.length; userIndex += 1) {
    const user = users[userIndex], nextUser = users[userIndex + 1] || null;
    const parts = [];
    for (const record of all) {
      if (record.centerY <= user.centerY + 6) continue;
      if (nextUser && record.centerY >= nextUser.centerY - 6) break;
      if (isLikelyUser(record)) continue;
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
      promptIndex: user.index,
      promptY: user.centerY
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
  const answer = answerAfterPrompt(snapshot, prompt, options);
  if (!answer.foundPrompt || !answer.text) return null;
  const userText = uia.normalizeCandidate(answer.promptRecord?.text || prompt);
  const assistantText = uia.normalizeCandidate(answer.text);
  const pairDigest = createHash('sha256')
    .update('eveos-chatgpt-native-turn-pair-v1\0').update(userText).update('\0').update(assistantText).digest('hex');
  const samePromptPairs = markerlessPairs(snapshot, options)
    .filter((pair) => promptOwnsVisibleText(pair.userText, prompt) && sameText(pair.assistantText, answer.text));
  const occurrence = Math.max(1, samePromptPairs.length);
  return {
    fingerprint: createHash('sha256')
      .update('eveos-chatgpt-native-turn-fingerprint-v1\0')
      .update(pairDigest).update('\0').update(String(occurrence)).digest('hex'),
    text: answer.text,
    selectors: answer.parts.map((part) => part.selector).filter(Boolean),
    partCount: answer.parts.length,
    order: Math.max(0, markerlessPairs(snapshot, options).length - 1)
  };
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
  COMPLETION_CHROME,
  promptComparable,
  promptOwnsVisibleText,
  promptOwnsFragment,
  WORK_STATUS_CHROME,
  markerlessChrome,
  recordFor,
  records,
  visualRecords,
  isLikelyUser,
  isLikelyAssistant,
  layoutParagraphBreak,
  findPromptRecord,
  answerAfterPrompt,
  markerlessPairs,
  completedTurns,
  completedTurnForPrompt,
  hasPrompt,
  latestAssistantReply,
  conversationAnchors
};
