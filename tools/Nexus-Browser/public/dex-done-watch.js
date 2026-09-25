(() => {
  // Durable one-shot DONE notifications. These never enqueue a Dex relay turn.
  const MAX_WATCHES = 12, MAX_EVENTS = 32, WATCH_TTL_MS = 6 * 60 * 60 * 1000;
  const HEADSUP_TTL_MS = 30 * 60 * 1000, HEADSUP_COOLDOWN_MS = 5 * 60 * 1000;
  const stamp = (value) => Date.parse(value || '') || 0;
  const memberById = (room, id) => (room?.members || []).find((member) => member.id === id) || null;
  const active = (watch, at) => stamp(watch.expiresAt) > stamp(at);
  const watches = (room) => Array.isArray(room?.doneWatches) ? room.doneWatches : [];
  const events = (room) => Array.isArray(room?.doneWatchEvents) ? room.doneWatchEvents : [];
  const summary = (room, watcherMemberId) => ({
    armed: watches(room).filter((watch) => watch.watcherMemberId === watcherMemberId),
    latest: events(room).filter((event) => event.kind !== 'heads-up' && event.watcherMemberId === watcherMemberId).slice(-3)
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
  function snapshot(room) {
    return { watches: room.doneWatches, revision: room.doneWatchRevision, updatedAt: room.updatedAt };
  }
  function restore(room, previous) {
    Object.assign(room, { doneWatches: previous.watches, doneWatchRevision: previous.revision, updatedAt: previous.updatedAt });
  }
  function armSend(room, sender, command, uid) {
    if (command.notifyOnDone !== true) return { ok: true, armed: false };
    if (command.relay === false) return { ok: false, code: 'DEX_DONE_WATCH_RELAY_REQUIRED', message: 'notifyOnDone requires relay:true.' };
    const ref = String(command.notifyMember || '').trim();
    const matches = ref ? (room.members || []).filter((member) =>
      member.id === ref || String(member.name || '').toLowerCase() === ref.toLowerCase()) : [];
    if (ref && matches.length !== 1) return { ok: false, code: 'DEX_DONE_WATCH_BAD_TARGET', message: 'notifyMember must name a single room participant.' };
    return arm(room, { watcherMemberId: sender.id, targetMemberId: matches[0]?.id || null, id: uid('done-watch') });
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
  function headsUpSummary(room, memberId) {
    return {
      lastSent: room?.lastHeadsUp?.senderMemberId === memberId ? room.lastHeadsUp : null,
      latest: events(room).filter((entry) => entry.kind === 'heads-up'
        && entry.watcherMemberId === memberId).slice(-3)
        .map(({ id, completedByName, completedAt, delivery }) => ({ id, completedByName, completedAt, delivery }))
    };
  }
  // An agent explicitly brings in ONE other authorized online room member.
  // No subscription, no implicit audience, no relay turn, and no automatic rearm.
  function emitHeadsUp(room, { senderMemberId, targetRef, invalid = false, done = false, message,
    at = new Date().toISOString() } = {}) {
    if (!room || !senderMemberId || !message?.id || !Number.isFinite(stamp(at)))
      return { ok: false, code: 'DEX_HEADSUP_BAD_REQUEST' };
    const sender = memberById(room, senderMemberId);
    const ref = String(targetRef || '').trim(), clock = stamp(at);
    const matches = (room.members || []).filter((member) => member.id === ref
      || (ref && String(member.name || '').toLowerCase() === ref.toLowerCase()));
    let code = null, suppressed = null, prior = null, target = matches[0];
    if (!done) code = 'DEX_HEADSUP_DONE_REQUIRED';
    else if (invalid) code = 'DEX_HEADSUP_MULTIPLE_TARGETS';
    else if (!sender || matches.length !== 1) code = 'DEX_HEADSUP_TARGET_AMBIGUOUS';
    else if (target.id === sender.id) code = 'DEX_HEADSUP_SELF';
    else if (target.binding?.targetClassId !== 'online-origin') code = 'DEX_HEADSUP_ONLINE_ONLY';
    else {
      prior = events(room).find((event) => event.completedMessageId === message.id
        && event.watcherMemberId === target.id);
      if (prior) suppressed = 'already-notified';
      else {
        prior = events(room).find((event) => event.kind === 'heads-up'
          && event.completedMemberId === sender.id && event.watcherMemberId === target.id
          && !['expired', 'unavailable', 'submission-failed'].includes(event.delivery)
          && clock >= stamp(event.completedAt)
          && clock - stamp(event.completedAt) < HEADSUP_COOLDOWN_MS);
        if (prior) suppressed = 'cooldown';
      }
    }
    const status = code ? 'rejected' : suppressed ? 'suppressed' : 'queued';
    room.lastHeadsUp = { senderMemberId, recipientMemberId: target?.id || null,
      messageId: message.id, status, ...(code ? { code } : {}),
      ...(suppressed ? { reason: suppressed } : {}), at };
    if (code || suppressed) return { ok: !code, code, suppressed, eventId: prior?.id || null };
    const event = { id: `headsup-${message.id}-${target.id}`, kind: 'heads-up',
      watcherMemberId: target.id, completedMemberId: sender.id,
      completedByName: sender.name, completedMessageId: message.id,
      completedText: String(message.text || '').slice(0, 1800),
      completedAt: at, expiresAt: new Date(clock + HEADSUP_TTL_MS).toISOString(),
      delivery: 'pending' };
    room.doneWatchEvents = [...events(room), event].slice(-MAX_EVENTS);
    room.updatedAt = at;
    return { ok: true, event };
  }
  function notificationText(room, event) {
    if (event.kind === 'heads-up') return [
      '[DEX HEADS UP]', `${event.completedByName} explicitly requested your attention after completing a task in ${room.name}.`,
      `Room: ${room.id}`, `Completion message: ${event.completedMessageId}`,
      `Result: ${event.completedText || '(No textual response.)'}`, '',
      'This one-shot heads-up is NOT a Dex relay turn. Nothing requires an acknowledgement.',
      'Do not automatically reply, forward this notice, arm another watch, or issue a HEADSUP.',
      'Only initiate new work if the completed result genuinely needs your action.'
    ].join('\n');
    return ['[DEX DONE WATCH]', `${event.completedByName} marked ${room.name} complete.`,
      `Room: ${room.id}`, `Completion message: ${event.completedMessageId}`,
      `Reply: ${event.completedText || '(No textual response.)'}`, '',
      'This is a one-shot background notification, not a Dex relay turn. Your watch is now disarmed.',
      'If further DONE events require your attention, explicitly issue a new watch_done command. Do not start a confirmation loop merely to acknowledge this notification.'].join('\n');
  }
  const api = { MAX_WATCHES, MAX_EVENTS, WATCH_TTL_MS, HEADSUP_TTL_MS, HEADSUP_COOLDOWN_MS,
    memberById, summary, headsUpSummary, arm, armSend, snapshot, restore, disarm, consume, emitHeadsUp, notificationText };
  if (typeof globalThis !== 'undefined') globalThis.BrowserAiBridgeDexDoneWatch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();