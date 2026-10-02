'use strict';

function tidy(text = '') {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function flat(text = '') {
  return tidy(text).replace(/\s+/g, ' ').trim();
}

function compact(text = '') {
  return flat(text).replace(/\s+/g, '');
}

function looselyContains(haystack = '', needle = '') {
  const outer = flat(haystack), inner = flat(needle);
  if (!outer || !inner) return false;
  if (outer.includes(inner)) return true;
  const compactInner = compact(inner);
  return compactInner.length >= 32 && compact(outer).includes(compactInner);
}

function sameBlock(left = '', right = '') {
  return flat(left) === flat(right)
    || (compact(left).length >= 32 && compact(left) === compact(right));
}

function blocks(text = '') {
  return tidy(text).split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
}

function mergeBlockOverlap(left = '', right = '') {
  const a = blocks(left), b = blocks(right);
  if (a.length < 2 && b.length < 2) return '';
  const max = Math.min(a.length, b.length);
  for (let count = max; count >= 1; count -= 1) {
    let matches = true;
    for (let index = 0; index < count; index += 1) {
      if (!sameBlock(a[a.length - count + index], b[index])) {
        matches = false;
        break;
      }
    }
    if (matches) return [...a, ...b.slice(count)].join('\n\n');
  }
  return '';
}

function mergeCharacterOverlap(left = '', right = '') {
  const a = tidy(left), b = tidy(right);
  const max = Math.min(a.length, b.length);
  for (let count = max; count >= 32; count -= 1) {
    if (a.slice(-count) === b.slice(0, count)) return a + b.slice(count);
  }
  return '';
}

function preferFinalReply(accumulatedText = '', nativeTurnText = '') {
  const accumulated = tidy(accumulatedText), nativeTurn = tidy(nativeTurnText);
  if (!nativeTurn) return accumulated;
  if (!accumulated) return nativeTurn;
  if (flat(accumulated) === flat(nativeTurn)) return nativeTurn;

  if (looselyContains(accumulated, nativeTurn)) return accumulated;
  if (looselyContains(nativeTurn, accumulated)) return nativeTurn;

  const accumulatedSize = compact(accumulated).length;
  const nativeSize = compact(nativeTurn).length;
  if (nativeSize >= accumulatedSize * 1.2) return nativeTurn;
  if (accumulatedSize >= nativeSize * 1.2) return accumulated;

  const accumulatedBlocks = blocks(accumulated).length;
  const nativeBlocks = blocks(nativeTurn).length;
  if (nativeBlocks > accumulatedBlocks) return nativeTurn;
  if (accumulatedBlocks > nativeBlocks) return accumulated;

  return nativeSize >= accumulatedSize ? nativeTurn : accumulated;
}

function needsTailGuard(text = '') {
  const value = tidy(text);
  return !!value && (blocks(value).length >= 4 || compact(value).length >= 320);
}

function mergeReplyProgress(currentText = '', candidateText = '') {
  const current = tidy(currentText), candidate = tidy(candidateText);
  if (!candidate) return current;
  if (!current) return candidate;

  const currentFlat = flat(current), candidateFlat = flat(candidate);
  if (currentFlat === candidateFlat) return current;
  if (looselyContains(current, candidate)) return current;
  if (looselyContains(candidate, current)) return candidate;

  const blockMerged = mergeBlockOverlap(current, candidate);
  if (blockMerged) return blockMerged;

  const characterMerged = mergeCharacterOverlap(current, candidate);
  if (characterMerged) return characterMerged;

  return current + '\n\n' + candidate;
}

function transitionProgressMode(current = 'replace', observed = {}) {
  if (current === 'native' || current === 'role') return current;
  if (observed.nativeTurn && observed.nativeTurn.completeHint === false) return 'accumulate';
  if (observed.progressMode === 'replace' && observed.nativeTurn) return 'role';
  if (observed.progressMode === 'accumulate') return 'accumulate';
  return current;
}

function mergeObservedProgress(currentText = '', candidateText = '', mode = 'replace') {
  if (mode === 'native') return currentText;
  if (mode === 'role') return preferFinalReply(currentText, candidateText);
  if (mode === 'accumulate') return mergeReplyProgress(currentText, candidateText);
  return candidateText || currentText;
}

function needsCompletionGuard(text = '', mode = 'replace') {
  const value = tidy(text);
  if (mode === 'accumulate') {
    // Incomplete native role turns use accumulate mode so viewport tails cannot
    // replace a fuller reply. A substantial single-block opening still needs
    // repeated authoritative confirmation before it can be finalized.
    return needsTailGuard(value) || compact(value).length >= 160;
  }
  return mode === 'role'
    && (blocks(value).length >= 2 || compact(value).length >= 220);
}

module.exports = {
  tidy,
  flat,
  compact,
  looselyContains,
  mergeBlockOverlap,
  mergeCharacterOverlap,
  preferFinalReply,
  needsTailGuard,
  transitionProgressMode,
  mergeObservedProgress,
  needsCompletionGuard,
  mergeReplyProgress
};