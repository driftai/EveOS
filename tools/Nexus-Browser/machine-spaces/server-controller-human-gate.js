'use strict';

const { randomBytes } = require('node:crypto');

const MUTATING_TYPES = new Set([
  'machine_create_space',
  'machine_archive_space',
  'machine_attach_target',
  'machine_detach_target',
  'machine_enable_repo_grant',
  'machine_revoke_repo_grant',
  'machine_enable_file_grant',
  'machine_revoke_file_grant',
  'machine_prepare_governor_job',
  'machine_prepare_recovery_job',
  'machine_prepare_room_recovery',
  'machine_start_supervised_job',
  'machine_chat_approve_supervised_job',
  'machine_rebound_supervised_job',
  'machine_cancel_supervised_job',
  'machine_register_trusted_adapter',
  'machine_revoke_trusted_adapter',
  'machine_begin_trusted_attach',
  'machine_attest_trusted_attach',
  'machine_trusted_attach_interrupt',
  'machine_revoke_trusted_attach'
]);

function machineError(code, message) { return Object.assign(new Error(message), { code }); }

function enhanceMachineSpacesHumanGateController(createBaseController, options = {}) {
  const uiSockets = options.uiSockets || new Set();
  const safeSend = options.safeSend || (() => false);
  const authority = options.humanInputAuthority || null;
  const isPrimaryDex = options.isPrimaryDex || (() => false);
  const now = options.now || (() => Date.now());
  const tokenFactory = options.machineHumanTokenFactory || (() => randomBytes(32).toString('base64url'));
  const enabledControllers = new Set();
  const grants = new Map();
  const hooked = new WeakSet();
  const base = createBaseController(options);

  function local(ws) {
    if (!uiSockets.has(ws)) throw machineError('MACHINE_LOCAL_OWNER_REQUIRED', 'Human Input state can be changed only by a local Nexus UI socket.');
  }
  function hook(ws) {
    if (hooked.has(ws) || typeof ws?.once !== 'function') return;
    hooked.add(ws);
    ws.once('close', () => revokeController(ws));
  }
  function revokeController(ws) {
    enabledControllers.delete(ws);
    for (const [token, grant] of grants) if (grant.controller === ws) grants.delete(token);
  }
  function enabled(ws = null) {
    if (!authority) return ws ? enabledControllers.has(ws) : enabledControllers.size > 0;
    if (ws) return [...grants.values()].some((grant) => grant.controller === ws && now() < grant.expiresAtMs);
    return [...grants.values()].some((grant) => now() < grant.expiresAtMs);
  }
  function publicAuthorization(grant) {
    return Object.freeze({
      token: grant.token,
      roomId: grant.roomId,
      serverEpoch: grant.serverEpoch,
      generation: grant.generation,
      expiresAt: new Date(grant.expiresAtMs).toISOString(),
      kind: 'machine-human-input'
    });
  }
  function setState(ws, value, msg = {}) {
    local(ws); hook(ws);
    if (!authority) {
      if (value === true) enabledControllers.add(ws);
      else enabledControllers.delete(ws);
      const state = enabled(ws);
      safeSend(ws, { type: 'machine_human_input_state', enabled: state });
      return state;
    }
    if (value !== true) {
      revokeController(ws);
      safeSend(ws, { type: 'machine_human_input_state', enabled: false });
      return false;
    }
    if (ws?.clientKind !== 'dex' || !isPrimaryDex(ws))
      throw machineError('MACHINE_HUMAN_INPUT_CONTROLLER_REQUIRED', 'Only the active primary Dex controller may authorize Machine Spaces mutations.');
    const roomId = String(msg.roomId || '').trim();
    const access = authority.validate(ws, msg.authorization, {
      operation: 'machine:control', roomId, kind: 'human-input'
    });
    if (!access.ok) throw machineError(access.code, access.message);
    revokeController(ws);
    const expiresAtMs = Date.parse(access.lease.expiresAt);
    const grant = {
      token: tokenFactory(), controller: ws, roomId,
      holderId: ws.uiHolderId || null,
      sourceAuthorization: msg.authorization,
      serverEpoch: access.lease.serverEpoch,
      generation: access.lease.generation,
      expiresAtMs
    };
    grants.set(grant.token, grant);
    enabledControllers.add(ws);
    safeSend(ws, { type: 'machine_human_input_state', enabled: true,
      roomId, authorization: publicAuthorization(grant) });
    return true;
  }
  function requiresGate(msg = {}) {
    const type = String(msg.type || '');
    if (MUTATING_TYPES.has(type)) return true;
    if (type === 'machine_create_target' || type === 'machine_stop_target' || type === 'machine_interrupt')
      return !!String(msg.roomId || '');
    if (type === 'machine_approve_command') {
      try { return base.approvals?.peek?.(msg.approvalId)?.context?.kind === 'dex'; }
      catch { return false; }
    }
    return false;
  }
  function requireEnabled(ws, msg) {
    local(ws);
    if (!authority) {
      if (!enabled()) throw machineError('MACHINE_HUMAN_INPUT_LOCKED', 'Enable Human Input in Dex before changing Machine Spaces resources or supervised process state.');
      return true;
    }
    const token = String(msg.machineAuthorization?.token || '');
    const grant = grants.get(token);
    if (!grant) throw machineError('MACHINE_HUMAN_INPUT_LOCKED', 'Enable Human Input in this exact Dex viewer before changing Machine Spaces resources or supervised process state.');
    if (!grant.holderId || ws.uiHolderId !== grant.holderId)
      throw machineError('MACHINE_HUMAN_INPUT_HOLDER_MISMATCH', 'Machine Spaces authorization belongs to a different Nexus viewer.');
    const access = authority.validate(grant.controller, grant.sourceAuthorization, {
      operation: 'machine:control', roomId: grant.roomId, kind: 'human-input'
    });
    if (!access.ok) {
      grants.delete(token); enabledControllers.delete(grant.controller);
      throw machineError(access.code, access.message);
    }
    if (now() >= grant.expiresAtMs) {
      grants.delete(token); enabledControllers.delete(grant.controller);
      throw machineError('MACHINE_HUMAN_INPUT_EXPIRED', 'Machine Spaces authorization expired with the Dex Human Input lease.');
    }
    const roomId = String(msg.roomId || base.supervisedJobs?.status?.(msg.jobId)?.roomId
      || base.approvals?.peek?.(msg.approvalId)?.context?.roomId || '').trim();
    if (roomId && roomId !== grant.roomId)
      throw machineError('MACHINE_HUMAN_INPUT_SCOPE_MISMATCH', 'Machine Spaces authorization belongs to a different Dex room.');
    return true;
  }

  async function handle(ws, msg = {}) {
    const type = String(msg.type || '');
    try {
      if (type === 'machine_set_human_input') { setState(ws, msg.enabled === true, msg); return true; }
      if (type === 'machine_human_input_status') {
        local(ws); safeSend(ws, { type: 'machine_human_input_state', enabled: enabled(ws) }); return true;
      }
      if (requiresGate(msg)) requireEnabled(ws, msg);
      return base.handle(ws, msg);
    } catch (error) {
      safeSend(ws, { type: 'error', requestId: msg.requestId || null,
        code: error.code || 'MACHINE_HUMAN_GATE_FAILED', message: error.message });
      return true;
    }
  }

  const previousStop = base.stop?.bind(base);
  function stop() { enabledControllers.clear(); grants.clear(); previousStop?.(); }

  return {
    ...base,
    handle,
    stop,
    humanInputGate: Object.freeze({ enabled, requiresGate })
  };
}

module.exports = { MUTATING_TYPES, enhanceMachineSpacesHumanGateController };
