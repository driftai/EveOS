'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateProof } = require('../machine-spaces/trusted-terminal-attachment');
const { enhanceMachineSpacesTrustedAttachController } = require('../machine-spaces/server-controller-trusted-attach');

function socket() {
  const handlers = new Map();
  return { once(name, fn) { handlers.set(name, fn); }, emit(name) { handlers.get(name)?.(); } };
}

function fixture() {
  const owner = socket(), outsider = socket();
  const uiSockets = new Set([owner]);
  const sent = new Map();
  const safeSend = (ws, payload) => { const values = sent.get(ws) || []; values.push(payload); sent.set(ws, values); return true; };
  const base = {
    handle: async () => false,
    providerControl: { owns: () => false, route: () => false },
    stop() {}
  };
  const controller = enhanceMachineSpacesTrustedAttachController(() => base, { uiSockets, safeSend });
  const messages = (ws) => sent.get(ws) || [];
  return { controller, owner, outsider, messages };
}

test('non-local sockets cannot register adapters or open trusted attachment challenges', async () => {
  const f = fixture();
  await f.controller.handle(f.outsider, { type: 'machine_register_trusted_adapter', adapterId: 'adapter-one' });
  assert.equal(f.messages(f.outsider).at(-1).code, 'MACHINE_LOCAL_OWNER_REQUIRED');
  await f.controller.handle(f.outsider, {
    type: 'machine_begin_trusted_attach', adapterId: 'adapter-one', targetId: 'target', processEpoch: 'epoch', ownerId: 'owner', cwd: 'C:\\repo', shellType: 'powershell'
  });
  assert.equal(f.messages(f.outsider).at(-1).code, 'MACHINE_LOCAL_OWNER_REQUIRED');
});

test('adapter credential is returned once and never appears in snapshots', async () => {
  const f = fixture();
  await f.controller.handle(f.owner, { type: 'machine_register_trusted_adapter', adapterId: 'adapter-one' });
  const registered = f.messages(f.owner).find((msg) => msg.type === 'machine_trusted_adapter_registered');
  assert.ok(registered.adapterSecret);
  const snapshot = f.messages(f.owner).findLast((msg) => msg.type === 'machine_trusted_attachments');
  assert.deepEqual(snapshot.adapters, ['adapter-one']);
  assert.equal(JSON.stringify(snapshot).includes(registered.adapterSecret), false);

  await f.controller.handle(f.owner, { type: 'machine_register_trusted_adapter', adapterId: 'adapter-one' });
  assert.equal(f.messages(f.owner).at(-1).code, 'MACHINE_TRUSTED_ADAPTER_EXISTS');
});

test('local challenge and adapter proof create observe/interrupt-only attachment', async () => {
  const f = fixture();
  await f.controller.handle(f.owner, { type: 'machine_register_trusted_adapter', adapterId: 'adapter-one' });
  const secret = f.messages(f.owner).find((msg) => msg.type === 'machine_trusted_adapter_registered').adapterSecret;
  await f.controller.handle(f.owner, {
    type: 'machine_begin_trusted_attach', adapterId: 'adapter-one', targetId: 'target-one', processEpoch: 'epoch-one',
    ownerId: 'owner-one', cwd: 'C:\\repo', shellType: 'powershell'
  });
  const challenge = f.messages(f.owner).find((msg) => msg.type === 'machine_trusted_attach_challenge').challenge;
  await f.controller.handle(f.owner, {
    type: 'machine_attest_trusted_attach', challengeId: challenge.challengeId, ownerId: 'owner-one', proof: calculateProof(challenge, secret)
  });
  const changed = f.messages(f.owner).find((msg) => msg.type === 'machine_trusted_attach_changed' && msg.action === 'trusted');
  assert.equal(changed.attachment.enabled, true);
  assert.deepEqual(changed.attachment.capabilities, ['observe', 'interrupt']);
  assert.equal(changed.attachment.capabilities.includes('execute'), false);
});

test('revoking an adapter revokes its trusted attachments and removes its credential', async () => {
  const f = fixture();
  await f.controller.handle(f.owner, { type: 'machine_register_trusted_adapter', adapterId: 'adapter-one' });
  const secret = f.messages(f.owner).find((msg) => msg.type === 'machine_trusted_adapter_registered').adapterSecret;
  await f.controller.handle(f.owner, {
    type: 'machine_begin_trusted_attach', adapterId: 'adapter-one', targetId: 'target-one', processEpoch: 'epoch-one',
    ownerId: 'owner-one', cwd: 'C:\\repo', shellType: 'powershell'
  });
  const challenge = f.messages(f.owner).find((msg) => msg.type === 'machine_trusted_attach_challenge').challenge;
  await f.controller.handle(f.owner, {
    type: 'machine_attest_trusted_attach', challengeId: challenge.challengeId, ownerId: 'owner-one', proof: calculateProof(challenge, secret)
  });
  await f.controller.handle(f.owner, { type: 'machine_revoke_trusted_adapter', adapterId: 'adapter-one' });
  const revoked = f.messages(f.owner).find((msg) => msg.type === 'machine_trusted_adapter_revoked');
  assert.equal(revoked.revokedAttachmentIds.length, 1);
  const snapshot = f.messages(f.owner).findLast((msg) => msg.type === 'machine_trusted_attachments');
  assert.deepEqual(snapshot.adapters, []);
  assert.equal(snapshot.attachments[0].enabled, false);
});
