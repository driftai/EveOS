const doneWatch = require('../public/dex-done-watch');

function createDoneWatchDelivery({
  load, save, broadcastState = () => {}, safeSend, getSocket,
  getTabs = () => [], now = () => new Date().toISOString()
} = {}) {
  const diagnostics = { attempts: 0, confirmed: 0, failed: 0, waiting: 0 };
  const open = (socket) => !!socket && socket.readyState === 1;
  function locate(binding = {}) {
    if (binding.targetClassId !== 'online-origin') return null;
    return getTabs().find((tab) => tab.providerId === binding.providerId
      && ((tab.id != null && binding.targetId != null && String(tab.id) === String(binding.targetId))
        || (!!tab.url && !!binding.url && tab.url === binding.url))) || null;
  }
  function sameBinding(a = {}, b = {}) {
    return a.targetClassId === b.targetClassId && a.providerId === b.providerId
      && ((a.targetId != null && b.targetId != null && String(a.targetId) === String(b.targetId))
        || (!!a.url && a.url === b.url));
  }
  function flush() {
    const socket = getSocket();
    if (!open(socket)) return { sent: 0, waiting: 0, reason: 'provider-control-offline' };
    const snapshot = load();
    if (!snapshot) return { sent: 0, waiting: 0 };
    let sent = 0, waiting = 0, dirty = false;
    for (const room of snapshot.rooms || []) {
      for (const event of room.doneWatchEvents || []) {
        if (event.delivery !== 'pending') continue;
        const member = doneWatch.memberById(room, event.watcherMemberId);
        if (!member || member.binding?.targetClassId !== 'online-origin') {
          event.delivery = 'unavailable'; event.deliveryAt = now(); dirty = true;
          continue;
        }
        const busy = (snapshot.rooms || []).some((candidate) =>
          (candidate.relay?.active || candidate.pendingTurn || candidate.recovery)
          && (candidate.members || []).some((entry) => sameBinding(entry.binding, member.binding)));
        if (busy) { waiting += 1; continue; }
        const tab = locate(member.binding);
        if (!tab) { waiting += 1; continue; }
        const source = { targetClassId: 'online-origin', targetId: tab.id,
          providerId: tab.providerId, url: tab.url };
        const packet = { type: 'dex_done_watch_event', eventId: event.id, source,
          text: doneWatch.notificationText(room, event) };
        // Claim durably before transport. Reconnection must never resend an
        // event whose dispatch result is unknown.
        event.delivery = 'sent-unconfirmed'; event.deliveryAt = now();
        save(snapshot); dirty = false;
        if (!safeSend(socket, packet)) {
          event.delivery = 'pending'; delete event.deliveryAt;
          save(snapshot); waiting += 1; continue;
        }
        sent += 1;
        diagnostics.attempts += 1;
      }
    }
    if (dirty) save(snapshot);
    if (sent || dirty) broadcastState(load());
    diagnostics.waiting = waiting;
    return { sent, waiting };
  }
  function handleAck(socket, message) {
    if (message?.type !== 'dex_done_watch_ack' || socket !== getSocket()) return false;
    const id = String(message.eventId || '');
    if (!id) return true;
    const snapshot = load();
    const matches = (snapshot?.rooms || []).flatMap((room) => (room.doneWatchEvents || [])
      .filter((event) => event.id === id).map((event) => ({ room, event })));
    if (matches.length !== 1 || matches[0].event.delivery !== 'sent-unconfirmed') return true;
    const { event } = matches[0];
    event.delivery = message.ok === true ? 'confirmed' : 'submission-failed';
    event.deliveryAt = now();
    if (message.ok !== true) event.deliveryError = String(message.error || 'Provider did not confirm delivery.').slice(0, 160);
    if (message.ok === true) diagnostics.confirmed += 1; else diagnostics.failed += 1;
    const saved = save(snapshot); broadcastState(saved);
    return true;
  }
  return { flush, handleAck, diagnostics: () => ({ ...diagnostics }) };
}
module.exports = { createDoneWatchDelivery };
