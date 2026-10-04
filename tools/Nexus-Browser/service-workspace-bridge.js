'use strict';

const { targetEvent } = require('./local-targets/service-chat-common');

const SUPPORTED_TARGETS = new Set([
  'local:local-moe-chat:default',
  'local:tlo-chat:default'
]);
const DEFAULT_TIMEOUT_MS = 180000;
const hosts = new Map();
const pending = new Map();
let sendSocket = null;

function socketOpen(socket) {
  return !!socket && (socket.readyState === undefined || socket.readyState === 1);
}

function configure({ safeSend } = {}) {
  if (typeof safeSend === 'function') sendSocket = safeSend;
}

function send(socket, payload) {
  if (!socketOpen(socket)) return false;
  if (sendSocket) return sendSocket(socket, payload) !== false;
  if (typeof socket.send !== 'function') return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function normalizedTargets(value) {
  const raw = Array.isArray(value) ? value : [];
  return [...new Set(raw.map((item) => String(item || '').trim()).filter((id) => SUPPORTED_TARGETS.has(id)))];
}

function failPendingForHost(socket, message, code = 'SEARCH_MONITOR_WORKSPACE_REPLACED') {
  for (const [requestId, entry] of [...pending.entries()]) {
    if (entry.host !== socket) continue;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    const error = new Error(message);
    error.code = code;
    entry.reject(error);
  }
}

function registerHost(socket, hello = {}) {
  const workspaceId = String(hello.workspaceId || '').trim();
  if (!workspaceId) {
    const error = new Error('Search Monitor workspace host requires workspaceId.');
    error.code = 'WORKSPACE_ID_REQUIRED';
    throw error;
  }
  const targetIds = normalizedTargets(hello.targets);
  if (!targetIds.length) {
    const error = new Error('Search Monitor workspace host did not advertise a supported service chat.');
    error.code = 'WORKSPACE_TARGETS_REQUIRED';
    throw error;
  }

  const at = Date.now();
  for (const targetId of targetIds) {
    const previous = hosts.get(targetId);
    if (previous?.socket && previous.socket !== socket) {
      failPendingForHost(
        previous.socket,
        `Search Monitor workspace ownership for ${targetId} moved to a newer page.`
      );
    }
    hosts.set(targetId, { socket, workspaceId, connectedAt: at, lastSeenAt: at });
  }
  socket.serviceWorkspaceId = workspaceId;
  socket.serviceWorkspaceTargets = targetIds;
  return targetIds.map((targetId) => snapshot(targetId));
}

function unregisterHost(socket) {
  let removed = false;
  for (const [targetId, entry] of [...hosts.entries()]) {
    if (entry.socket !== socket) continue;
    hosts.delete(targetId);
    removed = true;
  }
  if (removed) {
    failPendingForHost(
      socket,
      'The Search Monitor workspace disconnected before the local-agent turn completed.',
      'SEARCH_MONITOR_WORKSPACE_DISCONNECTED'
    );
  }
  return removed;
}

function hostFor(targetId) {
  const entry = hosts.get(String(targetId || '')) || null;
  if (!entry || !socketOpen(entry.socket)) {
    if (entry) hosts.delete(String(targetId || ''));
    return null;
  }
  return entry;
}

function busyFor(targetId) {
  return [...pending.values()].some((entry) => entry.targetId === targetId);
}

function snapshot(targetId) {
  const id = String(targetId || '');
  const entry = hostFor(id);
  if (!entry) {
    return {
      bound: false,
      running: false,
      busy: false,
      state: 'workspace_unavailable',
      message: 'Open Search Monitor and keep its existing provider workspace available; Nexus will bind to that chat instead of creating a second conversation.'
    };
  }
  const busy = busyFor(id);
  return {
    bound: true,
    running: true,
    busy,
    state: busy ? 'streaming' : 'ready',
    workspaceId: entry.workspaceId,
    connectedAt: entry.connectedAt,
    lastSeenAt: entry.lastSeenAt,
    message: busy
      ? 'Using the existing Search Monitor conversation.'
      : 'Bound to the existing Search Monitor conversation; no shadow provider session is active.'
  };
}

function handleHostMessage(socket, message = {}) {
  const type = String(message.type || '');
  if (type === 'service_workspace_heartbeat') {
    const workspaceId = String(message.workspaceId || socket.serviceWorkspaceId || '');
    for (const entry of hosts.values()) {
      if (entry.socket === socket && entry.workspaceId === workspaceId) entry.lastSeenAt = Date.now();
    }
    return true;
  }
  if (!['service_workspace_partial', 'service_workspace_final', 'service_workspace_error'].includes(type)) return false;

  const requestId = String(message.requestId || '');
  const entry = pending.get(requestId);
  if (!entry || entry.host !== socket) return true;
  if (String(message.targetId || '') !== entry.targetId) return true;
  if (message.workspaceId && String(message.workspaceId) !== entry.workspaceId) return true;

  if (type === 'service_workspace_partial') {
    entry.emit?.(targetEvent(entry.target, requestId, 'response_partial', {
      text: String(message.text || '')
    }));
    return true;
  }

  pending.delete(requestId);
  clearTimeout(entry.timer);
  if (type === 'service_workspace_error') {
    const error = new Error(String(message.error || message.message || 'Search Monitor workspace request failed.'));
    error.code = String(message.code || 'SEARCH_MONITOR_WORKSPACE_ERROR');
    entry.reject(error);
    return true;
  }

  const text = String(message.text || '') || `${entry.target.providerName} completed without a visible response.`;
  entry.emit?.(targetEvent(entry.target, requestId, 'response_final', { text }));
  entry.resolve(text);
  return true;
}

async function sendPrompt({ requestId, text, target, emit, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const id = String(requestId || '').trim();
  const prompt = String(text || '').trim();
  const targetId = String(target?.id || '').trim();
  if (!id || !prompt) {
    const error = new Error('Local provider prompt is empty.');
    error.code = 'LOCAL_PROMPT_EMPTY';
    throw error;
  }
  if (!SUPPORTED_TARGETS.has(targetId)) {
    const error = new Error('This service chat is not owned by the Search Monitor workspace bridge.');
    error.code = 'WORKSPACE_TARGET_UNSUPPORTED';
    throw error;
  }
  if (pending.has(id)) {
    const error = new Error(`Workspace request ${id} is already active.`);
    error.code = 'WORKSPACE_REQUEST_DUPLICATE';
    throw error;
  }
  const host = hostFor(targetId);
  if (!host) {
    const error = new Error(
      `${target?.providerName || 'Local provider'} has no active Search Monitor workspace to bind. ` +
      'Open Search Monitor and leave the existing chat loaded, then retry.'
    );
    error.code = 'SEARCH_MONITOR_WORKSPACE_UNAVAILABLE';
    throw error;
  }
  if (busyFor(targetId)) {
    const error = new Error(`${target?.providerName || 'Local provider'} is already generating in its Search Monitor chat.`);
    error.code = 'SEARCH_MONITOR_WORKSPACE_BUSY';
    throw error;
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const active = pending.get(id);
      if (!active) return;
      pending.delete(id);
      const error = new Error('Search Monitor workspace timed out before completing the turn.');
      error.code = 'SEARCH_MONITOR_WORKSPACE_TIMEOUT';
      reject(error);
    }, Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));

    pending.set(id, {
      targetId,
      target,
      emit,
      resolve,
      reject,
      timer,
      host: host.socket,
      workspaceId: host.workspaceId
    });

    const sent = send(host.socket, {
      type: 'service_workspace_request',
      targetId,
      requestId: id,
      text: prompt,
      workspaceId: host.workspaceId
    });
    if (!sent) {
      pending.delete(id);
      clearTimeout(timer);
      const error = new Error('Search Monitor workspace socket is no longer available.');
      error.code = 'SEARCH_MONITOR_WORKSPACE_DISCONNECTED';
      reject(error);
    }
  });
}

function resetForTests() {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
  hosts.clear();
  sendSocket = null;
}

module.exports = {
  SUPPORTED_TARGETS,
  configure,
  registerHost,
  unregisterHost,
  handleHostMessage,
  snapshot,
  sendPrompt,
  _resetForTests: resetForTests
};
