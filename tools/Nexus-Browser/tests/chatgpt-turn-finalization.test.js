const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const chatgpt = require('../extension/content/chatgpt.js');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content', 'chatgpt.js'), 'utf8');

test('ChatGPT relay suppresses transient thinking/status text', () => {
  assert.equal(chatgpt.substantiveAssistantText('Thinking'), '');
  assert.equal(chatgpt.substantiveAssistantText('Worked for 33s'), '');
  assert.equal(chatgpt.substantiveAssistantText('● Thinking...'), '');
  assert.equal(
    chatgpt.substantiveAssistantText('Thinking\n\nActual response from Eve.'),
    'Actual response from Eve.'
  );
  assert.equal(
    chatgpt.substantiveAssistantText('I am thinking about the actual fix.'),
    'I am thinking about the actual fix.'
  );
});

test('ChatGPT finalization treats transient status text as activity instead of a reply', () => {
  assert.match(source, /const transientOnly = !!String\(rawText \|\| ''\)\.trim\(\) && !text;/);
  assert.match(source, /if \(transientOnly\) \{\s*watcher\.sawGenerating = true;/);
  assert.match(source, /watcher\.sawReliableGenerating = true;/);
  assert.match(source, /const settleMs = malformedDexControl\(watcher\.lastText\) \? STATUS_SIGNAL_SETTLE_MS : generationSettleMs\(\{\s*sawReliableGenerating: watcher\.sawReliableGenerating,\s*text: watcher\.lastText\s*\}\);/);
  assert.match(source, /INCOMPLETE_NO_SIGNAL_SETTLE_MS/);
  assert.match(source, /looksCompleteAssistantText\(watcher\.lastText\)/);
  assert.match(source, /const anchored = answer\.responseTextForUserPrompt/);
  assert.match(source, /returnApi\.freshReply\(answer, watcher\.assistantBaseline\)/);
});

test('capture_latest binds recovery to the expected prompt when provided', () => {
  assert.match(source, /capture_latest[\s\S]{0,260}msg\.expectedPrompt \? answer\.responseTextForUserPrompt\(msg\.expectedPrompt, 0\) : answer\.latestAssistantText\(\)/);
});


test('ChatGPT no-signal completion guard distinguishes obvious partial fragments', () => {
  assert.equal(chatgpt.looksCompleteAssistantText('Let'), false);
  assert.equal(chatgpt.looksCompleteAssistantText('because I want that to shape the'), false);
  assert.equal(chatgpt.looksCompleteAssistantText('That should shape the rest.'), true);
  assert.equal(chatgpt.looksCompleteAssistantText('Ready [[DEX:DONE]]'), true);
});


test('ChatGPT incomplete fragments long-settle even when activity was only status-derived', () => {
  assert.equal(chatgpt.generationSettleMs({
    sawReliableGenerating: true,
    text: 'That'
  }), chatgpt.INCOMPLETE_NO_SIGNAL_SETTLE_MS);

  assert.equal(chatgpt.generationSettleMs({
    sawReliableGenerating: true,
    text: 'That should shape the rest.'
  }), chatgpt.RELIABLE_GENERATION_SETTLE_MS);

  assert.equal(chatgpt.generationSettleMs({
    sawReliableGenerating: false,
    text: 'That'
  }), chatgpt.INCOMPLETE_NO_SIGNAL_SETTLE_MS);

  assert.equal(chatgpt.generationSettleMs({
    sawReliableGenerating: false,
    text: 'SOAK_ACKd_'
  }), chatgpt.INCOMPLETE_NO_SIGNAL_SETTLE_MS);

  assert.equal(chatgpt.generationSettleMs({
    sawReliableGenerating: false,
    text: 'SOAK_ACK[dex-turn-123]'
  }), chatgpt.STATUS_SIGNAL_SETTLE_MS);
});

test('ChatGPT deadline path re-enters guarded sampling instead of force-finalizing arbitrary text', () => {
  assert.match(source, /if \(decision\.action === 'finalize'\) \{\s*sample\(\);/);
  assert.match(source, /if \(active\.has\(requestId\)\) watcher\.timeout = setTimeout\(handleDeadline, 15000\);/);
  assert.doesNotMatch(source, /decision\.action === 'finalize'[\s\S]{0,120}if \(!finalize\(\)\)/);
});


test('ChatGPT finalization binds output to the newly committed prompt turn', () => {
  assert.match(source, /userBaselineCount: Number\(baseline\.userCount \|\| 0\), prompt: String\(baseline\.prompt \|\| ''\)/);
  assert.match(source, /answer\.responseTextForUserPrompt\(watcher\.prompt, watcher\.userBaselineCount\)/);
  assert.doesNotMatch(source, /const isNewNode = nodes\.length > watcher\.baselineCount/);
});


test('ChatGPT keeps obvious fragments fail-closed but can settle stable unpunctuated replies', () => {
  assert.equal(chatgpt.obviouslyPartialAssistantText('R'), true);
  assert.equal(chatgpt.obviouslyPartialAssistantText('because I want that to shape the'), true);
  assert.equal(chatgpt.obviouslyPartialAssistantText('PAUSE-READY received once'), false);
  assert.match(source, /if \(reportedGenerating \|\| \(obviouslyPartialAssistantText\(watcher\.lastText\) && !malformedDexControl\(watcher\.lastText\)\)\) return;/);
  assert.match(source, /allowUnpunctuated: !looksCompleteAssistantText\(watcher\.lastText\)/);
  assert.match(source, /text && obviouslyPartialAssistantText\(text\) \? 'incomplete'/);
  assert.match(source, /text && obviouslyPartialAssistantText\(text\) \? 'incomplete' : 'unknown'/);
});
