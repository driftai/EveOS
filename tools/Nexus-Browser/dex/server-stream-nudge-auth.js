'use strict';
// Read-only Dex room authorization for a *separate* ChatGPT continuation
// prompt. A nudge is never a scheduler turn or permission to replay a task.
function createServerStreamNudgeAuth({
  getState = () => null, getTabs = () => [], extensionReady = () => false,
  maintenanceBusy = () => false, reconcileFinal = async () => false,
  expectedAdapterRevision = () => 0, reloadSafe = () => false
} = {}) {
  const metrics = { requests: 0, allowed: 0, deferred: 0, denied: 0, boundSnapshots: 0 };
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
    const originalRequestId = String(input.turnKey || '').startsWith('dex-')
      ? String(input.turnKey).slice(4) : '';
    const matchingRecovery = (room) => {
      if (!originalRequestId || room.recovery?.requestId !== originalRequestId
        || room.recovery?.streamNudge?.reason !== input.reason) return false;
      const member = (room.members || []).find((m) => m.id === room.recovery.memberId);
      return member?.binding?.providerId === source.providerId && member?.binding?.url === source.url
        && tabMatch(member.binding);
    };
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
      const busy = room.relay?.active || room.relay?.waitingFor
        || room.pendingTurn || room.recovery || room.pendingProviderControlReceipt;
      const parkedMatch = matchingRecovery(room) && !room.relay?.active
        && !room.relay?.waitingFor && !room.pendingTurn && !room.pendingProviderControlReceipt;
      return shared && busy && !parkedMatch;
    });
    if (conflicting) return deny('STREAM_NUDGE_DEX_TURN_BUSY', true);
    metrics.allowed++;
    return { ok: true, authorized: true, roomIds: [...new Set(bound.map((x) => x.room.id))] };
  }

  async function final(msg = {}) {
    const source = msg.source || {}, requestId = String(msg.originalRequestId || '');
    const turnKey = String(msg.turnKey || ''), body = String(msg.text || '');
    if (msg.type !== 'dex_stream_nudge_final' || !/^dex-turn-[A-Za-z0-9-]{8,128}$/.test(requestId)
      || turnKey !== 'dex-' + requestId || !body.trim() || body.length > 131072) {
      return { ok: false, code: 'STREAM_NUDGE_FINAL_INVALID' };
    }
    const gate = check({ source, reason: msg.reason, turnKey });
    if (!gate.ok) return gate;
    const snapshot = getState();
    const match = (snapshot?.rooms || []).filter((room) => {
      const recovery = room.recovery;
      const member = (room.members || []).find((m) => m.id === recovery?.memberId);
      return recovery?.requestId === requestId && recovery?.streamNudge?.reason === msg.reason
        && member?.binding?.providerId === source.providerId
        && member?.binding?.url === source.url
        && (member.binding.targetId == null || String(member.binding.targetId) === String(source.targetId));
    });
    if (match.length !== 1) return { ok: false, code: 'STREAM_NUDGE_FINAL_RECOVERY_MISMATCH' };
    const accepted = await reconcileFinal({ type: 'response_final', requestId,
      text: body, observedAt: Date.now(), detail: { via: 'dex-stream-nudge', reason: msg.reason } });
    return accepted ? { ok: true, reconciled: true, roomId: match[0].id }
      : { ok: false, code: 'STREAM_NUDGE_FINAL_NOT_ACCEPTED' };
  }


  function boundTargets() {
    const snapshot = getState(), tabs = Array.isArray(getTabs()) ? getTabs() : [];
    if (!Array.isArray(snapshot?.rooms)) return [];
    const out = new Map();
    for (const room of snapshot.rooms) for (const member of room.members || []) {
      const binding = member.binding || {};
      if (binding.targetClassId !== 'online-origin' || !binding.providerId || !binding.url) continue;
      const matches = tabs.filter((tab) => tab.providerId === binding.providerId && tab.url === binding.url);
      const tab = binding.targetId == null
        ? (matches.length === 1 ? matches[0] : null)
        : matches.find((candidate) => String(candidate.id) === String(binding.targetId));
      if (!tab?.id) continue;
      const key = binding.providerId + ':' + tab.id + ':' + binding.url;
      const saved = out.get(key) || { targetClassId: 'online-origin',
        providerId: binding.providerId, targetId: Number(tab.id), url: binding.url, roomIds: [] };
      if (!saved.roomIds.includes(room.id)) saved.roomIds.push(room.id);
      out.set(key, saved);
    }
    metrics.boundSnapshots++;
    return [...out.values()];
  }

  async function handle(ws, msg, send) {
    if (msg?.type === 'dex_bound_targets_request') {
      send(ws, { type: 'dex_bound_targets_snapshot', requestId: String(msg.requestId || '').slice(0, 128), expectedAdapterRevision: Number(expectedAdapterRevision() || 0), reloadSafe: reloadSafe() === true,
        targets: boundTargets() });
      return true;
    }
    if (msg?.type === 'dex_stream_nudge_authorize') {
      const result = check(msg);
      send(ws, { type: 'dex_stream_nudge_authorization',
        requestId: String(msg.requestId || '').slice(0, 128), result });
      return true;
    }
    if (msg?.type === 'dex_stream_nudge_final') {
      const result = await final(msg);
      send(ws, { type: 'dex_stream_nudge_final_ack',
        requestId: String(msg.requestId || '').slice(0, 128), result });
      return true;
    }
    return false;
  }
  return { check, final, boundTargets, handle, diagnostics: () => ({ ...metrics }) };
}
module.exports = { createServerStreamNudgeAuth };
