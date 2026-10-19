'use strict';
// Conservative, evidence-preserving expiration for UNDISPATCHED approvals and
// expired ephemeral presence receipts. Never settle/replay uncertain execution.
const { executionBusy } = require('./server-state-merge');
const APPROVAL_TTL_MS = 5 * 60 * 1000; // Broker tokens expire after 60 seconds.
const PRESENCE_TTL_MS = 30 * 60 * 1000; // Coordinator presence expires after 120 seconds.
const ARCHIVE_MAX = 100;
function timestamp(value) { const n = Date.parse(value || ''); return Number.isFinite(n) ? n : null; }
function ageEnough(value, now, ttl) { const t = timestamp(value); return t !== null && now - t >= ttl; }
function pendingMachineWork(room) {
  for (const space of room?.machineSpaces?.spaces || []) {
    if ((space.requests || []).some(r => r?.state === 'running' || r?.state === 'queued')) return true;
    if ((space.fileRequests || []).some(r => r?.state === 'running' || r?.state === 'queued')) return true;
  }
  return false;
}
function reconcileDormant(snapshot, { now = Date.now() } = {}) {
  let changed = false;
  const events = [];
  const archive = Array.isArray(snapshot?.retiredProviderControlReceipts)
    ? snapshot.retiredProviderControlReceipts : [];
  const rooms = Array.isArray(snapshot?.rooms) ? snapshot.rooms : [];
  for (const room of rooms) {
    if (!room || executionBusy(room) || pendingMachineWork(room)) continue;
    const pending = room.pendingProviderControlReceipt;
    if (pending && pending.action === 'quorum_presence' && !pendingMachineWork(room)
        && ageEnough(pending.createdAt, now, PRESENCE_TTL_MS)
        && archive.length < ARCHIVE_MAX) {
      // The effect of a historical presence command cannot be inferred. Retire
      // only the stale *wait marker*, recording the exact unresolved intent.
      if (!Array.isArray(snapshot.retiredProviderControlReceipts)) snapshot.retiredProviderControlReceipts = archive;
      archive.push({
        schema: 'eveos.dex-retired-provider-control.v1',
        disposition: 'AUTO_RETIRED_UNRESOLVED_EXPIRED_PRESENCE',
        roomId: room.id, roomName: String(room.name || '').slice(0, 80),
        action: pending.action, commandKey: pending.commandKey || null,
        executorMemberId: pending.executorMemberId || null,
        turnRequestId: pending.turnRequestId || null,
        originMessageId: pending.originMessageId || null,
        agentMessageId: pending.agentMessageId || null,
        createdAt: pending.createdAt, retiredAt: new Date(now).toISOString()
      });
      delete room.pendingProviderControlReceipt;
      changed = true;
      events.push({ roomId: room.id, code: 'EXPIRED_PRESENCE_UNRESOLVED_ARCHIVED' });
    }
    for (const space of room.machineSpaces?.spaces || []) {
      for (const request of space.requests || []) {
        if (request?.state !== 'approval-required' || !ageEnough(request.createdAt, now, APPROVAL_TTL_MS)) continue;
        const linked = (space.ledger?.events || []).find(e => e?.requestId === request.requestId);
        // An execution ledger, even a queued one, is evidence requiring an
        // explicit exact-ID reconciliation. Do not guess from elapsed time.
        if (linked || !request.requestId || !request.terminalId) continue;
        request.state = 'denied';
        request.reason = 'approval-expired-without-dispatch-evidence';
        request.finishedAt = new Date(now).toISOString();
        delete request.command;
        delete request.challenge;
        changed = true;
        events.push({ roomId: room.id, spaceId: space.id, requestId: request.requestId,
          code: 'EXPIRED_UNAPPROVED_REQUEST_DENIED' });
      }
    }
  }
  return { changed, events, snapshot };
}
module.exports = { APPROVAL_TTL_MS, PRESENCE_TTL_MS, ARCHIVE_MAX, reconcileDormant };
