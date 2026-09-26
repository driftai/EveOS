function cleanScreenLine(line) {
  const raw = String(line || '');
  return raw.replace(/[ \t]+[?|│`\u2500-\u257F\uF148]\s*$/u, '').replace(/\s+$/g, '');
}

const screenLines = (text) => String(text || '').replace(/\r/g, '').split('\n').map(cleanScreenLine);
const compactScreenText = (value) => String(value || '').replace(/\s+/g, '').toLowerCase();

function looksReadyForInput(text) {
  const lines = screenLines(text).slice(-12);
  if (lines.some((line) => /esc to cancel/i.test(line))) return false;
  // A historical empty prompt in the visible terminal must never qualify a
  // newer unfinished draft or a response still appearing beneath it.
  let latestPrompt = -1;
  for (let i = 0; i < lines.length; i += 1)
    if (/^\s*>/.test(lines[i])) latestPrompt = i;
  if (latestPrompt < 0 || !/^\s*>\s*[?|│`]?$/.test(lines[latestPrompt])) return false;
  return lines.slice(latestPrompt + 1).every((line) => {
    const value = String(line || '').trim();
    return !value || /^\?\s+for shortcuts/i.test(value)
      || /^[-─═_=~]{8,}/.test(value)
      || /·\s*(low|medium|high)\s*[?|│`]?$/.test(value)
      || /^●\s*\[\d{1,2}:\d{2}:\d{2}\]\s+/.test(value);
  });
}

function isTerminalWidgetLine(line) {
  const t = String(line || '').trim();
  if (!t) return false;
  if (/ctrl\+o to expand|^\s*\(?(ctrl\+o to )?expand\)\s*$/i.test(t)) return true;
  if (/^\s*[?·*•●○◆▶►▸\u2800-\u28FF]?\s*Thought for\s+\d+/i.test(t)) return true;
  if (/^\s*[?·*•●○◆▶►▸\u2800-\u28FF]\s*(Reading|Running|Executing|Searching|Working|Thinking|Loading)\b/i.test(t)) return true;
  if (/^(Thinking|Working|Reading|Running|Executing|Searching|Loading|Analyzing|Generating)(?:\.{1,3}|…)?$/i.test(t)) return true;
  if (/^(Worked|Thought|Reasoned|Searched)\s+for\s+\d+(?:\.\d+)?\s*(?:ms|s|sec(?:onds?)?|m|min(?:utes?)?)$/i.test(t)) return true;
  if (/^\s*[?·*•●○◆▶►▸\u2800-\u28FF]?\s*\[\d{1,2}:\d{2}:\d{2}\]\s+.+\b(running|ready|connected|idle|stopped|waiting)\b/i.test(t)) return true;
  if (/^(?:[+*└]\s*)?Tip:/i.test(t)) return true;
  if (/^How's the CLI experience so far\?/i.test(t)) return true;
  if (/^\[\d+\]\s+(Good|Fine|Bad)\b/i.test(t)) return true;
  if (/^\s*[?·*•●○◆▶►▸\u2800-\u28FF]\s+[A-Za-z0-9_-]+\(.*?\)/.test(t)) return true;
  if (/^\s*[?·*•●○◆▶►▸\u2800-\u28FF]\s+.*\.\.\.[?|│`]?$/i.test(t)) return true;
  return false;
}

function isEmptyPromptLine(line) {
  return /^\s*>\s*[?|│`]?$/.test(String(line || ''));
}

function isDecorativeLine(line) {
  return /^[-─═_=~]{8,}[?|│`]?$/.test(String(line || '').trim());
}

function isStrongReplyStart(line) {
  const t = String(line || '').trim();
  return /^#{1,6}\s+\S/.test(t) || /^```\w*\s*$/.test(t);
}

function isActivityContinuationLine(line) {
  const raw = String(line || '');
  const t = raw.trim();
  if (!/^\s{2,}\S/.test(raw) || !t) return false;
  return /(?:\.\.\.|…)(?:\)|\])?$/.test(t)
    || /(?:file:\/\/\/|ctrl\+o to expand|Get-Process|tests?[\\/]|\.test\.js)/i.test(t)
    || /^[\[\]'"`]/.test(t);
}

function stripActivityPreamble(lines) {
  let lastActivity = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (isTerminalWidgetLine(lines[index])) lastActivity = index;
  }
  if (lastActivity >= 0) {
    for (let index = lastActivity + 1; index < lines.length; index += 1) {
      if (isStrongReplyStart(lines[index])) return lines.slice(index);
    }
  }

  const result = [];
  let continuationBudget = 0;
  for (const line of lines) {
    if (isTerminalWidgetLine(line)) {
      continuationBudget = 2;
      continue;
    }
    if (continuationBudget > 0 && isActivityContinuationLine(line)) {
      continuationBudget -= 1;
      continue;
    }
    if (String(line || '').trim()) continuationBudget = 0;
    result.push(line);
  }
  return result;
}

function promptFooterEvidence(lines, promptIndex) {
  const tail = lines.slice(promptIndex + 1, promptIndex + 7);
  return tail.some((line) => {
    const t = String(line || '').trim();
    return /^\?\s+for shortcuts/i.test(t)
      || /·\s*(low|medium|high)\s*[?|│`]?$/i.test(t)
      || isDecorativeLine(line)
      || isTerminalWidgetLine(line);
  });
}

function returnedPromptBoundary(lines) {
  let sawReply = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = String(lines[index] || '');
    const t = line.trim();
    if (!t) continue;
    if (isEmptyPromptLine(line)) {
      if (sawReply && promptFooterEvidence(lines, index)) return index;
      continue;
    }
    if (isDecorativeLine(line) || isTerminalWidgetLine(line)) continue;
    sawReply = true;
  }
  return -1;
}

function cleanReplyLines(lines) {
  const boundary = returnedPromptBoundary(lines);
  const bounded = boundary >= 0 ? lines.slice(0, boundary) : lines;
  const result = stripActivityPreamble(bounded).filter((line) => !isTerminalWidgetLine(line));
  while (result.length && (
    !result[0].trim() ||
    isDecorativeLine(result[0]) ||
    isEmptyPromptLine(result[0]) ||
    /·\s*(low|medium|high)\s*[?|│`]?$/i.test(result[0]) ||
    /^\s*\?\s+for shortcuts/i.test(result[0]) ||
    /^\s{2,}\S+.*\.\.\.[?|│`]?$/.test(result[0])
  )) result.shift();

  while (result.length && !result[result.length - 1].trim()) result.pop();
  while (result.length && (
    isEmptyPromptLine(result[result.length - 1]) ||
    /^\s*\?\s+for shortcuts/i.test(result[result.length - 1]) ||
    /·\s*(low|medium|high)\s*[?|│`]?$/i.test(result[result.length - 1]) ||
    /esc to cancel/i.test(result[result.length - 1]) ||
    isDecorativeLine(result[result.length - 1]) ||
    /^\s*[+*└]\s*Tip:/i.test(result[result.length - 1]) ||
    /^\s{2,}\S+.*\.\.\.[?|│`]?$/.test(result[result.length - 1])
  )) {
    result.pop();
    while (result.length && !result[result.length - 1].trim()) result.pop();
  }
  return result;
}

function extractReadyStructuredReply(currentText) {
  const lines = screenLines(currentText);
  const boundary = returnedPromptBoundary(lines);
  const bounded = boundary >= 0 ? lines.slice(0, boundary) : lines;
  let lastActivity = -1;
  for (let index = 0; index < bounded.length; index += 1) {
    if (isTerminalWidgetLine(bounded[index])) lastActivity = index;
  }
  let startIndex = -1;
  for (let index = Math.max(0, lastActivity + 1); index < bounded.length; index += 1) {
    if (isStrongReplyStart(bounded[index])) {
      startIndex = index;
      break;
    }
  }
  if (startIndex < 0) return '';
  return cleanReplyLines(bounded.slice(startIndex)).join('\n').trim();
}

function findPromptResponseStart(lines, promptText) {
  const prompt = compactScreenText(promptText);
  if (!prompt) return -1;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith('>')) continue;
    let consumed = compactScreenText(line.slice(1));
    if (!consumed || !prompt.startsWith(consumed)) continue;
    if (consumed.length >= prompt.length) return i + 1;

    for (let j = i + 1; j < lines.length; j += 1) {
      if (!lines[j].trim()) return j + 1;
      const part = compactScreenText(lines[j]);
      if (!part) continue;
      const candidate = consumed + part;
      if (prompt.startsWith(candidate)) {
        consumed = candidate;
        if (consumed.length >= prompt.length) return j + 1;
        continue;
      }
      return j;
    }
    return lines.length;
  }

  for (let i = 0; i < Math.min(lines.length, 8); i += 1) {
    const first = compactScreenText(lines[i]);
    if (!first || first.length < 4) continue;
    let pos = 0;
    while ((pos = prompt.indexOf(first, pos)) >= 0) {
      const idx = pos++;
      let consumed = first;
      let endIdx = i + 1;
      let matchedEnd = idx + consumed.length >= prompt.length;
      for (let j = i + 1; j < lines.length && !matchedEnd; j += 1) {
        const part = compactScreenText(lines[j]);
        if (!part) continue;
        if (!prompt.slice(idx + consumed.length).startsWith(part)) break;
        consumed += part;
        if (idx + consumed.length >= prompt.length) {
          matchedEnd = true;
          endIdx = j + 1;
        }
      }
      if (matchedEnd && consumed.length >= 6) return endIdx;
    }
  }
  return -1;
}

function findPreviousReplyStart(lines, previousReplyText) {
  const previous = cleanReplyLines(screenLines(previousReplyText));
  for (let p = previous.length - 1; p >= 0; p -= 1) {
    const needle = previous[p].trim();
    if (!needle || !/[a-z0-9]{3,}/i.test(needle) || /^[-=─_~*#|`+.\s]+$/.test(needle)) continue;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i].trim() !== needle) continue;
      if (p > 0 && i > 0 && lines[i - 1].trim() !== previous[p - 1].trim()) continue;
      return i;
    }
  }
  return -1;
}

function extractVisibleReply(beforeText, currentText, promptText, previousReplyText = '') {
  const current = screenLines(currentText);
  const before = screenLines(beforeText);
  let start = findPromptResponseStart(current, promptText);
  if (start < 0 && previousReplyText) start = findPreviousReplyStart(current, previousReplyText);
  if (start < 0) {
    let common = 0;
    while (common < current.length && common < before.length && current[common] === before[common]) common += 1;
    start = common;
  }
  return cleanReplyLines(current.slice(start)).join('\n').trim();
}

function isWeakOverlapLine(line) {
  const t = String(line || '').trim();
  if (t.length < 12 || /^[-=─_~*#|`+.\s]+$/.test(t)) return true;
  return (t.match(/[A-Za-z0-9]{2,}/g) || []).length < 2;
}

function countSequence(lines, sequence) {
  let total = 0;
  for (let i = 0; i <= lines.length - sequence.length; i += 1) {
    if (sequence.every((line, index) => line === lines[i + index])) total += 1;
  }
  return total;
}

function reliableContext(sequence, previousLines, nextLines) {
  if (!sequence.length || !sequence.some((line) => !isWeakOverlapLine(line))) return false;
  if (sequence.length === 1 && isWeakOverlapLine(sequence[0])) return false;
  return countSequence(previousLines, sequence) === 1 && countSequence(nextLines, sequence) === 1;
}

function bestTailContext(previousLines, nextLines, { drop = 0, maxOffset = 8 } = {}) {
  const base = drop ? previousLines.slice(0, -drop) : previousLines;
  let best = null;
  for (let offset = 0; offset < Math.min(nextLines.length, maxOffset); offset += 1) {
    const maxCount = Math.min(base.length, nextLines.length - offset);
    for (let count = maxCount; count > 0; count -= 1) {
      const sequence = base.slice(-count);
      if (!sequence.every((line, index) => line === nextLines[offset + index])) continue;
      if (!reliableContext(sequence, previousLines, nextLines)) continue;
      const score = count * 1000 - offset * 10 - drop;
      if (!best || score > best.score) best = { offset, count, drop, score };
      break;
    }
  }
  return best;
}

function hasActivityResidue(text) {
  return /(?:\b(?:Bash|ManageTask|Read|Write|Glob|Grep|sh)\(|ctrl\+o to expand|Thought for\s+\d+|Get-Process|\['[^\n]*\.\.\.)/i.test(String(text || ''));
}

function mergeVisibleReply(previousText, nextText) {
  const previous = String(previousText || '').trim();
  const next = String(nextText || '').trim();
  if (!previous) return next;
  if (!next || previous === next || previous.includes(next)) return previous;
  if (next.startsWith(previous)) return next;

  const previousLines = screenLines(previous);
  const nextLines = screenLines(next);
  const firstNext = nextLines.find((line) => String(line || '').trim());
  if (firstNext && isStrongReplyStart(firstNext) && hasActivityResidue(previous)) return next;

  const exact = bestTailContext(previousLines, nextLines);
  if (exact) {
    return [...previousLines, ...nextLines.slice(exact.offset + exact.count)].join('\n').trim();
  }

  let resync = null;
  for (let drop = 1; drop <= Math.min(3, previousLines.length - 1); drop += 1) {
    const match = bestTailContext(previousLines, nextLines, { drop });
    if (!match) continue;
    if (!resync || match.score > resync.score) resync = match;
  }
  if (resync) {
    const base = previousLines.slice(0, -resync.drop);
    return [...base, ...nextLines.slice(resync.offset + resync.count)].join('\n').trim();
  }

  const maxOverlap = Math.min(previous.length, next.length);
  for (let count = maxOverlap; count >= 24; count -= 1) {
    if (previous.slice(-count) === next.slice(0, count)) return `${previous}${next.slice(count)}`;
  }
  return `${previous}\n\n${next}`;
}

function selectReadyReply(structuredReply, accumulatedReply) {
  const structured = String(structuredReply || '').trim();
  const accumulated = String(accumulatedReply || '').trim();
  if (!structured) return accumulated;
  if (!accumulated || structured === accumulated) return structured;
  if (structured.includes(accumulated)) return structured;

  const structuredAt = accumulated.lastIndexOf(structured);
  if (structuredAt > 0) {
    const prefix = accumulated.slice(0, structuredAt).trim();
    const prefixLines = screenLines(prefix).filter((line) => String(line || '').trim());
    if (prefixLines.length >= 3 && prefixLines.some(isStrongReplyStart)) return accumulated;
  }
  return structured;
}

module.exports = {
  cleanScreenLine,
  screenLines,
  compactScreenText,
  looksReadyForInput,
  isTerminalWidgetLine,
  isEmptyPromptLine,
  isDecorativeLine,
  isStrongReplyStart,
  isActivityContinuationLine,
  stripActivityPreamble,
  promptFooterEvidence,
  returnedPromptBoundary,
  cleanReplyLines,
  findPromptResponseStart,
  findPreviousReplyStart,
  extractVisibleReply,
  mergeVisibleReply,
  extractReadyStructuredReply,
  selectReadyReply
};
