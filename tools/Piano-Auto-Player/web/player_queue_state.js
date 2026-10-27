const MODES = new Set(["manual", "ordered", "shuffle"]);
const TRANSITIONS = new Set([250, 500, 750, 1000, 1500]);

const songKey = value => String(value ?? "");
const boundedCursor = state => Math.max(0, Math.min(Number(state.cursor) || 0, state.items.length));

function restoreQueueState(raw = {}) {
  const items = Array.isArray(raw?.items) ? raw.items.filter(item => item?.songId && item?.queueId) : [];
  const currentIndex = items.findIndex(item => item.queueId === raw?.currentId);
  const cursor = currentIndex >= 0 ? currentIndex : Math.max(0, Math.min(Number(raw?.cursor) || 0, items.length));
  return {
    items,
    cursor,
    currentId: currentIndex >= 0 ? items[currentIndex].queueId : null,
    shuffleAvoidId: items.some(item => item.queueId === raw?.shuffleAvoidId) ? raw.shuffleAvoidId : null,
    active: currentIndex >= 0 && Boolean(raw?.active),
    mode: MODES.has(raw?.mode) ? raw.mode : "ordered",
    transitionMs: TRANSITIONS.has(Number(raw?.transitionMs)) ? Number(raw.transitionMs) : 750
  };
}

function queueSnapshot(state) {
  return { ...state, items: state.items.map(item => ({ ...item })) };
}

function currentIndex(state) {
  if (!state.currentId) return -1;
  return state.items.findIndex(item => item.queueId === state.currentId);
}

function nextIndex(state) {
  const current = currentIndex(state);
  return current >= 0 ? current + 1 : boundedCursor(state);
}

function normalizeQueueState(state) {
  const current = currentIndex(state);
  if (current >= 0) state.cursor = current;
  else {
    state.currentId = null;
    state.cursor = boundedCursor(state);
  }
  if (!state.items.length) {
    state.cursor = 0;
    state.currentId = null;
    state.active = false;
  }
  return state;
}

function activateQueueId(state, queueId, { discardSkipped = true } = {}) {
  let target = state.items.findIndex(item => item.queueId === queueId);
  if (target < 0) return null;
  const previous = currentIndex(state);
  const start = nextIndex(state);
  if (state.mode === "shuffle" && target >= start) {
    [state.items[start], state.items[target]] = [state.items[target], state.items[start]];
    target = start;
  } else if (discardSkipped && target > start) {
    state.items.splice(start, target - start);
    target = start;
  }
  state.shuffleAvoidId = state.mode === "shuffle" && previous >= 0 && target < previous
    ? state.items[previous]?.queueId || null : null;
  state.cursor = target;
  state.currentId = state.items[target].queueId;
  state.active = true;
  return state.items[target];
}

function activateNext(state) {
  const target = nextIndex(state);
  if (target < 0 || target >= state.items.length) return null;
  state.cursor = target;
  state.currentId = state.items[target].queueId;
  state.shuffleAvoidId = null;
  state.active = true;
  return state.items[target];
}

function activateRandomNext(state, random = Math.random) {
  const start = nextIndex(state);
  if (start < 0 || start >= state.items.length) return null;
  const all = state.items.map((_, index) => index).filter(index => index >= start);
  const withoutAvoid = all.filter(index => state.items[index].queueId !== state.shuffleAvoidId);
  const candidates = withoutAvoid.length ? withoutAvoid : all;
  const pick = Math.min(candidates.length - 1, Math.floor(random() * candidates.length));
  const target = candidates[Math.max(0, pick)];
  [state.items[start], state.items[target]] = [state.items[target], state.items[start]];
  return activateNext(state);
}

function stepQueue(state, delta) {
  const current = currentIndex(state);
  const target = delta < 0 ? (current >= 0 ? current - 1 : boundedCursor(state) - 1) : (current >= 0 ? current + 1 : boundedCursor(state));
  if (target < 0 || target >= state.items.length) return null;
  state.cursor = target;
  state.currentId = state.items[target].queueId;
  state.shuffleAvoidId = state.mode === "shuffle" && delta < 0 && current >= 0
    ? state.items[current].queueId : null;
  state.active = true;
  return state.items[target];
}

function completeCurrent(state) {
  const current = currentIndex(state);
  if (current < 0) return false;
  state.cursor = Math.min(current + 1, state.items.length);
  state.currentId = null;
  return true;
}

function removeMatching(state, predicate) {
  const oldItems = state.items;
  const oldCursor = boundedCursor(state);
  const currentId = state.currentId;
  let keptBeforeCursor = 0;
  oldItems.forEach((item, index) => { if (index < oldCursor && !predicate(item)) keptBeforeCursor += 1; });
  state.items = oldItems.filter(item => !predicate(item));
  if (currentId && !state.items.some(item => item.queueId === currentId)) {
    state.currentId = null;
    state.active = false;
    state.cursor = keptBeforeCursor;
  }
  return normalizeQueueState(state);
}

function removeQueueIds(state, queueIds) {
  const ids = new Set((queueIds || []).map(songKey));
  const before = state.items.length;
  removeMatching(state, item => ids.has(songKey(item.queueId)));
  return before - state.items.length;
}

function removeSongIds(state, songIds) {
  const ids = new Set((songIds || []).map(songKey));
  const before = state.items.length;
  removeMatching(state, item => ids.has(songKey(item.songId)));
  return before - state.items.length;
}

function removeLatestSongIds(state, songIds) {
  let removed = 0;
  [...new Set((songIds || []).map(songKey))].forEach(id => {
    const index = state.items.findLastIndex(item => songKey(item.songId) === id);
    if (index < 0) return;
    removed += removeQueueIds(state, [state.items[index].queueId]);
  });
  return removed;
}

function moveQueueId(state, queueId, delta) {
  const start = nextIndex(state);
  const index = state.items.findIndex(item => item.queueId === queueId);
  const target = index + Number(delta || 0);
  if (index < start || target < start || target >= state.items.length) return false;
  [state.items[index], state.items[target]] = [state.items[target], state.items[index]];
  normalizeQueueState(state);
  return true;
}

function moveQueueIdTo(state, queueId, targetQueueId, after = false) {
  const source = state.items.findIndex(item => item.queueId === queueId);
  let target = state.items.findIndex(item => item.queueId === targetQueueId);
  if (source < 0 || target < 0 || source === target) return false;
  const [item] = state.items.splice(source, 1);
  if (source < target) target -= 1;
  if (after) target += 1;
  state.items.splice(Math.max(0, Math.min(target, state.items.length)), 0, item);
  normalizeQueueState(state);
  return true;
}

function shuffleRange(items, start, random = Math.random) {
  for (let index = items.length - 1; index > start; index -= 1) {
    const target = start + Math.floor(random() * (index - start + 1));
    [items[index], items[target]] = [items[target], items[index]];
  }
}

function shuffleRemaining(state, random = Math.random) {
  const start = nextIndex(state);
  if (state.items.length - start < 2) return false;
  shuffleRange(state.items, start, random);
  return true;
}

function shuffleSelected(state, songIds, random = Math.random) {
  const start = nextIndex(state);
  const selected = [...new Set((songIds || []).map(songKey))];
  const sourceIndices = selected.map(id => state.items.findIndex((item, index) => index >= start && songKey(item.songId) === id)).filter(index => index >= start);
  if (!sourceIndices.length) return 0;
  const sourceSet = new Set(sourceIndices);
  const targets = state.items.map((_, index) => index).filter(index => index >= start && !sourceSet.has(index));
  if (!targets.length) {
    if (sourceIndices.length < 2) return 0;
    shuffleRange(state.items, start, random);
    return sourceIndices.length;
  }
  sourceIndices.forEach(index => {
    if (!targets.length) return;
    const pick = Math.floor(random() * targets.length);
    const target = targets.splice(pick, 1)[0];
    [state.items[index], state.items[target]] = [state.items[target], state.items[index]];
  });
  return sourceIndices.length;
}

function entryStatus(state, index) {
  const current = currentIndex(state);
  if (index === current) return "current";
  if (index < boundedCursor(state)) return "played";
  if (state.mode === "shuffle") return "candidate";
  if (index === nextIndex(state)) return "next";
  return "queued";
}

function entriesForSong(state, songId) {
  const id = songKey(songId);
  return state.items.flatMap((item, index) => songKey(item.songId) === id ? [{ ...item, index, position: index + 1, status: entryStatus(state, index) }] : []);
}

export {
  MODES, TRANSITIONS, restoreQueueState, queueSnapshot, currentIndex, nextIndex, normalizeQueueState,
  activateQueueId, activateNext, stepQueue, completeCurrent, removeQueueIds, removeSongIds,
  activateRandomNext, removeLatestSongIds, moveQueueId, moveQueueIdTo, shuffleRemaining, shuffleSelected, entryStatus, entriesForSong
};
