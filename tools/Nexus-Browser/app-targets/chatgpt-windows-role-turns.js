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
  // Completed replies expose actions such as "Read aloud" immediately beneath
  // the assistant text. Those actions are completion evidence, never live tool
  // activity; classifying them as activity leaves short replies provisional.
  if (RESPONSE_ACTION.test(text)) return false;
  if (TOOL_ACTIVITY.test(text)) return true;
  const meta = [
    uia.selectorOf(element),
    uia.propertyText(element, 'automationId'),
    uia.propertyText(element, 'className')
  ].join(' ').toLowerCase();
  return /(?:tool|status|activity|progress|reason|thinking|search|browse)/.test(meta);
}

function hasToolActivity(snapshot = {}, nodeText = () => '') {
  let role = null, contentBottom = 0;
  const activity = [];
  for (const element of snapshot.elements || []) {
    const text = uia.normalizeCandidate(nodeText(element));
    if (/^(?:you|user)\s+said\s*:?$/i.test(text)) {
      role = 'user'; contentBottom = 0; activity.length = 0; continue;
    }
    if (/^(?:chatgpt|assistant)\s+said\s*:?$/i.test(text)) {
      role = 'assistant'; contentBottom = 0; activity.length = 0; continue;
    }
    if (role !== 'assistant') continue;
    if (element?.isOffscreen === true || uia.propertyText(element, 'IsOffscreen') === 'True') continue;
    const rect = uia.rectOf(element);
    if (isToolActivityElement(element, nodeText)) {
      if (rect.width && rect.height) activity.push(rect.y);
      continue;
    }
    if (/(paragraph|listitem|heading)/.test(uia.controlType(element)) && text && !uia.isChromeText(text)
        && rect.width && rect.height) {
      contentBottom = Math.max(contentBottom, rect.y + rect.height);
    }
  }
  if (!activity.length) return false;
  if (!contentBottom) return true;
  return activity.some((y) => y >= contentBottom - 12);
}

module.exports = { roleTurnPairs, hasCompletionActions, isToolActivityElement, hasToolActivity };
