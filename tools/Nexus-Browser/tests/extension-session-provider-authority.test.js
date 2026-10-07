'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createExtensionSessionArbiter } = require('../dex/extension-session-arbiter.js');

function socket(name) {
  return { name };
}

function tabs(count) {
  return Array.from({ length: count }, (_, index) => ({ id: index + 1 }));
}

function providers(ids) {
  return ids.map((id) => ({ id, name: id }));
}

const SIX = ['deepseek', 'grok', 'claude', 'chatgpt', 'gemini', 'muse'];
const SEVEN = ['deepseek', 'grok', 'claude', 'chatgpt', 'gemini', 'hark', 'muse'];

test('same-tab standby with strict provider superset becomes authoritative', () => {
  const arbiter = createExtensionSessionArbiter();
  const oldSocket = socket('old');
  const newSocket = socket('new');

  arbiter.register(oldSocket);
  arbiter.update(oldSocket, { tabs: tabs(6), providers: providers(SIX) });

  arbiter.register(newSocket);
  const authority = arbiter.update(newSocket, { tabs: tabs(6), providers: providers(SEVEN) });

  assert.equal(authority.socket, newSocket);
  assert.equal(arbiter.isPrimary(newSocket), true);
  assert.deepEqual(authority.snapshot.providers.map((provider) => provider.id), SEVEN);
  assert.equal(
    arbiter.diagnostics().recentTransitions.some((entry) => (
      entry.type === 'primary-changed' && entry.reason === 'richer-provider-session'
    )),
    true
  );
});

test('equal-tab equal-size alternate provider set does not preempt primary', () => {
  const arbiter = createExtensionSessionArbiter();
  const primarySocket = socket('primary');
  const standbySocket = socket('standby');
  const alternate = ['deepseek', 'grok', 'claude', 'chatgpt', 'gemini', 'hark'];

  arbiter.register(primarySocket);
  arbiter.update(primarySocket, { tabs: tabs(6), providers: providers(SIX) });
  arbiter.register(standbySocket);
  const authority = arbiter.update(standbySocket, { tabs: tabs(6), providers: providers(alternate) });

  assert.equal(authority.socket, primarySocket);
  assert.equal(arbiter.isPrimary(primarySocket), true);
});

test('fallback authority prefers richer provider registry when tab counts tie', () => {
  const arbiter = createExtensionSessionArbiter();
  const primarySocket = socket('primary');
  const sixProviderSocket = socket('six');
  const sevenProviderSocket = socket('seven');

  arbiter.register(primarySocket);
  arbiter.update(primarySocket, { tabs: tabs(7), providers: providers(SIX) });

  arbiter.register(sixProviderSocket);
  arbiter.update(sixProviderSocket, { tabs: tabs(6), providers: providers(SIX) });

  arbiter.register(sevenProviderSocket);
  arbiter.update(sevenProviderSocket, { tabs: tabs(6), providers: providers(SEVEN) });

  const authority = arbiter.drop(primarySocket);
  assert.equal(authority.socket, sevenProviderSocket);
  assert.deepEqual(authority.snapshot.providers.map((provider) => provider.id), SEVEN);
});
