const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
const chatgpt = fs.readFileSync(path.join(ROOT, 'extension', 'content', 'chatgpt.js'), 'utf8');
const providers = require('../extension/providers.js');

test('ChatGPT page-state helper loads before the adapter in manifest and dynamic injection', () => {
  const group = manifest.content_scripts.find((entry) => entry.matches.includes('https://chatgpt.com/*'));
  assert.ok(group);
  assert.ok(group.js.indexOf('content/chatgpt-page-state.js') < group.js.indexOf('content/chatgpt.js'));
  const providerScripts = providers.getProvider('chatgpt').contentScripts;
  assert.ok(providerScripts.indexOf('content/chatgpt-page-state.js') < providerScripts.indexOf('content/chatgpt.js'));
});

test('ChatGPT watcher snapshots provider issues and emits adapter errors with rebind metadata', () => {
  assert.match(chatgpt, /BrowserAiBridgeChatGptPageState/);
  assert.match(chatgpt, /issues: pageState\.issueSnapshot\(\)/);
  assert.match(chatgpt, /pageState\.findChangedIssue\(watcher\.baselineIssues\)/);
  assert.match(chatgpt, /type: 'adapter_error'/);
  assert.match(chatgpt, /rebindRecommended: !!issue\.rebindRecommended/);
});

test('transient provider issues block premature finalization while they remain visible', () => {
  assert.match(chatgpt, /if \(providerIssueBlocksFinalization\(\)\) return/);
  assert.match(chatgpt, /now - watcher\.issueSince >= graceMs/);
  assert.match(chatgpt, /watcher\.generatingEndedAt = 0/);
});

test('ChatGPT prompt submission confirms departure or committed turn before escalating fallbacks', () => {
  assert.match(chatgpt, /async function waitForPromptDeparture/);
  assert.match(chatgpt, /isCommitted = null/);
  assert.match(chatgpt, /sendControl\.click\(\);[\s\S]{0,220}waitForPromptDeparture\(composer, text, SUBMIT_ATTEMPT_SETTLE_MS, isCommitted\)/);
  assert.match(chatgpt, /form\.requestSubmit\(\)/);
  assert.match(chatgpt, /requestComposerSubmit\(composer\)[\s\S]{0,220}waitForPromptDeparture\(composer, text, SUBMIT_ATTEMPT_SETTLE_MS, isCommitted\)/);
  assert.match(chatgpt, /dispatchComposerEnter\(composer\)/);
  assert.match(chatgpt, /prompt remained in the composer after click, form, and Enter submission attempts/i);
  assert.match(chatgpt, /\.then\(\(submissionMode\) => sendResponse\(\{ ok: true, submissionMode \}\)\)/);
});


test('Dex control results wait longer and follow the hydrated ChatGPT composer', () => {
  assert.match(chatgpt, /DEX_CONTROL_SEND_WAIT_MS = 12000/);
  assert.match(chatgpt, /async function waitForReadyComposer/);
  assert.match(chatgpt, /\['dex-control-result', 'dex-done-watch', 'dex-heads-up', 'dex-control-nudge', 'dex-task-completion', 'dex-stream-nudge'\]\.includes\(delivery\?\.kind\) \? DEX_CONTROL_SEND_WAIT_MS : 5000/);
  assert.match(chatgpt, /const ready = await waitForReadyComposer\(composer, text, sendWaitMs\)/);
  assert.match(chatgpt, /delivery: msg\.delivery \|\| null/);
});

test('native stream errors are classified distinctly and exact-tab recovery loads after ChatGPT runtime', () => {
  const state = require('../extension/content/chatgpt-page-state.js');
  assert.equal(state.classifyIssueText('Error in message stream')?.code, 'CHATGPT_MESSAGE_STREAM_ERROR');
  assert.equal(state.classifyIssueText('The user said Error in message stream')?.code, undefined);
  assert.equal(state.classifyIssueText('Stream cache expired')?.code, 'CHATGPT_STREAM_CACHE_EXPIRED');
  assert.equal(state.classifyIssueText('The docs mention Stream cache expired')?.code, undefined);
  const group = manifest.content_scripts.find((entry) => entry.matches.includes('https://chatgpt.com/*'));
  assert.ok(group.js.indexOf('content/chatgpt-stream-nudge.js') > group.js.indexOf('content/chatgpt.js'));
  assert.ok(providers.getProvider('chatgpt').contentScripts.includes('content/chatgpt-stream-nudge.js'));
  assert.match(chatgpt, /BrowserAiBridgeChatGptStreamNudge\?\.reportDexError/);
  assert.match(chatgpt, /deliveryKind: delivery\?\.kind/);
});
