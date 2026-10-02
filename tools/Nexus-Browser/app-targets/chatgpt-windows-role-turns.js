'use strict';

const uia = require('./chatgpt-windows-uia');

const RESPONSE_ACTION = /^(?:copy|read aloud|regenerate|retry|good response|bad response|response actions|more actions)$/i;
const TOOL_ACTIVITY = /^(?:(?:check|search|read|look|review|analy[sz]|inspect|fetch|open|brows|run|test|verif|compar|gather|prepar|load|process|investigat|work|us|call|consult)(?:ing|ed)?|ran|used|called)\b[^.!?]{0,100}(?:\.{3}|…)?$/i;

function roleTurnPairs(groups = []) {
  const pairs = [];
  let user = null, assistant = null;
  const flush = () => { if (user && assistant) pairs.push({ user, assistant }); };
  for (const group of groups) {
    if (group.role === 'user') { flush(); user = group; assistant = null; continue; }
    if (group.role === 'assistant' && user) assistant = group;
  }
  flush();
  return pairs;
}

function hasCompletionActions(snapshot = {}, group = {}, nodeText = () => '') {
  const rects = Array.isArray(group.rects) ? group.rects : [];
  if (!rects.length) return false;
  const bottom = Math.max(...rects.map((rect) => Number(rect.y || 0) + Number(rect.height || 0)));
  const elements = snapshot.elements || [];
  const activityBelow = elements.some((element) => {
    if (element?.isOffscreen === true || uia.propertyText(element, 'IsOffscreen') === 'True') return false;
    const rect = uia.rectOf(element);
    return !!rect.width && !!rect.height && rect.y >= bottom - 12
      && isToolActivityElement(element, nodeText);
  });
  if (activityBelow) return false;
  const frame = uia.windowRect(snapshot.windowInfo || {});
  const maxGap = Math.max(96, Math.min(240, Number(frame.height || 0) * 0.24));
  return elements.some((element) => {
    if (!uia.controlType(element).includes('button')) return false;
    if (element?.isOffscreen === true || uia.propertyText(element, 'IsOffscreen') === 'True') return false;
    if (!RESPONSE_ACTION.test(uia.normalizeCandidate(nodeText(element)))) return false;
    const rect = uia.rectOf(element);
    return !!rect.width && !!rect.height && rect.y >= bottom - 12 && rect.y <= bottom + maxGap;
  });
}

function isToolActivityElement(element = {}, nodeText = () => '') {
  if (/(paragraph|listitem|heading)/.test(uia.controlType(element))) return false;
  const text = uia.normalizeCandidate(nodeText(element));
  if (!text || text.length > 120) return false;
  if (TOOL_ACTIVITY.test(text)) return true;
  const meta = [
    uia.selectorOf(element),
    uia.propertyText(element, 'automationId'),
    uia.propertyText(element, 'className')
  ].join(' ').toLowerCase();
  return /(?:tool|status|activity|progress|reason|thinking|search|browse)/.test(meta)
    && !RESPONSE_ACTION.test(text);
}

function hasToolActivity(snapshot = {}, nodeText = () => '') {
  let role = null;
  for (const element of snapshot.elements || []) {
    const text = uia.normalizeCandidate(nodeText(element));
    if (/^(?:you|user)\s+said\s*:?$/i.test(text)) { role = 'user'; continue; }
    if (/^(?:chatgpt|assistant)\s+said\s*:?$/i.test(text)) { role = 'assistant'; continue; }
    if (role !== 'assistant') continue;
    if (element?.isOffscreen === true || uia.propertyText(element, 'IsOffscreen') === 'True') continue;
    if (isToolActivityElement(element, nodeText)) return true;
  }
  return false;
}

module.exports = { roleTurnPairs, hasCompletionActions, isToolActivityElement, hasToolActivity };
