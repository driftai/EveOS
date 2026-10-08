'use strict';

const { randomBytes } = require('node:crypto');
const { createTrustedTerminalAttachmentRegistry } = require('./trusted-terminal-attachment');
const { createExternalTerminalProcessAdapter } = require('./external-terminal-process-adapter');

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
  const processAdapter = options.externalTerminalProcessAdapter || createExternalTerminalProcessAdapter(
    options.externalTerminalProcessAdapterOptions || {}
  );
  const base = createBaseController(options);

  function requireLocal(ws) {
    if (!uiSockets.has(ws)) throw machineError('MACHINE_LOCAL_OWNER_REQUIRED', 'Trusted terminal attachment is controlled only by the local Machine Spaces owner.');
  }
  function sendSnapshot(ws) {
    safeSend(ws, { type: 'machine_trusted_attachments', attachments: registry.list(), adapters: [...adapterSecrets.keys()] });
  }
  function registeredAdapter(adapterId) {
    const id = cleanId(adapterId);
    if (!id || !adapterSecrets.has(id))
      throw machineError('MACHINE_TRUSTED_ADAPTER_NOT_FOUND', 'Register the trusted terminal adapter before probing or attaching an external process.');
    return id;
  }
  function attachment(attachmentId) {
    const id = cleanId(attachmentId);
    const record = registry.list().find((entry) => entry.attachmentId === id) || null;
    if (!record) throw machineError('MACHINE_TRUSTED_ATTACH_NOT_FOUND', 'Trusted terminal attachment was not found.');
    return record;
  }
  function authorize(attachmentId, capability) {
    const record = attachment(attachmentId);
    const decision = registry.authorize(record.attachmentId, {
      targetId: record.targetId,
      processEpoch: record.processEpoch,
      adapterId: record.adapterId,
      capability
    });
    if (!decision.allowed)
      throw machineError('MACHINE_TRUSTED_ATTACH_NOT_AUTHORIZED', `Trusted terminal ${capability} is unavailable: ${decision.reason}.`);
    return decision.attachment;
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
      if (type === 'machine_probe_external_terminal') {
        requireLocal(ws);
        const adapterId = registeredAdapter(msg.adapterId);
        const target = processAdapter.probe({ pid: msg.pid, cwd: msg.cwd, shellType: msg.shellType, adapterId });
        safeSend(ws, { type: 'machine_external_terminal_probe', requestId: msg.requestId || null, target });
        return true;
      }
      if (type === 'machine_begin_trusted_attach') {
        requireLocal(ws);
        registeredAdapter(msg.adapterId);
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
        // Attestation is accepted only while the exact external process epoch still exists.
        processAdapter.observe({ targetId: attachment.targetId, processEpoch: attachment.processEpoch });
        safeSend(ws, { type: 'machine_trusted_attach_changed', action: 'trusted', attachment });
        sendSnapshot(ws);
        return true;
      }
      if (type === 'machine_trusted_attach_observe') {
        requireLocal(ws);
        const trusted = authorize(msg.attachmentId, 'observe');
        const observation = processAdapter.observe({ targetId: trusted.targetId, processEpoch: trusted.processEpoch });
        safeSend(ws, { type: 'machine_trusted_attach_observation', requestId: msg.requestId || null,
          attachmentId: trusted.attachmentId, observation });
        return true;
      }
      if (type === 'machine_trusted_attach_interrupt') {
        requireLocal(ws);
        const trusted = authorize(msg.attachmentId, 'interrupt');
        const result = processAdapter.interrupt({ targetId: trusted.targetId, processEpoch: trusted.processEpoch });
        safeSend(ws, { type: 'machine_trusted_attach_interrupt_result', requestId: msg.requestId || null,
          attachmentId: trusted.attachmentId, result });
        return true;
      }
      if (type === 'machine_revoke_trusted_attach') {
        requireLocal(ws);
        const changed = registry.revoke(msg.attachmentId, 'owner-revoked');
        if (!changed) throw machineError('MACHINE_TRUSTED_ATTACH_NOT_FOUND', 'Trusted terminal attachment was not found.');
        safeSend(ws, { type: 'machine_trusted_attach_changed', action: 'revoked', attachment: changed });
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
    trustedTerminalAdapterSecrets: adapterSecrets,
    externalTerminalProcessAdapter: processAdapter
  };
}

module.exports = { enhanceMachineSpacesTrustedAttachController };