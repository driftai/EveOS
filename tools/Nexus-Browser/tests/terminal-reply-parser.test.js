const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractVisibleReply,
  mergeVisibleReply,
  selectReadyReply,
  reconstructTerminalReturn
} = require('../local-targets/terminal-reply-parser');

test('reflow resync replaces a stale wrapped link tail instead of cross-splicing later text', () => {
  const previous = [
    "2. Modular Architecture Guidance: Logged Eve's",
    'architectural feedback—when approaching line',
    'limits on core files going forward, we will',
    'extract clean modular helpers (e.g., [terminal-',
    'reply-parser.js](file:///C:/Users/alv'
  ].join('\n');
  const next = [
    'architectural feedback—when approaching line',
    'limits on core files going forward, we will',
    'extract dedicated submodules (terminal-reply-parser.js, safe-paste.js)',
    'rather than horizontal condensation.'
  ].join('\n');

  assert.equal(mergeVisibleReply(previous, next), [
    "2. Modular Architecture Guidance: Logged Eve's",
    'architectural feedback—when approaching line',
    'limits on core files going forward, we will',
    'extract dedicated submodules (terminal-reply-parser.js, safe-paste.js)',
    'rather than horizontal condensation.'
  ].join('\n'));
});

test('reflow resync replaces a malformed partial sentence after strong prior context', () => {
  const previous = [
    '3. Architecture Protocol Noted:',
    'files approach the 450-line ceiling, we will',
    'extract dedicate***'
  ].join('\n');
  const next = [
    'files approach the 450-line ceiling, we will',
    'extract dedicated submodules (terminal-reply-parser.js, safe-paste.js)',
    'rather than condensing one-liners.'
  ].join('\n');

  assert.equal(mergeVisibleReply(previous, next), [
    '3. Architecture Protocol Noted:',
    'files approach the 450-line ceiling, we will',
    'extract dedicated submodules (terminal-reply-parser.js, safe-paste.js)',
    'rather than condensing one-liners.'
  ].join('\n'));
});

test('partial streaming line still completes when its preceding context is unique', () => {
  const previous = '1. First step.\n2. Second step.\n3. Session Handshake: A single 105-character\n  comm';
  const next = '3. Session Handshake: A single 105-character\n  command arrived in this terminal:\n4. Final step.';
  assert.equal(
    mergeVisibleReply(previous, next),
    '1. First step.\n2. Second step.\n3. Session Handshake: A single 105-character\n  command arrived in this terminal:\n4. Final step.'
  );
});

test('offset viewport head resync keeps prior history while replacing the provisional tail', () => {
  const previous = 'header\n[Nexus Browser Client]\n[isSafePasteCandidate Check]\n  +-- Short Single-Line (<1500 chars, no\nfences) --? Direct CONIN$ Injection\n  +-- Multiline / Fe';
  const next = 'Something above\n[isSafePasteCandidate Check]\n  +-- Short Single-Line (<1500 chars, no\nfences) --? Direct CONIN$ Injection\n  +-- Multiline / Fenced (>=1500 chars) --? Safe Paste\nMore content';
  assert.equal(
    mergeVisibleReply(previous, next),
    'header\n[Nexus Browser Client]\n[isSafePasteCandidate Check]\n  +-- Short Single-Line (<1500 chars, no\nfences) --? Direct CONIN$ Injection\n  +-- Multiline / Fenced (>=1500 chars) --? Safe Paste\nMore content'
  );
});

test('repeated single-line anchors are not trusted for stitching', () => {
  const previous = 'A\nRepeated anchor line long enough\nX\nRepeated anchor line long enough\nY';
  const next = 'Repeated anchor line long enough\nNew';
  assert.equal(mergeVisibleReply(previous, next), `${previous}\n\n${next}`);
});

test('prompt-tail recovery remains intact after parser extraction', () => {
  const prompt = 'Read "C:\\test\\inbox\\payload.md" as my exact user message. Preserve its formatting and respond to its contents.';
  const current = [
    '  "C:\\test\\inbox\\payload.md" as my exact user',
    '  message. Preserve its formatting and respond to',
    '  its contents.',
    '──────────────────────────────────────────────',
    '? Read(~/Downloads/test.md) (ctrl+o to expand)',
    '? Thought for 2s',
    'Actual reply starts here.',
    '>',
    '? for shortcuts              Gemini 3.8 Flash · high'
  ].join('\n');
  assert.equal(
    extractVisibleReply('Previous\n>\n? for shortcuts', current, prompt),
    'Actual reply starts here.'
  );
});

test('reconstructTerminalReturn joins line-wrapped return marker matching expectedTurnId', () => {
  const wrapped = 'Turn finished.\n  [[DEX:RETURN:dex-turn-315f54a5-7416-411e-b4a2-\n  facdbdd25b31]] [[DEX:DONE]]';
  const expected = 'dex-turn-315f54a5-7416-411e-b4a2-facdbdd25b31';
  const reconstructed = reconstructTerminalReturn(wrapped, expected);
  assert.equal(reconstructed, 'Turn finished.\n  [[DEX:RETURN:dex-turn-315f54a5-7416-411e-b4a2-facdbdd25b31]] [[DEX:DONE]]');
});

test('reconstructTerminalReturn leaves non-matching expectedTurnId or blockquoted returns untouched', () => {
  const wrapped = 'Turn finished.\n  [[DEX:RETURN:dex-turn-315f54a5-7416-411e-b4a2-\n  facdbdd25b31]] [[DEX:DONE]]';
  const mismatch = 'dex-turn-99999999-0000-0000-0000-000000000000';
  assert.equal(reconstructTerminalReturn(wrapped, mismatch), wrapped);

  const quoted = 'Quote:\n  > [[DEX:RETURN:dex-turn-315f54a5-7416-411e-b4a2-\n  > facdbdd25b31]] [[DEX:DONE]]';
  assert.equal(reconstructTerminalReturn(quoted, 'dex-turn-315f54a5-7416-411e-b4a2-facdbdd25b31'), quoted);
});

test('selectReadyReply applies expectedTurnId reconstruction to chosen output', () => {
  const wrapped = 'Structured reply body.\n[[DEX:RETURN:dex-turn-315f54a5-7416-411e-b4a2-\nfacdbdd25b31]] [[DEX:DONE]]';
  const expected = 'dex-turn-315f54a5-7416-411e-b4a2-facdbdd25b31';
  const chosen = selectReadyReply(wrapped, '', expected);
  assert.equal(chosen, 'Structured reply body.\n[[DEX:RETURN:dex-turn-315f54a5-7416-411e-b4a2-facdbdd25b31]] [[DEX:DONE]]');
});

test('wrapped return reconstruction rejects inline prose and fenced examples even with exact turn ID', () => {
  const expected = 'dex-turn-315f54a5-7416-411e-b4a2-facdbdd25b31';
  const inline = 'Example: [[DEX:RETURN:dex-turn-315f54a5-7416-411e-b4a2-\nfacdbdd25b31]]';
  assert.equal(reconstructTerminalReturn(inline, expected), inline);
  const fenced = 'Example:\n' + String.fromCharCode(96).repeat(3)
    + '\n[[DEX:RETURN:dex-turn-315f54a5-7416-411e-b4a2-\nfacdbdd25b31]]';
  assert.equal(reconstructTerminalReturn(fenced, expected), fenced);
  const continuation = 'Finished.\n[[DEX:RETURN:dex-turn-315f54a5-7416-411e-b4a2-\nfacdbdd25b31]]\nAnd now more prose.';
  assert.equal(reconstructTerminalReturn(continuation, expected), continuation);
  const badSuffix = 'Finished.\n[[DEX:RETURN:dex-turn-315f54a5-7416-411e-b4a2-\nfacdbdd25b31]] do not execute';
  assert.equal(reconstructTerminalReturn(badSuffix, expected), badSuffix);
});

test('console wraps an exact RETURN after preceding BUDGET or CONTEXT markers without losing budget', () => {
  const protocol = require('../public/dex-protocol');
  const expected = 'dex-turn-315f54a5-7416-411e-b4a2-facdbdd25b31';
  const partial = 'dex-turn-315f54a5-7416-411e-b4a2-';
  const wrapped = 'Work complete.\n[[DEX:BUDGET:+4]] [[DEX:RETURN:' + partial
    + '\nfacdbdd25b31]]';
  const fixed = reconstructTerminalReturn(wrapped, expected);
  const parsed = protocol.parseAgentReply(fixed);
  assert.equal(parsed.text, 'Work complete.');
  assert.equal(parsed.budgetIncrease, 4);
  assert.equal(parsed.returnRequestId, expected);
  assert.equal(parsed.malformedCommand, undefined);
  const two = 'Qualified.\n[[DEX:CONTEXT:12]] [[DEX:BUDGET:+4]] [[DEX:RETURN:'
    + partial + '\nfacdbdd25b31]]';
  const second = protocol.parseAgentReply(selectReadyReply(two, '', expected));
  assert.equal(second.contextOverride, 12);
  assert.equal(second.budgetIncrease, 4);
  assert.equal(second.returnRequestId, expected);
});
test('preceding-control reflow still rejects blockquotes, fenced examples and inline prose', () => {
  const expected = 'dex-turn-315f54a5-7416-411e-b4a2-facdbdd25b31';
  const partial = 'dex-turn-315f54a5-7416-411e-b4a2-';
  const candidates = [
    'Example: [[DEX:BUDGET:+4]] [[DEX:RETURN:' + partial + '\nfacdbdd25b31]]',
    'Quoted:\n> [[DEX:BUDGET:+4]] [[DEX:RETURN:' + partial + '\nfacdbdd25b31]]',
    'Fenced:\n' + String.fromCharCode(96).repeat(3) + '\n[[DEX:BUDGET:+4]] [[DEX:RETURN:'
      + partial + '\nfacdbdd25b31]]',
    'Finished.\n[[DEX:BUDGET:+4]] [[DEX:RETURN:' + partial
      + '\nfacdbdd25b31]] and more prose'
  ];
  for (const item of candidates) assert.equal(reconstructTerminalReturn(item, expected), item);
});
