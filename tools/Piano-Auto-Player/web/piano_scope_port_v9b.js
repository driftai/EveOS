// EveOS Piano v9B: one existing Backend queue owner, no extra playback controller.
export async function performScopedQueue(queue, api, data) {
  if (!queue?.getState || !queue?.playQueue || !queue?.addSongs) throw new Error('Player Queue is unavailable.');
  const action = data.action;
  if (action === 'queue:loop') {
    if (typeof data.enabled !== 'boolean' || !queue.setLoop) throw new Error('Invalid loop setting.');
    queue.setLoop(data.enabled);
    return;
  }
  if (action === 'queue:scope-play' && data.queuedView === true) {
    if (!queue.getState().items?.length) throw new Error('Player Queue is empty.');
    if (queue.getState().active) return;
    if (!await queue.playQueue()) throw new Error('Player Queue could not start.');
    return;
  }
  if (action !== 'queue:scope-play' && action !== 'queue:play-eligible')
    throw new Error('Unknown scoped queue command.');
  if (data.queuedView === true) throw new Error('Queued view is only valid for Play Scope.');
  const ids = data.songIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 500 ||
      ids.some(id => typeof id !== 'string' || !id || id.length > 180) ||
      new Set(ids).size !== ids.length) throw new Error('Invalid or empty Piano scope selection.');
  // The parent supplies its displayed/eligible identities. The Backend independently
  // validates that every ID exists before stopping or replacing any live queue.
  const saved = (await api.songs({ fresh: true })).songs || [];
  const byId = new Map(saved.map(song => [String(song.id), song]));
  const songs = ids.map(id => byId.get(id));
  if (songs.some(song => !song)) throw new Error('Scope changed; refresh before playing.');
  if (queue.getState().active) await queue.stopQueue();
  await queue.addSongs(songs, { replace: true, play: false, announce: false });
  if (!await queue.playQueue()) throw new Error('The selected Piano scope could not start.');
}
