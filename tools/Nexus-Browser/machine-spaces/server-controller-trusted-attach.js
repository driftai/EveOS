'use strict';

const { randomBytes } = require('node:crypto');
const { createTrustedTerminalAttachmentRegistry } = require('./trusted-terminal-attachment');

function machineError(code, message) { return Object.assign(new Error(message), { code }); }
function cleanId(value) { return String(value ?? '').trim().slice(0, 128); }

function enhanceMachineSpacesTrustedAttachController(createBaseController, options = {}) {
  const uiSockets = options.uiSockets || new Set();
  const safeSend = options.safeSend || (() => false);
  const adapterSecrets = options.trustedTerminalAdapterSecrets || new Map();
  const registry = options.trustedTerminalAttachments || createTrustedTerminalAttachmentRegistry({
    now: options.now,
    getAdapterSecret: (adapterId) => adapterSecrets.get(String(adapterId || '')) || null
  });
  const base = createBaseController(options);

  function requireLocal(ws) {
    if (!uiSockets.has(ws)) throw machineError('MACHINE_LOCAL_OWNER_REQUIRED', 'Trusted terminal attachment is controlled only by the local Machine Spaces owner.');
  }
  function sendSnapshot(ws) {
    safeSend(ws, { type: 'machine_trusted_attachments', attachments: registry.list(), adapters: [...adapterSecrets.keys()] });
  }
  function registerAdapter(ws, msg) {
    requireLocal(ws);
    const adapterId = cleanId(msg.adapterId);
    if (!adapterId) throw machineError('MACHINE_TRUSTED_ADAPTER_ID_REQUIRED', 'Choose a stable terminal adapter ID.');
    if (adapterSecrets.has(adapterId))
      throw machineError('MACHINE_TRUSTED_ADAPTER_EXISTS', 'That terminal adapter already has a trusted credential. Revoke it before rotating credentials.');
    const secret = randomBytes(32).toString('hex');
    adapterSecrets.set(adapterId, secret);
    // Secret is intentionally returned exactly once to the local owner socket and is never included in snapshots.
    safeSend(ws, { type: 'machine_trusted_adapter_registered', adapterId, adapterSecret: secret });
    sendSnapshot(ws);
  }
  function revokeAdapter(ws, msg) {
    requireLocal(ws);
    const adapterId = cleanId(msg.adapterId);
    if (!adapterSecrets.delete(adapterId))
      throw machineError('MACHINE_TRUSTED_ADAPTER_NOT_FOUND', 'That trusted terminal adapter is not registered.');
    const revoked = registry.revokeAdapter(adapterId);
    safeSend(ws, { type: 'machine_trusted_adapter_revoked', adapterId, revokedAttachmentIds: revoked.map((entry) => entry.attachmentId) });
    sendSnapshot(ws);
  }

  async function handle(ws, msg = {}) {
    const type = String(msg.type || '');
    try {
      if (type === 'machine_trusted_attachments') { requireLocal(ws); sendSnapshot(ws); return true; }
      if (type === 'machine_register_trusted_adapter') { registerAdapter(ws, msg); return true; }
      if (type === 'machine_revoke_trusted_adapter') { revokeAdapter(ws, msg); return true; }
      if (type === 'machine_begin_trusted_attach') {
        requireLocal(ws);
        const challenge = registry.begin({
          targetId: msg.targetId,
          processEpoch: msg.processEpoch,
          adapterId: msg.adapterId,
          ownerId: msg.ownerId,
          cwd: msg.cwd,
          shellType: msg.shellType
        });
        safeSend(ws, { type: 'machine_trusted_attach_challenge', challenge });
        return true;
      }
      if (type === 'machine_attest_trusted_attach') {
        requireLocal(ws);
        const attachment = registry.attest({ challengeId: msg.challengeId, ownerId: msg.ownerId, proof: msg.proof });
        safeSend(ws, { type: 'machine_trusted_attach_changed', action: 'trusted', attachment });
        sendSnapshot(ws);
        return true;
      }
      if (type === 'machine_revoke_trusted_attach') {
        requireLocal(ws);
        const attachment = registry.revoke(msg.attachmentId, 'owner-revoked');
        if (!attachment) throw machineError('MACHINE_TRUSTED_ATTACH_NOT_FOUND', 'Trusted terminal attachment was not found.');
        safeSend(ws, { type: 'machine_trusted_attach_changed', action: 'revoked', attachment });
        sendSnapshot(ws);
        return true;
      }
      return base.handle(ws, msg);
    } catch (error) {
      safeSend(ws, { type: 'error', requestId: msg.requestId || null,
        code: error.code || 'MACHINE_TRUSTED_ATTACH_FAILED', message: error.message });
      return true;
    }
  }

  return {
    ...base,
    handle,
    trustedTerminalAttachments: registry,
    trustedTerminalAdapterSecrets: adapterSecrets
  };
}

module.exports = { enhanceMachineSpacesTrustedAttachController };
