'use strict';

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sameRect(left = {}, right = {}, tolerance = 2) {
  const keys = ['x', 'y', 'width', 'height'];
  const a = keys.map((key) => number(left?.[key]));
  const b = keys.map((key) => number(right?.[key]));
  if (a.some((value) => value == null) || b.some((value) => value == null)) return false;
  return a.every((value, index) => Math.abs(value - b[index]) <= tolerance);
}

function duplicateNodeIndex(parts = [], selectors = [], rects = [], text = '', selector = '', rect = {}) {
  return parts.findIndex((part, index) => {
    if (part !== text) return false;
    const priorSelector = String(selectors[index] || '');
    if (selector && priorSelector && selector === priorSelector) return true;
    return sameRect(rects[index], rect);
  });
}

function aggregateCrossesRoleBoundary(text = '') {
  return /(?:^|\n)\s*(?:you|user|chatgpt|assistant)\s+said\s*:?(?:\n|$)/i.test(String(text || ''));
}

module.exports = { sameRect, duplicateNodeIndex, aggregateCrossesRoleBoundary };
