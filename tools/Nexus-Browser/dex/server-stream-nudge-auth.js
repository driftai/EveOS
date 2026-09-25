'use strict';
// Read-only Dex room authorization for a *separate* ChatGPT continuation
// prompt. A nudge is never a scheduler turn or permission to replay a task.
function createServerStreamNudgeAuth({
  getState = () => null, getTabs = () => [], extensionReady = () => false,
  maintenanceBusy = () => false
} = {}) {
  const metrics = { requests: 0, allowed: 0, deferred: 0, denied: 0 };
  const REASONS = new Set(['CHATGPT_MESSAGE_STREAM_ERROR', 'CHATGPT_STREAM_CACHE_EXPIRED']);
  const CHAT = (value) => {
    try { const url = new URL(String(value || '')); return url.protocol === 'https:'
      && url.hostname === 'chatgpt.com' && !url.username && !url.password; }
    catch { return false; }
  };
  function check(input = {}) {
    metrics.requests++;
    const source = input.source || {}, tabId = Number(source.targetId);
    const deny = (code, deferred = false) => {
      metrics[deferred ? 'deferred' : 'denied']++;
      return { ok: false, code, retryable: deferred };
    };
    if (!REASONS.has(input.reason)
      || source.targetClassId !== 'online-origin' || source.providerId !== 'chatgpt'
      || !Number.isSafeInteger(tabId) || tabId < 1 || !CHAT(source.url)
      || !/^(?:native|dex)-[a-z0-9-]{8,128}$/i.test(String(input.turnKey || ''))) {
      return deny('STREAM_NUDGE_BAD_SOURCE');
    }
    if (!extensionReady()) return deny('STREAM_NUDGE_EXTENSION_NOT_READY', true);
    const snapshot = getState();
    if (!Array.isArray(snapshot?.rooms)) return deny('STREAM_NUDGE_STATE_UNAVAILABLE');
    const matchingTabs = (getTabs() || []).filter((t) =>
      t.providerId === 'chatgpt' && t.url === source.url);
    const authoritative = matchingTabs.find((t) => Number(t.id) === tabId);
    if (!authoritative) return deny('STREAM_NUDGE_TARGET_NOT_BOUND');
    const tabMatch = (binding) => binding?.targetId == null
      ? matchingTabs.length === 1 // Legacy URL-only bindings fail closed if ambiguous.
      : Number(binding.targetId) === tabId;
    const bound = snapshot.rooms.flatMap((room) => (room.members || [])
      .filter((m) => m.binding?.targetClassId === 'online-origin'
        && m.binding?.providerId === 'chatgpt' && m.binding?.url === source.url
        && tabMatch(m.binding))
      .map((member) => ({ room, member })));
    if (!bound.length) return deny('STREAM_NUDGE_NO_DEX_MEMBERSHIP');
    if (maintenanceBusy()) return deny('STREAM_NUDGE_MAINTENANCE_BUSY', true);
    // An agent may belong to multiple rooms. Do not interrupt an active relay
    // or capture/recovery in ANY room sharing this exact browser target.
    const conflicting = snapshot.rooms.some((room) => {
      const shared = (room.members || []).some((m) =>
        m.binding?.targetClassId === 'online-origin' && m.binding?.providerId === 'chatgpt'
        && m.binding?.url === source.url
        && tabMatch(m.binding));
      return shared && (room.relay?.active || room.relay?.waitingFor
        || room.pendingTurn || room.recovery || room.pendingProviderControlReceipt);
    });
    if (conflicting) return deny('STREAM_NUDGE_DEX_TURN_BUSY', true);
    metrics.allowed++;
    return { ok: true, authorized: true, roomIds: [...new Set(bound.map((x) => x.room.id))] };
  }
  function handle(ws, msg, send) {
    if (msg?.type !== 'dex_stream_nudge_authorize') return false;
    const result = check(msg);
    send(ws, { type: 'dex_stream_nudge_authorization',
      requestId: String(msg.requestId || '').slice(0, 128), result });
    return true;
  }
  return { check, handle, diagnostics: () => ({ ...metrics }) };
}
module.exports = { createServerStreamNudgeAuth };
