const test = require('node:test');
const assert = require('node:assert/strict');
const { PROVIDERS, getProvider, providerForUrl, publicProviders } = require('../extension/providers.js');

test('provider registry exposes six concrete Online-Origin target providers', () => {
  assert.deepEqual(PROVIDERS.map((provider) => provider.id), ['deepseek', 'grok', 'claude', 'chatgpt', 'gemini', 'muse']);
  for (const [id, name] of [
    ['deepseek', 'DeepSeek'], ['grok', 'Grok'], ['claude', 'Claude'],
    ['chatgpt', 'ChatGPT'], ['gemini', 'Gemini'], ['muse', 'Muse']
  ]) assert.equal(getProvider(id).name, name);

  assert.equal(providerForUrl('https://chat.deepseek.com/a/chat/s/test')?.id, 'deepseek');
  assert.equal(providerForUrl('https://grok.com/c/test')?.id, 'grok');
  assert.equal(providerForUrl('https://x.com/i/grok?conversation=test')?.id, 'grok');
  assert.equal(providerForUrl('https://claude.ai/chat/test')?.id, 'claude');
  assert.equal(providerForUrl('https://chatgpt.com/c/test')?.id, 'chatgpt');
  assert.equal(providerForUrl('https://gemini.google.com/app/test')?.id, 'gemini');
  assert.equal(providerForUrl('https://aistudio.google.com/prompts/test')?.id, 'gemini');
  assert.equal(providerForUrl('https://muse.ai/')?.id, 'muse');
  assert.equal(providerForUrl('https://muse.ai/chat')?.id, 'muse');
  assert.equal(providerForUrl('https://auth.muse.ai/aymh/')?.id, undefined);
  assert.equal(providerForUrl('https://x.com/home'), null);
  assert.equal(providerForUrl('https://example.com/'), null);
});

test('Grok provider owns both grok.com and x.com/i/grok without creating a third Grok provider', () => {
  const grok = getProvider('grok');
  assert.deepEqual(grok.matchPatterns, ['https://grok.com/*', 'https://x.com/i/grok*']);
  assert.deepEqual(grok.urlPrefixes, ['https://grok.com/', 'https://x.com/i/grok']);
});

test('Claude provider owns claude.ai new and conversation routes', () => {
  const claude = getProvider('claude');
  assert.deepEqual(claude.matchPatterns, ['https://claude.ai/*']);
  assert.deepEqual(claude.urlPrefixes, ['https://claude.ai/']);
  assert.equal(claude.contentScripts.includes('content/claude-input.js'), true);
  assert.equal(claude.contentScripts.includes('content/claude-answer.js'), true);
  assert.equal(claude.contentScripts.includes('content/claude.js'), true);
  assert.equal(claude.contentScripts.includes('content/claude-activity.js'), true);
});

test('ChatGPT provider owns chatgpt.com root and conversation routes', () => {
  const chatgpt = getProvider('chatgpt');
  assert.deepEqual(chatgpt.matchPatterns, ['https://chatgpt.com/*']);
  assert.deepEqual(chatgpt.urlPrefixes, ['https://chatgpt.com/']);
  assert.deepEqual(chatgpt.contentScripts, [
    'content/provider-adapter-revision.js',
    'content/response-deadline.js',
    'content/chatgpt-page-state.js',
    'content/chatgpt-input.js',
    'content/chatgpt-delivery-watchdog.js',
    'content/chatgpt-answer.js',
    'content/chatgpt-return.js',
    'content/chatgpt.js',
    'content/chatgpt-stream-nudge.js',
    'content/dex-provider-control.js',
    'content/provider-health.js'
  ]);
});

test('Gemini provider owns both Gemini app and AI Studio without creating a second Google provider', () => {
  const gemini = getProvider('gemini');
  assert.deepEqual(gemini.matchPatterns, ['https://gemini.google.com/*', 'https://aistudio.google.com/*']);
  assert.deepEqual(gemini.urlPrefixes, ['https://gemini.google.com/', 'https://aistudio.google.com/']);
  assert.deepEqual(gemini.contentScripts, [
    'content/provider-adapter-revision.js',
    'content/gemini-input.js',
    'content/gemini-answer.js',
    'content/gemini.js',
    'content/dex-provider-control.js',
    'content/provider-health.js'
  ]);
});

test('Muse provider owns the authenticated muse.ai app and advertises agent-native potential separately from bridged parity', () => {
  const muse = getProvider('muse');
  assert.deepEqual(muse.matchPatterns, ['https://muse.ai/*']);
  assert.deepEqual(muse.urlPrefixes, ['https://muse.ai/']);
  assert.deepEqual(muse.contentScripts, [
    'content/provider-adapter-revision.js',
    'content/prompt-delivery.js',
    'content/muse-input.js',
    'content/muse-answer.js',
    'content/muse.js',
    'content/dex-provider-control.js',
    'content/provider-health.js'
  ]);
  assert.deepEqual(muse.capabilities, { chat: true, captureLatest: true, activity: false, searchResults: false });
  assert.equal(muse.agentFeatures.persistentCloudComputer, true);
  assert.equal(muse.agentFeatures.backgroundTasks, true);
  assert.equal(muse.agentFeatures.proactiveMessages, true);
  assert.equal(muse.agentFeatures.approvals, true);
  assert.equal(muse.agentFeatures.artifacts, true);
});

test('provider capabilities describe current bridge parity without inventing unsupported integration features', () => {
  const deepseek = getProvider('deepseek');
  const grok = getProvider('grok');
  const claude = getProvider('claude');
  const chatgpt = getProvider('chatgpt');
  const gemini = getProvider('gemini');
  const muse = getProvider('muse');

  assert.deepEqual(deepseek.capabilities, { chat: true, captureLatest: true, activity: true, searchResults: true });
  assert.deepEqual(grok.capabilities, { chat: true, captureLatest: true, activity: true, searchResults: false });
  assert.deepEqual(claude.capabilities, { chat: true, captureLatest: true, activity: true, searchResults: false });
  assert.deepEqual(chatgpt.capabilities, { chat: true, captureLatest: true, activity: false, searchResults: false });
  assert.deepEqual(gemini.capabilities, { chat: true, captureLatest: true, activity: false, searchResults: false });
  assert.deepEqual(muse.capabilities, { chat: true, captureLatest: true, activity: false, searchResults: false });

  assert.deepEqual(
    publicProviders().map(({ id, name }) => ({ id, name })),
    [
      { id: 'deepseek', name: 'DeepSeek' },
      { id: 'grok', name: 'Grok' },
      { id: 'claude', name: 'Claude' },
      { id: 'chatgpt', name: 'ChatGPT' },
      { id: 'gemini', name: 'Gemini' },
      { id: 'muse', name: 'Muse' }
    ]
  );
  assert.equal(publicProviders().find((provider) => provider.id === 'muse').agentFeatures.approvals, true);
});

test('live qualification capabilities are provider-declared rather than Muse-specific', () => {
  for (const item of PROVIDERS) {
    assert.equal(item.qualification.live, true, item.id);
    assert.equal(item.qualification.warmRecovery, true, item.id);
    assert.equal(item.qualification.exactOnce, true, item.id);
    assert.equal(item.qualification.urlPrefix.startsWith('https://'), true, item.id);
  }
  assert.deepEqual(getProvider('gemini').qualification.deniedWarmUrlPrefixes, ['https://aistudio.google.com/']);
  assert.equal(getProvider('gemini').qualification.allowStartupRedirect, true);
  assert.equal(PROVIDERS.filter((item) => item.id !== 'gemini').some((item) => item.qualification.allowStartupRedirect), false);
  assert.equal(publicProviders().every((item) => item.qualification?.exactOnce === true), true);
});


test('public provider metadata exposes the versioned adapter contract for scheduler consumers', () => {
  for (const provider of publicProviders()) {
    assert.equal(provider.adapterContract.version, 1, provider.id);
    assert.equal(provider.adapterContract.capabilitySchemaVersion, 1, provider.id);
    assert.equal(provider.adapterContract.agentFeatureSchemaVersion, 1, provider.id);
    assert.equal(provider.adapterContract.operations.send, true, provider.id);
    assert.equal(provider.adapterContract.operations.captureLatest, true, provider.id);
    assert.equal(provider.adapterContract.operations.recover, true, provider.id);
    assert.equal(provider.adapterContract.operations.health, true, provider.id);
  }
});
