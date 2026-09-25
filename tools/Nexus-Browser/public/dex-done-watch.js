(() => {
  // Durable one-shot DONE notifications. These never enqueue a Dex relay turn.
  const MAX_WATCHES = 12, MAX_EVENTS = 32, WATCH_TTL_MS = 6 * 60 * 60 * 1000;
  const stamp = (value) => Date.parse(value || '') || 0;
  const memberById = (room, id) => (room?.members || []).find((member) => member.id === id) || null;
  const active = (watch, at) => stamp(watch.expiresAt) > stamp(at);
  const watches = (room) => Array.isArray(room?.doneWatches) ? room.doneWatches : [];
  const events = (room) => Array.isArray(room?.doneWatchEvents) ? room.doneWatchEvents : [];
  const summary = (room, watcherMemberId) => ({
    armed: watches(room).filter((watch) => watch.watcherMemberId === watcherMemberId),
    latest: events(room).filter((event) => event.watcherMemberId === watcherMemberId).slice(-3)
      .map(({ id, completedByName, completedAt, delivery }) => ({ id, completedByName, completedAt, delivery }))
  });
  function arm(room, {
    watcherMemberId, targetMemberId = null, id, at = new Date().toISOString()
  } = {}) {
    const watcher = memberById(room, watcherMemberId);
    if (!watcher) return { ok: false, code: 'DEX_DONE_WATCH_NOT_BOUND', message: 'Watcher is not a room participant.' };
    if (watcher.binding?.targetClassId !== 'online-origin') {
      return { ok: false, code: 'DEX_DONE_WATCH_ONLINE_ONLY', message: 'Background DONE notifications currently require an online browser-agent target.' };
    }
    if (targetMemberId && (!memberById(room, targetMemberId) || targetMemberId === watcherMemberId)) {
      return { ok: false, code: 'DEX_DONE_WATCH_BAD_TARGET', message: 'The watched agent must be a different participant in this room.' };
    }
    if (!id || !Number.isFinite(stamp(at))) return { ok: false, code: 'DEX_DONE_WATCH_BAD_REQUEST', message: 'A durable watch ID and valid timestamp are required.' };
    const next = watches(room).filter((entry) => active(entry, at) && entry.watcherMemberId !== watcherMemberId);
    if (next.length >= MAX_WATCHES) return { ok: false, code: 'DEX_DONE_WATCH_LIMIT', message: 'The room has reached its DONE watcher limit.' };
    const watch = { id, watcherMemberId, targetMemberId, armedAt: at,
      expiresAt: new Date(stamp(at) + WATCH_TTL_MS).toISOString() };
    room.doneWatches = [...next, watch];
    room.doneWatchRevision = Math.max(0, Number(room.doneWatchRevision) || 0) + 1;
    room.updatedAt = at;
    return { ok: true, watch };
  }
  function disarm(room, watcherMemberId, at = new Date().toISOString()) {
    const before = watches(room).length;
    room.doneWatches = watches(room).filter((entry) => entry.watcherMemberId !== watcherMemberId);
    if (room.doneWatches.length !== before) {
      room.doneWatchRevision = Math.max(0, Number(room.doneWatchRevision) || 0) + 1;
      room.updatedAt = at;
    }
    return { ok: true, removed: before - room.doneWatches.length };
  }
  function consume(room, {
    completedMemberId, message, at = new Date().toISOString()
  } = {}) {
    if (!room || !message?.id || !completedMemberId) return [];
    const pending = [], emitted = [];
    for (const watch of watches(room)) {
      if (!active(watch, at) || !memberById(room, watch.watcherMemberId)) continue;
      if (watch.watcherMemberId === completedMemberId
          || (watch.targetMemberId && watch.targetMemberId !== completedMemberId)) {
        pending.push(watch);
        continue;
      }
      const completed = memberById(room, completedMemberId);
      const event = { id: `done-watch-${watch.id}-${message.id}`,
        watchId: watch.id, watcherMemberId: watch.watcherMemberId,
        completedMemberId, completedByName: completed?.name || 'Agent',
        completedMessageId: message.id, completedText: String(message.text || '').slice(0, 1800),
        completedAt: at, delivery: 'pending' };
      if (!events(room).some((item) => item.id === event.id)) emitted.push(event);
    }
    if (pending.length !== watches(room).length) {
      room.doneWatches = pending;
      room.doneWatchRevision = Math.max(0, Number(room.doneWatchRevision) || 0) + 1;
      room.updatedAt = at;
    }
    if (emitted.length) room.doneWatchEvents = [...events(room), ...emitted].slice(-MAX_EVENTS);
    return emitted;
  }
  function notificationText(room, event) {
    return ['[DEX DONE WATCH]', `${event.completedByName} marked ${room.name} complete.`,
      `Room: ${room.id}`, `Completion message: ${event.completedMessageId}`,
      `Reply: ${event.completedText || '(No textual response.)'}`, '',
      'This is a one-shot background notification, not a Dex relay turn. Your watch is now disarmed.',
      'If further DONE events require your attention, explicitly issue a new watch_done command. Do not start a confirmation loop merely to acknowledge this notification.'].join('\n');
  }
  const api = { MAX_WATCHES, MAX_EVENTS, WATCH_TTL_MS, memberById, summary, arm, disarm, consume, notificationText };
  if (typeof globalThis !== 'undefined') globalThis.BrowserAiBridgeDexDoneWatch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();