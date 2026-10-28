// Additional EveOS ports. The existing Piano DOM and PlayerQueue remain authoritative.
const byId = id => document.getElementById(id);
const selected = node => ({ value: String(node.value), label: node.selectedOptions?.[0]?.textContent?.trim() || '' });
const options = node => node ? [...node.options].map(o => ({ value: String(o.value), label: o.textContent.trim() })) : [];

function controlsSnapshot() {
  const target = byId('windowSelect'), layout = byId('pianoLayout'), sound = byId('pianoSound'), internal = byId('internalPlay');
  if (!target || !layout || !sound || !internal) return null;
  return {
    internal: internal.checked, target: selected(target), targets: options(target), targetDisabled: target.disabled,
    layout: selected(layout), layouts: options(layout), sound: selected(sound), sounds: options(sound),
    soundStatus: byId('pianoSoundStatus')?.textContent?.trim() || ''
  };
}
function queueSnapshot() { return window.PianoPlayerQueue?.getState?.() || null; }
function validOption(node, value) { return !!node && [...node.options].some(option => String(option.value) === String(value)); }
function emitChange(node) { node.dispatchEvent(new Event('change', { bubbles: true })); }

async function setControl(data) {
  const field = data.field, value = data.value;
  if (field === 'internal') {
    if (typeof value !== 'boolean') throw new Error('Internal Play requires a boolean.');
    const node = byId('internalPlay'); if (!node) throw new Error('Internal Play is unavailable.');
    if (node.checked !== value) { node.checked = value; emitChange(node); }
  } else {
    const id = ({ target: 'windowSelect', layout: 'pianoLayout', sound: 'pianoSound' })[field];
    if (!id) throw new Error('Unknown Piano control.');
    const node = byId(id);
    if (field === 'target' && byId('internalPlay')?.checked) throw new Error('Target Window is disabled during Internal Play.');
    if (!validOption(node, value)) throw new Error('The selected Piano option is no longer available. Refresh the controls.');
    if (node.disabled) throw new Error('This Piano control is currently disabled.');
    if (node.value !== String(value)) { node.value = String(value); emitChange(node); }
  }
  return controlsSnapshot();
}

async function performQueue(data, api) {
  const queue = window.PianoPlayerQueue;
  if (!queue?.getState) throw new Error('The Backend Player Queue is still initializing.');
  const action = data.action;
  if (action === 'queue:add') {
    if (typeof data.songId !== 'string' || !data.songId || data.songId.length > 180) throw new Error('Invalid song ID.');
    const songs = (await api.songs({ fresh: true })).songs || [];
    const song = songs.find(item => String(item.id) === data.songId);
    if (!song) throw new Error('Song not found in the Backend library. Refresh.');
    queue.addSong(song, false);
  } else if (action === 'queue:remove') {
    if (typeof data.queueId !== 'string' || !data.queueId) throw new Error('Invalid queue entry.');
    queue.removeQueueId(data.queueId);
  } else if (action === 'queue:play-item') {
    if (typeof data.queueId !== 'string' || !data.queueId) throw new Error('Invalid queue entry.');
    if (!queue.getState().items?.some(item => item.queueId === data.queueId)) throw new Error('Queue entry no longer exists.');
    await queue.playQueueId(data.queueId);
  } else if (action === 'queue:mode') {
    if (!['manual', 'ordered', 'shuffle'].includes(data.value)) throw new Error('Invalid queue mode.');
    queue.setMode(data.value);
  } else if (action === 'queue:play') await queue.playQueue();
  else if (action === 'queue:stop') queue.stopQueue();
  else if (action === 'queue:next') await queue.next();
  else if (action === 'queue:previous') await queue.previous();
  else if (action === 'queue:shuffle') queue.shuffleRemaining();
  else if (action === 'queue:clear') queue.clearQueue();
  else if (action === 'queue:play-all') await queue.playAllLibrary();
  else if (action !== 'queue:get') throw new Error('Unknown Player Queue command.');
  return queueSnapshot();
}

export function setupExtendedPianoFrontendPort({ api, parent, parentOrigin, reply }) {
  let latestProgress = null;
  const progressSnapshot = () => {
    const p = latestProgress || {};
    const bar = byId('eventSeekRange');
    const total = Math.max(0, Number(p.total_events || p.sheet_total || (Number(bar?.max) > 1 ? bar.max : 0) || 0));
    const index = Number(p.current_index || (Number(bar?.value) > 1 ? bar.value : 0) || 0);
    return { status: String(p.status || byId('statusChip')?.dataset.state || 'idle').slice(0, 30),
      index: total ? Math.max(0, Math.min(total, index)) : 0, total,
      token: String(p.current_token || byId('currentToken')?.textContent || '').slice(0, 120) };
  };
  const supported = new Set(['controls:get', 'controls:set', 'controls:refresh', 'queue:get',
    'queue:add', 'queue:remove', 'queue:play-item', 'queue:mode', 'queue:play', 'queue:stop',
    'queue:next', 'queue:previous', 'queue:shuffle', 'queue:clear', 'queue:play-all', 'progress:get']);
  let mutating = false;
  window.addEventListener('message', async event => {
    const data = event.data;
    if (event.source !== parent || (parentOrigin && event.origin !== parentOrigin)) return;
    if (data?.type !== 'eveos:piano-frontend-port-command' || !Number.isSafeInteger(data.id) || !supported.has(data.action)) return;
    const result = { type: 'piano:eveos-frontend-port-response', id: data.id, action: data.action };
    const mutation = !['controls:get', 'queue:get', 'progress:get'].includes(data.action);
    try {
      if (mutation && mutating) throw new Error('Piano is processing another setting or queue command.');
      if (mutation) mutating = true;
      if (data.action === 'progress:get') result.progress = progressSnapshot();
      else if (data.action === 'controls:get') result.controls = controlsSnapshot();
      else if (data.action === 'controls:set') result.controls = await setControl(data);
      else if (data.action === 'controls:refresh') { byId('refreshWindowsBtn')?.click(); result.controls = controlsSnapshot(); }
      else result.queue = await performQueue(data, api);
    } catch (error) { result.error = String(error?.message || 'Piano command failed.').slice(0, 180); }
    finally { if (mutation) mutating = false; }
    reply(result);
  });
  const updates = () => reply({ type: 'piano:eveos-port-update', controls: controlsSnapshot(), queue: queueSnapshot() });
  window.addEventListener('piano:sheet-progress-status', event => {
    latestProgress = event.detail && typeof event.detail === 'object' ? event.detail : null;
    reply({ type: 'piano:eveos-port-update', progress: progressSnapshot() });
  });
  window.addEventListener('piano:player-queue-ready', updates);
  window.addEventListener('piano:queue-updated', updates);
  document.addEventListener('change', event => {
    if (['internalPlay', 'windowSelect', 'pianoLayout', 'pianoSound'].includes(event.target?.id)) updates();
  });
}

export function summarizeFrontendSong(song) {
  const identifiers = song?.identifiers || {}, auto = song?.automatic_identifiers || {};
  return {
    id: String(song.id || ''), title: String(song.title || 'Untitled'), artist: String(song.artist || ''),
    kind: song.performance?.length ? 'recording' : 'song', source: String(song.source || ''),
    updated_at: Number(song.updated_at || 0), duration_ms: Number(auto.duration_ms || song.duration_ms || 0),
    identifiers: { author: String(identifiers.author || ''), genre: identifiers.genre || [], tags: identifiers.tags || [],
      personal_rating: identifiers.personal_rating ?? null, custom: { favorite: String(identifiers.custom?.favorite || '') } },
    automatic_identifiers: { kind: String(auto.kind || ''), source_host: String(auto.source_host || ''),
      event_count: Number(auto.event_count || 0), duration_ms: Number(auto.duration_ms || 0),
      conversion_rating: auto.conversion_rating ?? null, tags: auto.tags || [] }
  };
}
