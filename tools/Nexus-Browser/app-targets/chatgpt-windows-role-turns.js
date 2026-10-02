'use strict';

const uia = require('./chatgpt-windows-uia');

const RESPONSE_ACTION = /^(?:copy|read aloud|regenerate|retry|good response|bad response|response actions|more actions)$/i;
const TOOL_ACTIVITY = /^(?:checking|searching|reading|looking|reviewing|analyzing|inspecting|fetching|opening|browsing|running|testing|verifying|comparing|gathering|preparing|loading|processing)\b[^.!?]{0,100}(?:\.{3}|…)?$/i;

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
  const frame = uia.windowRect(snapshot.windowInfo || {});
  const maxGap = Math.max(96, Math.min(240, Number(frame.height || 0) * 0.24));
  return (snapshot.elements || []).some((element) => {
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
  return !!text && text.length <= 120 && TOOL_ACTIVITY.test(text);
}

function hasToolActivity(snapshot = {}, nodeText = () => '') {
  return (snapshot.elements || []).some((element) =>
    element?.isOffscreen !== true && uia.propertyText(element, 'IsOffscreen') !== 'True'
      && isToolActivityElement(element, nodeText));
}

module.exports = { roleTurnPairs, hasCompletionActions, isToolActivityElement, hasToolActivity };
