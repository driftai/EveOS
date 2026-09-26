'use strict';
// Receipt submission is independent of room relay turns. Claim on disk before
// notifying the provider; unknown sends are never replayed on reconnect.
function createTaskCompletionDelivery({
  journal, getState = () => null, getTabs = () => [],
  getSocket = () => null, safeSend = () => false,
  now = () => new Date().toISOString()
} = {}) {
  const diagnostics = { attempts: 0, confirmed: 0, failed: 0, waiting: 0, unavailable: 0 };
  let delivering = false;
  const same = (a = {}, b = {}) => a.targetClassId === b.targetClassId
    && a.providerId === b.providerId && a.url === b.url
    && String(a.targetId) === String(b.targetId);
  const online = (socket) => !!socket && socket.readyState === 1;
  function notificationText(job) {
    const report = job.report || {}, result = report.result || 'unknown';
    const status = result === 'success' ? 'SUCCESS (local task report)'
      : result === 'failed' ? 'FAILED (local task report)' : 'OUTCOME UNKNOWN';
    const stages = (report.stageResults || []).slice(0, 8)
      .map((stage) => String(stage.name || 'stage') + ': exit='
        + (stage.exitCode == null ? 'unknown' : stage.exitCode));
    return [
      '[DEX BACKGROUND TASK COMPLETION]',
      'Task: ' + job.taskId, 'Job: ' + job.id,
      'Origin room: ' + job.roomName + ' (' + job.roomId + ')',
      'Exact Git SHA: ' + job.expectedHead, 'Result: ' + status,
      'Summary: ' + String(report.summary || '(No report.)').slice(0, 1000),
      ...stages, ...(report.logs || []).slice(0, 8).map((log) => 'Log: ' + log),
      '', 'This one-shot result is reported by the existing LOCAL task runner.',
      'The notification proves provider prompt submission only if acknowledged;',
      'it does not independently validate the reported tests or prove model read.',
      'It is NOT a Dex relay turn. No acknowledgement or automatic follow-up',
      'is required. Never restart this task merely because a notification failed.'
    ].join('\n');
  }
  function targetFor(job, snapshot) {
    const room = (snapshot?.rooms || []).find((entry) => entry.id === job.roomId);
    if (!room) return { reason: 'origin-room-missing' };
    const requester = (room.members || []).find((m) => m.id === job.requesterMemberId);
    const worker = (room.members || []).find((m) => m.id === job.workerMemberId);
    if (!requester || !worker || !same(requester.binding, job.requesterTarget)
      || String(worker.binding?.targetId) !== job.workerTargetId
      || worker.binding?.providerId !== job.workerProviderId) {
      return { reason: 'participant-rebound' };
    }
    if (room.relay?.active || room.pendingTurn || room.recovery
      || room.pendingProviderControlReceipt || room.deferredRelays?.length)
      return { reason: 'origin-room-busy', waiting: true };
    // Never inject into an agent currently processing another room's relay.
    const otherBusy = (snapshot.rooms || []).some((entry) =>
      (entry.relay?.active || entry.pendingTurn || entry.recovery
        || entry.pendingProviderControlReceipt || entry.deferredRelays?.length)
      && (entry.members || []).some((member) => same(member.binding, job.requesterTarget)));
    if (otherBusy) return { reason: 'requester-busy', waiting: true };
    const tab = getTabs().find((entry) =>
      String(entry.id) === String(job.requesterTarget.targetId)
      && entry.providerId === job.requesterTarget.providerId
      && entry.url === job.requesterTarget.url);
    if (!tab) return { reason: 'exact-provider-tab-offline', waiting: true };
    return { source: { targetClassId: 'online-origin', targetId: tab.id,
      providerId: tab.providerId, url: tab.url } };
  }
  function flush() {
    if (delivering) return { sent: 0, waiting: 0, reason: 'delivery-in-progress' };
    const socket = getSocket(), snapshot = getState();
    if (!online(socket) || !snapshot) return { sent: 0, waiting: journal.ready().length, reason: 'provider-control-offline' };
    let sent = 0, waiting = 0, unavailable = 0;
    delivering = true;
    try {
      for (const job of journal.ready()) {
        const target = targetFor(job, snapshot);
        if (!target.source) {
          if (target.waiting) waiting++;
          else {
            unavailable++;
            // A permanently changed participant binding cannot be redirected
            // to another tab. Keep the report in the journal for manual review.
          }
          continue;
        }
        if (!journal.claim(job.id)) continue;
        const packet = { type: 'dex_task_completion_event', eventId: job.id,
          kind: 'task-completion', source: target.source, text: notificationText(job) };
        try {
          if (!safeSend(socket, packet)) {
            journal.uncertain(job.id, 'Socket closed after durable delivery claim.');
            continue;
          }
          sent++; diagnostics.attempts++;
        } catch (error) {
          journal.uncertain(job.id, 'Notification submission was uncertain: ' + error.message);
        }
      }
    } finally { delivering = false; }
    diagnostics.waiting = waiting; diagnostics.unavailable = unavailable;
    return { sent, waiting, unavailable };
  }
  function handleAck(socket, message) {
    if (message?.type !== 'dex_task_completion_ack') return false;
    if (socket !== getSocket()) return true;
    const id = String(message.eventId || '');
    if (!id) return true;
    const changed = journal.ack(id, message.ok === true, message.error);
    if (changed) {
      if (message.ok === true) diagnostics.confirmed++;
      else diagnostics.failed++;
    }
    return true;
  }
  return { flush, handleAck, notificationText, targetFor,
    diagnostics: () => ({ ...diagnostics, ...journal.diagnostics() }) };
}
module.exports = { createTaskCompletionDelivery };
