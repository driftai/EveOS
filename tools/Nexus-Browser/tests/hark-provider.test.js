'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const registry = require('../extension/providers.js');
const canonicalHark = registry.getProvider('hark');
const hark = require('../extension/hark-provider.js');
const harkInput = require('../extension/content/hark-input.js');
const harkAnswer = require('../extension/content/hark-answer.js');
const harkBridge = require('../extension/content/hark.js');

const extensionDir = path.join(__dirname, '..', 'extension');

test('Hark is canonical before the compatibility hook loads', () => {
  assert.ok(canonicalHark);
  assert.equal(canonicalHark.id, 'hark');
  assert.equal(canonicalHark, hark);
  assert.equal(registry.PROVIDERS.includes(canonicalHark), true);
});

test('Hark registers as an Online-Origin target for chat and project workspaces', () => {
  assert.equal(hark.id, 'hark');
  assert.equal(hark.name, 'Hark');
  assert.equal(registry.getProvider('hark'), hark);
  assert.deepEqual(hark.matchPatterns, [
    'https://hark.com/chat*',
    'https://hark.com/projects/*'
  ]);
  assert.deepEqual(hark.urlPrefixes, [
    'https://hark.com/chat',
    'https://hark.com/projects/'
  ]);
  assert.equal(registry.providerForUrl('https://hark.com/chat')?.id, 'hark');
  assert.equal(registry.providerForUrl('https://hark.com/chat/abc')?.id, 'hark');
  assert.equal(registry.providerForUrl('https://hark.com/projects/new')?.id, 'hark');
  assert.equal(registry.providerForUrl('https://hark.com/projects/project-123')?.id, 'hark');
  assert.equal(registry.providerForUrl('https://hark.com/settings'), null);
  assert.equal(registry.providerForUrl('https://example.com/chat'), null);
});

test('Hark advertises the normal Nexus chat/capture contract and spawn surface', () => {
  assert.deepEqual(hark.capabilities, {
    chat: true,
    captureLatest: true,
    activity: false,
    searchResults: false
  });
  assert.equal(hark.adapterContract.operations.send, true);
  assert.equal(hark.adapterContract.operations.captureLatest, true);
  assert.equal(hark.adapterContract.operations.recover, true);
  assert.equal(hark.qualification.live, true);
  assert.equal(hark.qualification.warmRecovery, true);
  assert.equal(hark.qualification.exactOnce, true);
  assert.equal(hark.orchestration.spawnUrl, 'https://hark.com/chat');
  assert.equal(registry.publicProviders().find((provider) => provider.id === 'hark')?.orchestration.spawnable, true);
});

test('Hark bridge group includes revision, transport, Dex control and health adapters', () => {
  for (const file of [
    'content/provider-adapter-revision.js',
    'content/hark-input.js',
    'content/hark-answer.js',
    'content/hark.js',
    'content/dex-provider-control.js',
    'content/provider-health.js'
  ]) assert.equal(hark.contentScripts.includes(file), true, file);

  assert.equal(typeof harkInput.findComposer, 'function');
  assert.equal(typeof harkInput.setComposerText, 'function');
  assert.equal(typeof harkInput.findSendControl, 'function');
  assert.equal(typeof harkInput.generationLooksActive, 'function');
  assert.equal(typeof harkAnswer.assistantNodes, 'function');
  assert.equal(typeof harkAnswer.latestAssistantText, 'function');
});

test('Hark response pruning keeps message leaves instead of the whole thread wrapper', () => {
  function node(name, order) {
    return {
      name,
      order,
      descendants: new Set(),
      contains(other) { return this.descendants.has(other); },
      compareDocumentPosition(other) {
        if (this.order < other.order) return 4;
        if (this.order > other.order) return 2;
        return 0;
      }
    };
  }

  const thread = node('thread', 0);
  const olderReply = node('older-reply', 1);
  const latestReply = node('latest-reply', 2);
  thread.descendants.add(olderReply);
  thread.descendants.add(latestReply);

  const pruned = harkAnswer.pruneNestedNodes([thread, latestReply, olderReply]);
  assert.deepEqual(pruned.map((entry) => entry.name), ['older-reply', 'latest-reply']);
});

test('Hark capture never treats a timestamp-only leaf as the reply', () => {
  function leaf(text, attrs = {}) {
    return {
      innerText: text,
      textContent: text,
      className: attrs.className || 'message-time',
      getAttribute: (name) => attrs[name] || null,
      matches: () => false,
      closest: () => null
    };
  }
  for (const stamp of ['11:28 PM', '9:05 am', '23:17', 'Today 11:28 PM', 'Tue, 10:59 p.m.']) {
    assert.equal(harkAnswer.excluded(leaf(stamp)), true, stamp);
  }
  assert.equal(harkAnswer.excluded(leaf('Vera > Juno > Lyra. Meet at 11:28 PM.')), false);
  assert.equal(harkAnswer.excluded(leaf('Got it, Drift.', { className: 'assistant message' })), false);
});

test('Hark live response strips only the exact submitted prompt echo', () => {
  assert.equal(
    harkBridge.stripPromptEcho('test  Got it, Drift. Coming through clean.', 'test'),
    'Got it, Drift. Coming through clean.'
  );
  assert.equal(
    harkBridge.stripPromptEcho(
      'hello 123 from nexus this is drift still testing  Hey Drift, Nexus to Hark is working both ways.',
      'hello 123 from nexus this is drift still testing'
    ),
    'Hey Drift, Nexus to Hark is working both ways.'
  );
  assert.equal(
    harkBridge.stripPromptEcho('testing is useful', 'test'),
    'testing is useful'
  );
  assert.equal(
    harkBridge.stripPromptEcho('line one\nline two   Clean reply.', 'line one\nline two'),
    'Clean reply.'
  );
});

test('extension manifest grants Hark host access and injects only chat/project workspaces', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.host_permissions.includes('https://hark.com/*'), true);
  const group = manifest.content_scripts.find((entry) => entry.js?.includes('content/hark.js'));
  assert.ok(group);
  assert.deepEqual(group.matches, ['https://hark.com/chat*', 'https://hark.com/projects/*']);
  assert.deepEqual(group.js, [
    'content/provider-adapter-revision.js',
    'content/hark-input.js',
    'content/hark-answer.js',
    'content/hark.js',
    'content/dex-provider-control.js',
    'content/provider-health.js'
  ]);
});

test('service worker keeps the Hark compatibility hook after its canonical boot', () => {
  const source = fs.readFileSync(path.join(extensionDir, 'service-worker-entry.js'), 'utf8');
  const baseIndex = source.indexOf("importScripts('service-worker.js')");
  const harkIndex = source.indexOf("importScripts('hark-provider.js')");
  assert.ok(baseIndex >= 0);
  assert.ok(harkIndex > baseIndex);
});

test('Dex provider control resolves the Hark runtime so Hark replies can issue Dex commands', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../extension/content/dex-provider-control.js'), 'utf8');
  assert.match(source, /\{ id: 'hark', answer: 'BrowserAiBridgeHarkAnswer', input: 'BrowserAiBridgeHarkInput' \}/);
});

test('Dex-injected tool results and nudges never read as a malformed or executable command', () => {
  const control = require('../extension/content/dex-provider-control.js');
  const toolResult = [
    '[DEX TOOL RESULT]',
    'OK: New message committed to the durable FIFO.',
    'If another Dex control action is needed, end your next reply with one trailing marker.',
    'Use [[DEX:CMD {"action":"help"}]] for the full room-admin command set.',
    'Common: [[DEX:CMD {"action":"status"}]] or [[DEX:CMD {"action":"send","text":"<message>","relay":true}]].',
    'Otherwise do not emit a Dex command.'
  ].join('\n');
  assert.equal(control.malformedTrailingCommand(toolResult), null);
  assert.equal(control.parseTrailingCommand(toolResult), null);
  assert.equal(control.parseTrailingCommand('[DEX ROOM RELAY]\nRoom: x\n[[DEX:CMD {"action":"status"}]]'), null);
  assert.ok(control.parseTrailingCommand('Checking the room. [[DEX:CMD {"action":"status"}]]'));
});

test('trusted Hark user submissions cannot dispatch Dex commands while Vera replies still can', () => {
  const control = require('../extension/content/dex-provider-control.js');
  const human = 'Human paste. [[DEX:CMD {"action":"status"}]]';
  const assistant = 'Vera reply. [[DEX:CMD {"action":"status"}]]';
  const composer = { tagName: 'TEXTAREA', value: human };

  assert.equal(harkInput.recordTrustedSubmission({
    isTrusted: false, type: 'keydown', key: 'Enter', shiftKey: false, target: composer
  }, { composer }), false, 'synthetic Nexus submission must not be classified as a human gesture');
  assert.equal(harkInput.wasHumanSubmittedText(human), false);

  assert.equal(harkInput.recordTrustedSubmission({
    isTrusted: true, type: 'keydown', key: 'Enter', shiftKey: false, target: composer
  }, { composer }), true);
  assert.equal(harkInput.wasHumanSubmittedText(human), true);
  assert.equal(control.humanSubmittedCandidate({ id: 'hark', input: 'BrowserAiBridgeHarkInput' }, human, harkInput), true);

  assert.equal(control.humanSubmittedCandidate({ id: 'hark', input: 'BrowserAiBridgeHarkInput' }, assistant, harkInput), false);
  assert.ok(control.parseTrailingCommand(assistant), 'a real trailing Vera command remains eligible');
});
