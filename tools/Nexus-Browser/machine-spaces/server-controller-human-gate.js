'use strict';

const MUTATING_TYPES = new Set([
  'machine_create_space',
  'machine_archive_space',
  'machine_attach_target',
  'machine_detach_target',
  'machine_enable_repo_grant',
  'machine_revoke_repo_grant',
  'machine_enable_file_grant',
  'machine_revoke_file_grant',
  'machine_start_supervised_job',
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
  const enabledControllers = new Set();
  const hooked = new WeakSet();
  const base = createBaseController(options);

  function local(ws) {
    if (!uiSockets.has(ws)) throw machineError('MACHINE_LOCAL_OWNER_REQUIRED', 'Human Input state can be changed only by a local Nexus UI socket.');
  }
  function hook(ws) {
    if (hooked.has(ws) || typeof ws?.once !== 'function') return;
    hooked.add(ws);
    ws.once('close', () => enabledControllers.delete(ws));
  }
  function enabled() { return enabledControllers.size > 0; }
  function setState(ws, value) {
    local(ws); hook(ws);
    if (value === true) enabledControllers.add(ws);
    else enabledControllers.delete(ws);
    const state = enabled();
    safeSend(ws, { type: 'machine_human_input_state', enabled: state });
    return state;
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
    if (!enabled()) throw machineError('MACHINE_HUMAN_INPUT_LOCKED', 'Enable Human Input in Dex before changing Machine Spaces resources or supervised process state.');
    return true;
  }

  async function handle(ws, msg = {}) {
    const type = String(msg.type || '');
    try {
      if (type === 'machine_set_human_input') { setState(ws, msg.enabled === true); return true; }
      if (type === 'machine_human_input_status') {
        local(ws); safeSend(ws, { type: 'machine_human_input_state', enabled: enabled() }); return true;
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
  function stop() { enabledControllers.clear(); previousStop?.(); }

  return {
    ...base,
    handle,
    stop,
    humanInputGate: Object.freeze({ enabled, requiresGate })
  };
}

module.exports = { MUTATING_TYPES, enhanceMachineSpacesHumanGateController };