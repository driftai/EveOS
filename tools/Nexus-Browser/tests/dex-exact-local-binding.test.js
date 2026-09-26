'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const state = require('../dex/server-scheduler-state');
const ui = require('../public/dex-provider-control');
const receipt = require('../dex/provider-control-receipt');

const binding = { targetClassId: 'local-origin', providerId: 'local-antigravity-existing',
  targetId: 'local:antigravity-existing:25032' };
const source = { ...binding };
const other = { ...binding, targetId: 'local:antigravity-existing:25123' };
const member = { id: 'astro', binding };

test('bound Antigravity target dispatches only to its exact provider and PID', () => {
  assert.equal(state.resolveLocal(member, [{ ...binding, id: binding.targetId }]).id, binding.targetId);
  assert.equal(state.resolveLocal(member, [{ ...other, id: other.targetId }]), null);
  assert.equal(state.resolveLocal(member, [{ ...binding, id: binding.targetId,
    providerId: 'local-different' }]), null);
  assert.equal(state.resolveLocal(member, [
    { ...other, id: other.targetId }, { ...binding, id: binding.targetId }
  ]).id, binding.targetId);
  assert.equal(state.resolveLocal(member, [
    { ...binding, id: binding.targetId }, { ...binding, id: binding.targetId }
  ]), null, 'ambiguous duplicate target discovery fails closed');
});

test('provider controls cannot authenticate a new PID using only matching providerId', () => {
  assert.equal(ui.bindingMatchesSource(binding, source), true);
  assert.equal(receipt.bindingMatchesSource(binding, source), true);
  assert.equal(ui.bindingMatchesSource(binding, other), false);
  assert.equal(receipt.bindingMatchesSource(binding, other), false);
  assert.equal(ui.bindingMatchesSource(binding, { ...source, providerId: 'local-codex-existing' }), false);
  assert.equal(receipt.bindingMatchesSource(binding, { ...source, providerId: 'local-codex-existing' }), false);
});

test('missing target identity never authenticates or silently selects another session', () => {
  const missing = { targetClassId: 'local-origin', providerId: 'local-antigravity-existing' };
  assert.equal(ui.bindingMatchesSource(missing, missing), false);
  assert.equal(receipt.bindingMatchesSource(missing, missing), false);
  assert.equal(state.resolveLocal({ binding: missing },
    [{ ...other, id: other.targetId }]), null);
  assert.equal(state.resolveLocal(member, [{ ...binding, id: binding.targetId,
    targetClassId: 'online-origin' }]), null);
});
