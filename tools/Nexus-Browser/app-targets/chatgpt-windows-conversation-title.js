'use strict';

const uia = require('./chatgpt-windows-uia');

const ASSISTANT_MARKER = /^(?:chatgpt|assistant)\s+said\s*:?$/i;
const USER_MARKER = /^(?:you|user)\s+said\s*:?$/i;

function nodeText(element = {}) {
  for (const value of [element?.text, element?.value, element?.name]) {
    const text = String(value || '').replace(/\r/g, '').trim();
    if (text) return text;
  }
  return '';
}

function rejectedConversationTitle(text = '') {
  const value = uia.normalizeCandidate(text);
  if (!value) return true;
  if (/^(?:worked|working)\s+for\b/i.test(value)) return true;
  if (/^(?:chatgpt\s+is\s+responding|responding|generating)(?:\.{3}|…)?$/i.test(value)) return true;
  if (/^,\s*expected\s*=*\s*$/i.test(value)) return true;
  if (/^(?:chatgpt|codex|chat|work|new chat|share|search|library|projects|settings|home|back|forward|more(?: options)?|menu|options|minimize|maximize|restore(?: down)?|close(?: window)?|fullscreen|full screen|enter full screen|exit full screen|(?:show|hide|open|close|toggle) sidebar)$/i.test(value)) return true;
  return ASSISTANT_MARKER.test(value) || USER_MARKER.test(value) || uia.isChromeText(value);
}

function activeConversationTitle(snapshot = {}) {
  const frame = uia.windowRect(snapshot.windowInfo || {});
  const candidates = [];
  for (const element of snapshot.elements || []) {
    const type = uia.controlType(element);
    if (!/(text|heading|button|group|document|custom|tabitem|listitem|pane)/.test(type)) continue;
    const text = uia.normalizeCandidate(nodeText(element));
    if (text.length < 2 || text.length > 120 || rejectedConversationTitle(text)) continue;

    const rect = uia.rectOf(element);
    if (!rect.width || !rect.height || !frame.width || !frame.height) continue;
    const xRatio = ((rect.x + rect.width / 2) - frame.x) / frame.width;
    const yRatio = ((rect.y + rect.height / 2) - frame.y) / frame.height;

    const automationId = uia.propertyText(element, 'automationId').toLowerCase();
    const className = uia.propertyText(element, 'className').toLowerCase();
    const semantic = /conversation|thread|chat[-_ ]?title|conversation[-_ ]?title|header[-_ ]?title/
      .test([automationId, className].join(' '));
    const semanticHeader = semantic
      && yRatio >= 0.01 && yRatio <= 0.20
      && xRatio >= 0.06 && xRatio <= 0.92;
    const headingHeader = type.includes('heading')
      && yRatio >= 0.01 && yRatio <= 0.12
      && xRatio >= 0.09 && xRatio <= 0.90
      && rect.height <= Math.max(72, frame.height * 0.11);

    if (!semanticHeader && !headingHeader) continue;
    if (!semantic && !type.includes('heading')) continue;

    let score = type.includes('heading') ? 62
      : type.includes('button') ? 34
        : type.includes('text') ? 30
          : type.includes('tabitem') ? 24
            : type.includes('custom') ? 20 : 12;
    if (semantic) score += 54;
    if (semanticHeader) score += 22;
    if (headingHeader) score += 22;
    if (xRatio >= 0.12 && xRatio <= 0.74) score += 14;
    if (yRatio <= 0.09) score += 14;
    if (rect.width >= 50 && rect.width <= frame.width * 0.70) score += 8;
    if (text.length >= 4 && text.length <= 80) score += 5;
    candidates.push({ text, selector: uia.selectorOf(element), rect, type, automationId, score });
  }
  candidates.sort((a, b) => b.score - a.score || a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  return candidates[0] || null;
}

module.exports = {
  activeConversationTitle,
  rejectedConversationTitle
};
