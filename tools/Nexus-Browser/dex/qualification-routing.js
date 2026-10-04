const crypto = require('node:crypto');
const serviceWorkspaceBridge = require('../service-workspace-bridge');

const RUN_TTL_MS = 12 * 60 * 1000;

function clean(value, max = 4096) {
  return String(value || '').trim().slice(0, max);
}

function isLoopback(address) {
  const value = clean(address, 128).toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function stableFingerprintValue(value) {
  if (Array.isArray(value)) return value.map(stableFingerprintValue);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (key === 'updatedAt') continue;
    out[key] = stableFingerprintValue(value[key]);
  }
  return out;
}

function semanticRoomFingerprint(rooms = []) {
  const value = stableFingerprintValue(Array.isArray(rooms) ? rooms : []);
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function createQualificationRouting({
  safeSend,
  getExtensionSocket,
  getDurability,
  getStateStore,
  restartHook,
  serverSessionId,
  now = () => Date.now()
}) {
  const runs = new Map();
  const pending = new Map();
  serviceWorkspaceBridge.configure({ safeSend });

  function result(ws, requestId, runId, action, ok, data = null, code = null, message = null) {
    safeSend(ws, {
      type: 'qualification_result', requestId: requestId || null, runId: runId || null, action, ok,
      ...(data ? { data } : {}),
      ...(!ok ? { code: code || 'QUALIFICATION_FAILED', message: message || 'Qualification action failed.' } : {})
    });
  }

  function accept(ws) {
    if (!isLoopback(ws?.remoteAddress)) {
      safeSend(ws, { type: 'error', code: 'QUALIFICATION_LOCALHOST_ONLY', message: 'Live qualification is restricted to localhost.' });
      return false;
    }
    ws.role = 'qualification';
    safeSend(ws, { type: 'qualification_hello', serverSessionId });
    return true;
  }

  function liveRun(ws, runId) {
    const id = clean(runId, 200);
    const run = runs.get(id);
    if (!run || run.owner !== ws || run.disposable !== true) return null;
    if (run.expiresAt <= now()) {
      runs.delete(id);
      return null;
    }
    return run;
  }

  function extensionSend(ws, msg, info) {
    const extension = getExtensionSocket();
    if (!extension) {
      result(ws, msg.requestId, msg.runId, info.kind, false, null, 'EXTENSION_OFFLINE', 'Browser extension bridge is not connected.');
      return false;
    }
    const key = String(msg.requestId);
    pending.set(key, { ws, ...info });
    if (!safeSend(extension, msg)) {
      pending.delete(key);
      result(ws, msg.requestId, msg.runId, info.kind, false, null, 'EXTENSION_OFFLINE', 'Browser extension bridge is not connected.');
      return false;
    }
    return true;
  }

  function fingerprint() {
    const rooms = getStateStore()?.load()?.rooms || [];
    return {
      roomFingerprint: semanticRoomFingerprint(rooms),
      roomCount: Array.isArray(rooms) ? rooms.length : 0
    };
  }

  async function handle(ws, msg = {}) {
    const type = clean(msg.type, 80);
    const requestId = clean(msg.requestId, 220);
    const runId = clean(msg.runId, 200);

    // Search Monitor uses the localhost-only qualification transport as a narrow control
    // tunnel for its already-open TLO and Local MoE workspaces. These messages never create
    // qualification runs, browser targets, or provider sessions.
    if (type === 'service_workspace_register') {
      try {
        const workspaces = serviceWorkspaceBridge.registerHost(ws, msg);
        safeSend(ws, {
          type: 'service_workspace_host_ready',
          workspaceId: clean(msg.workspaceId, 220),
          workspaces
        });
      } catch (error) {
        safeSend(ws, {
          type: 'error',
          requestId: requestId || null,
          code: error.code || 'SERVICE_WORKSPACE_REGISTER_FAILED',
          message: error.message
        });
      }
      return true;
    }
    if (type.startsWith('service_workspace_')) {
      if (serviceWorkspaceBridge.handleHostMessage(ws, msg)) return true;
      safeSend(ws, {
        type: 'error', requestId: requestId || null,
        code: 'SERVICE_WORKSPACE_BAD_EVENT', message: `Unsupported service workspace event: ${type}`
      });
      return true;
    }

    if (type === 'qualification_begin') {
      const providerId = clean(msg.providerId, 80);
      const url = clean(msg.url);
      if (!requestId || !runId || !providerId || !url || runs.has(runId)) {
        result(ws, requestId, runId, 'begin', false, null, 'QUALIFICATION_BAD_BEGIN', 'Fresh runId, providerId, exact URL, and requestId are required.');
        return true;
      }
      const run = { runId, providerId, url, owner: ws, disposable: true, targetId: null, expiresAt: now() + RUN_TTL_MS };
      runs.set(runId, run);
      const sent = extensionSend(ws, { type: 'qualification_open_target', requestId, runId, providerId, url }, { kind: 'begin', runId, providerId, url });
      if (!sent) runs.delete(runId);
      return true;
    }

    if (type === 'qualification_resume') {
      const providerId = clean(msg.providerId, 80);
      if (!requestId || !runId || !providerId) {
        result(ws, requestId, runId, 'resume', false, null, 'QUALIFICATION_BAD_RESUME', 'runId, providerId, and requestId are required.');
        return true;
      }
      extensionSend(ws, { type: 'qualification_inspect', requestId, runId }, { kind: 'resume', runId, providerId });
      return true;
    }

    const run = liveRun(ws, runId);
    if (!run) {
      result(ws, requestId, runId, type.replace('qualification_', '') || 'unknown', false, null, 'QUALIFICATION_RUN_NOT_OWNED', 'Action refused because this localhost socket does not own a live disposable qualification run.');
      return true;
    }

    if (type === 'qualification_state_fingerprint') {
      result(ws, requestId, runId, 'state_fingerprint', true, fingerprint());
      return true;
    }

    if (type === 'qualification_close_target') {
      if (clean(msg.providerId, 80) !== run.providerId || Number(msg.tabId) !== Number(run.targetId) || clean(msg.url) !== run.url) {
        result(ws, requestId, runId, 'close_target', false, null, 'QUALIFICATION_OWNERSHIP_MISMATCH', 'Exact run/provider/tab/URL ownership metadata did not match.');
        return true;
      }
      extensionSend(ws, {
        type: 'qualification_close_target', requestId, runId,
        providerId: run.providerId, tabId: Number(run.targetId), url: run.url
      }, { kind: 'close_target', runId });
      return true;
    }

    if (type === 'qualification_ensure_target') {
      extensionSend(ws, {
        type: 'qualification_ensure_target', requestId, runId,
        providerId: run.providerId, url: run.url
      }, { kind: 'ensure_target', runId });
      return true;
    }

    if (type === 'qualification_select_recovery_target') {
      const providerId = clean(msg.providerId, 80);
      if (providerId !== run.providerId) {
        result(ws, requestId, runId, 'select_recovery_target', false, null, 'QUALIFICATION_WARM_PROVIDER_MISMATCH', 'Warm recovery provider did not match the live run.');
        return true;
      }
      extensionSend(ws, {
        type: 'qualification_select_recovery_target', requestId, runId, providerId: run.providerId,
        ...(msg.tabId != null ? { tabId: Number(msg.tabId) } : {})
      }, { kind: 'select_recovery_target', runId });
      return true;
    }

    if (type === 'qualification_inspect') {
      extensionSend(ws, { type: 'qualification_inspect', requestId, runId }, { kind: 'inspect', runId });
      return true;
    }

    if (type === 'qualification_cleanup') {
      restartHook.cancel?.(runId);
      extensionSend(ws, { type: 'qualification_cleanup', requestId, runId, providerId: run.providerId }, { kind: 'cleanup', runId });
      return true;
    }

    if (type === 'qualification_arm_restart') {
      const turnRequestId = clean(msg.turnRequestId, 220);
      const armed = restartHook.arm(runId, turnRequestId);
      result(ws, requestId, runId, 'arm_restart', armed.ok, armed.ok ? { turnRequestId } : null, armed.code, armed.message);
      return true;
    }

    if (type === 'qualification_send_prompt') {
      const turnRequestId = clean(msg.turnRequestId, 220);
      const text = clean(msg.text, 2000);
      if (!turnRequestId || text !== 'QUALIFY_' + runId || !restartHook.isArmed(runId, turnRequestId)) {
        result(ws, requestId, runId, 'send_prompt', false, null, 'QUALIFICATION_PROMPT_REFUSED', 'Only the armed generated QUALIFY_<runId> prompt may cross the live qualification boundary.');
        return true;
      }
      const gate = await getDurability().beforeDispatch(
        { type: 'send_prompt', requestId: turnRequestId, text },
        { targetClassId: 'online-origin', targetId: run.recoveryTargetId || run.targetId, providerId: run.providerId }
      );
      if (!gate.ok) {
        result(ws, requestId, runId, 'send_prompt', false, null, 'DUPLICATE_DISPATCH_BLOCKED', 'Durable turn ledger blocked a duplicate qualification dispatch.');
        return true;
      }
      const extension = getExtensionSocket();
      if (!extension) {
        result(ws, requestId, runId, 'send_prompt', false, null, 'EXTENSION_OFFLINE', 'Extension disconnected after the durable dispatch boundary.');
        return true;
      }
      pending.set(turnRequestId, { ws, kind: 'prompt', runId, turnRequestId });
      if (!safeSend(extension, {
        type: 'send_prompt', requestId: turnRequestId, text, targetClassId: 'online-origin',
        qualification: { runId, targetMode: run.recoveryTargetId ? 'preexisting-warm' : 'disposable-background', exactOnce: true }
      })) {
        pending.delete(turnRequestId);
        result(ws, requestId, runId, 'send_prompt', false, null, 'EXTENSION_OFFLINE', 'Extension disconnected after the durable dispatch boundary.');
        return true;
      }
      result(ws, requestId, runId, 'send_prompt', true, { turnRequestId, durableBoundary: gate.entry?.state || 'dispatching' });
      return true;
    }

    if (type === 'qualification_ledger_query') {
      const turnRequestId = clean(msg.turnRequestId, 220);
      const status = getDurability().query(turnRequestId);
      safeSend(ws, { type: 'turn_ledger_result', requestId, turnRequestId, ...status });
      return true;
    }

    if (type === 'qualification_capture_latest') {
      const extension = getExtensionSocket();
      if (!extension || !safeSend(extension, { type: 'capture_latest', requestId, qualification: { runId, targetMode: run.recoveryTargetId ? 'preexisting-warm' : 'disposable-background' } })) {
        safeSend(ws, { type: 'error', requestId, code: 'EXTENSION_OFFLINE', message: 'Extension is unavailable for qualification recovery capture.' });
        return true;
      }
      pending.set(requestId, { ws, kind: 'capture', runId });
      return true;
    }

    result(ws, requestId, runId, type.replace('qualification_', '') || 'unknown', false, null, 'QUALIFICATION_BAD_ACTION', 'Unsupported qualification action.');
    return true;
  }

  function observeExtension(msg = {}) {
    const requestId = clean(msg.requestId, 220);
    if (!requestId) return false;
    const entry = pending.get(requestId);
    if (!entry) return false;

    if (msg.type === 'qualification_dispatch_committed' && entry.kind === 'prompt') {
      if (clean(msg.runId, 200) !== entry.runId) return false;
      const committed = restartHook.commit(entry.runId, entry.turnRequestId);
      if (!committed.ok) {
        pending.delete(requestId);
        result(entry.ws, requestId, entry.runId, 'restart_commit', false, null, committed.code, committed.message);
      }
      return true;
    }

    if (msg.type === 'qualification_result') {
      pending.delete(requestId);
      if (entry.kind === 'begin') {
        if (!msg.ok) runs.delete(entry.runId);
        else {
          const run = runs.get(entry.runId);
          if (run) {
            run.url = clean(msg.data?.url) || run.url;
            run.targetId = Number(msg.data?.tabId);
          }
        }
      } else if (entry.kind === 'resume' && msg.ok) {
        if (clean(msg.data?.providerId, 80) !== entry.providerId || msg.data?.disposable !== true) {
          result(entry.ws, requestId, entry.runId, 'resume', false, null, 'QUALIFICATION_RESUME_MISMATCH', 'Extension ownership did not match the resumed run.');
          return true;
        }
        runs.set(entry.runId, {
          runId: entry.runId, providerId: entry.providerId, url: clean(msg.data?.url),
          targetId: Number(msg.data?.tabId), recoveryTargetId: msg.data?.recoveryTarget?.tabId == null ? null : Number(msg.data.recoveryTarget.tabId), owner: entry.ws, disposable: true,
          expiresAt: Number(msg.data?.expiresAt || 0)
        });
        const claimedRequestId = clean(msg.data?.promptClaimedRequestId, 220);
        if (claimedRequestId) pending.set(claimedRequestId, {
          ws: entry.ws, kind: 'prompt', runId: entry.runId,
          turnRequestId: claimedRequestId, resumed: true
        });
      } else if (entry.kind === 'ensure_target' && msg.ok) {
        const run = runs.get(entry.runId);
        if (run) {
          run.url = clean(msg.data?.url) || run.url;
          run.targetId = Number(msg.data?.tabId);
        }
      } else if (entry.kind === 'select_recovery_target' && msg.ok) {
        const run = runs.get(entry.runId);
        if (run) { run.recoveryTargetId = Number(msg.data?.tabId); run.recoveryTargetUrl = clean(msg.data?.url); }
      } else if (entry.kind === 'cleanup' && msg.ok) { msg.data = { ...(msg.data || {}), ...fingerprint() }; runs.delete(entry.runId); }
      safeSend(entry.ws, msg);
      return true;
    }

    if (entry.kind === 'capture' && (msg.type === 'capture_result' || msg.type === 'error')) {
      pending.delete(requestId);
      safeSend(entry.ws, msg);
      return true;
    }

    if (entry.kind === 'prompt' && ['prompt_accepted', 'prompt_dispatched', 'response_partial', 'response_final', 'error'].includes(msg.type)) {
      safeSend(entry.ws, msg);
      if (msg.type === 'response_final' || msg.type === 'error') pending.delete(requestId);
      return true;
    }
    return false;
  }

  function dropSocket(ws) {
    serviceWorkspaceBridge.unregisterHost(ws);
    for (const [runId, run] of runs) if (run.owner === ws) { restartHook.cancel?.(runId); runs.delete(runId); }
    for (const [requestId, entry] of pending) if (entry.ws === ws) pending.delete(requestId);
  }

  return { accept, handle, observeExtension, dropSocket, fingerprint, runs, pending };
}

module.exports = { RUN_TTL_MS, clean, isLoopback, semanticRoomFingerprint, createQualificationRouting };
