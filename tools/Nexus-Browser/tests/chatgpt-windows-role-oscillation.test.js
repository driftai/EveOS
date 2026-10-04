'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const progress = require('../app-targets/chatgpt-windows-reply-progress');

test('incomplete role-owned replies accumulate monotonically across visible/full oscillation', () => {
  let mode = 'replace';
  mode = progress.transitionProgressMode(mode, {
    progressMode: 'replace',
    nativeTurn: { completeHint: false }
  });
  assert.equal(mode, 'accumulate');

  const tail = 'NEXUS_TERMINAL_DRIVER_END';
  const full = [
    'NEXUS_TERMINAL_DRIVER_BEGIN',
    'Full provider response body that is intentionally much larger than the visible tail.',
    tail
  ].join('\n\n');

  let captured = progress.mergeReplyProgress('', tail);
  captured = progress.mergeReplyProgress(captured, full);
  assert.equal(captured, full);

  captured = progress.mergeReplyProgress(captured, tail);
  assert.equal(captured, full, 'a later short visible tail must not shrink the richer role-owned reply');

  captured = progress.mergeReplyProgress(captured, full);
  assert.equal(captured, full, 'repeated full/tail polling must converge instead of resetting settle time');
});

test('completed role-owned reply becomes authoritative replace mode', () => {
  let mode = progress.transitionProgressMode('accumulate', {
    progressMode: 'replace',
    nativeTurn: { completeHint: true }
  });
  assert.equal(mode, 'role');

  mode = progress.transitionProgressMode(mode, {
    progressMode: 'replace',
    nativeTurn: { completeHint: false }
  });
  assert.equal(mode, 'role', 'completion must not regress after the action chrome disappears');
});