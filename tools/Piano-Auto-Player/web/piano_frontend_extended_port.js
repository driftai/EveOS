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
function firstFinite(...values) {
  for (const value of values) if (value !== '' && value != null && Number.isFinite(Number(value))) return Number(value);
  return 0;
}
function validOption(node, value) { return !!node && [...node.options].some(option => String(option.value) === String(value)); }
function emitChange(node) { node.dispatchEvent(new Event('change', { bubbles: true })); }
const cleanText = (value, limit = 180) => String(value || '').trim().slice(0, limit);
const cleanList = value => (Array.isArray(value) ? value : String(value || '').split(','))
  .map(item => cleanText(item, 60)).filter(Boolean).slice(0, 30);

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
  if (!queue?.getState) throw new Error('The Player Queue is still initializing.');
  const action = data.action;
  if (action === 'queue:add') {
    if (typeof data.songId !== 'string' || !data.songId || data.songId.length > 180) throw new Error('Invalid song ID.');
    let songs = (await api.songs()).songs || [];
    let song = songs.find(item => String(item.id) === data.songId);
    if (!song) {
      songs = (await api.songs({ fresh: true })).songs || [];
      song = songs.find(item => String(item.id) === data.songId);
    }
    if (!song) throw new Error('Song not found in your Piano library. Refresh.');
    queue.addSong(song, false);
  } else if (action === 'queue:remove') {
    if (typeof data.queueId !== 'string' || !data.queueId) throw new Error('Invalid queue entry.');
    queue.removeQueueId(data.queueId);
  } else if (action === 'queue:reorder') {
    if (typeof data.queueId !== 'string' || !data.queueId || typeof data.targetQueueId !== 'string' || !data.targetQueueId) throw new Error('Invalid queue reorder.');
    if (!queue.reorderQueueId(data.queueId, data.targetQueueId, !!data.after)) throw new Error('Queue entries can only be dragged while Manual mode is active.');
  } else if (action === 'queue:duplicate') {
    if (typeof data.queueId !== 'string' || !data.queueId || !queue.duplicateQueueIdAfter(data.queueId)) throw new Error('Queue entry no longer exists.');
  } else if (action === 'queue:play-item') {
    if (typeof data.queueId !== 'string' || !data.queueId) throw new Error('Invalid queue entry.');
    if (!queue.getState().items?.some(item => item.queueId === data.queueId)) throw new Error('Queue entry no longer exists.');
    await queue.playQueueId(data.queueId);
  } else if (action === 'queue:mode') {
    if (!['manual', 'ordered', 'shuffle'].includes(data.value)) throw new Error('Invalid queue mode.');
    queue.setMode(data.value);
  } else if (action === 'queue:play') {
    if (!await queue.playQueue()) throw new Error('Player Queue could not start. Check the Piano status and try again.');
  }
  else if (action === 'queue:stop') await queue.stopQueue();
  else if (action === 'queue:next') await queue.next();
  else if (action === 'queue:previous') await queue.previous();
  else if (action === 'queue:shuffle') queue.shuffleRemaining();
  else if (action === 'queue:clear') queue.clearQueue();
  else if (action === 'queue:play-all') await queue.playAllLibrary();
  else if (action !== 'queue:get') throw new Error('Unknown Player Queue command.');
  return queueSnapshot();
}

function presetForSpeed(speed) {
  if (Math.abs(speed - 1.5) < 0.01) return 'fast';
  if (Math.abs(speed - 0.65) < 0.01) return 'slow';
  if (Math.abs(speed - 1) < 0.01) return 'natural';
  return 'custom';
}

function sheetProgressPreview(context, index, total) {
  const fallback = { text: String(context?.sheet || '').slice(0, 600), currentStart: -1, currentEnd: -1 };
  const project = window.PianoSheetProgressProjection?.buildPreview;
  if (typeof project !== 'function') return fallback;
  try { return project(context?.sheet, context?.timing_profile, index, total, 600); }
  catch (_) { return fallback; }
}

async function mediaSnapshot(api, workspace, media) {
  const context = typeof media === 'function' ? media() || {} : {};
  const songs = (await api.songs()).songs || [];
  const activeId = cleanText(context.activeSongId || context._activeSongId);
  const active = songs.find(song => String(song.id) === activeId);
  const durationMs = Math.max(0, Number(active?.duration_ms || context.duration_ms || 0));
  const total = Math.max(0, Number(context.total || 0));
  const index = Math.max(0, Math.min(total || Number(context.index || 0), Number(context.index || 0)));
  const preview = sheetProgressPreview(context, index, total);
  const positionMs = total > 0 ? Math.round(durationMs * index / total) : 0;
  const current = active ? summarizeFrontendSong(active) : activeId || cleanText(context.title) ? {
    id: activeId, title: cleanText(context.title) || 'Untitled', artist: '', kind: Array.isArray(context.performance) && context.performance.length ? 'recording' : 'song',
    source: cleanText(context.source, 120), duration_ms: durationMs, identifiers: {}, automatic_identifiers: { event_count: total, duration_ms: durationMs }
  } : null;
  return {
    current,
    status: cleanText(context.status, 30) || 'idle',
    index,
    total,
    positionMs,
    durationMs,
    sheetPreview: preview.text,
    sheetHighlight: { start: preview.currentStart, end: preview.currentEnd },
    sheetEvents: preview.events || [],
    preset: presetForSpeed(Number(context.speed || 1)),
    workspace: workspace?.snapshot?.() || { cursor: -1, history: [], staging: [] },
    recordings: songs.filter(song => Array.isArray(song.performance) && song.performance.length).length
  };
}

async function performMedia(data, api, deps) {
  const action = data.action;
  if (action === 'media:get') return;
  if (action === 'progress:seek') {
    const value = Number(data.eventIndex);
    if (!Number.isInteger(value) || value < 1 || value > 1000000) throw new Error('Invalid Piano seek position.');
    if (typeof deps.seek !== 'function') throw new Error('Piano seek is unavailable.');
    await deps.seek(value);
  } else if (action === 'playback:preset') {
    if (typeof deps.preset !== 'function') throw new Error('Piano playback presets are unavailable.');
    deps.preset(cleanText(data.value, 20));
  } else if (action === 'workspace:history-load') await deps.workspace?.loadHistory?.(cleanText(data.entryId));
  else if (action === 'workspace:inbox-load') await deps.workspace?.loadStaged?.(cleanText(data.entryId));
  else if (action === 'workspace:inbox-discard') deps.workspace?.discardStaged?.(cleanText(data.entryId));
  else if (action === 'library:import') {
    if (typeof deps.importSongs !== 'function') throw new Error('Piano import is unavailable.');
    deps.importSongs();
  } else if (action === 'song:load') {
    const songs = (await api.songs({ fresh: true })).songs || [];
    const song = songs.find(item => String(item.id) === cleanText(data.songId));
    if (!song || typeof deps.loadSong !== 'function') throw new Error('That Piano song is no longer available.');
    await deps.loadSong(song);
  } else if (action === 'song:update') {
    const id = cleanText(data.songId);
    const songs = (await api.songs({ fresh: true })).songs || [];
    const song = songs.find(item => String(item.id) === id);
    if (!song) throw new Error('That Piano song is no longer available.');
    const previous = song.identifiers && typeof song.identifiers === 'object' ? song.identifiers : {};
    const previousCustom = previous.custom && typeof previous.custom === 'object' ? previous.custom : {};
    const rating = data.rating === undefined ? (previous.personal_rating ?? null)
      : data.rating === '' || data.rating == null ? null : Number(data.rating);
    if (rating != null && (!Number.isFinite(rating) || rating < 0 || rating > 5)) throw new Error('Rating must be from 0 to 5.');
    const identifiers = {
      ...previous,
      author: cleanText(data.artist ?? previous.author ?? song.artist, 90),
      genre: cleanList(data.genre ?? previous.genre),
      tags: cleanList(data.tags ?? previous.tags),
      personal_rating: rating,
      custom: {
        ...previousCustom,
        favorite: data.favorite === true ? 'true' : data.favorite === false ? 'false' : String(previousCustom.favorite || 'false'),
        piano_tab: cleanText(data.tab ?? previousCustom.piano_tab, 80),
        piano_folder: cleanText(data.folder ?? previousCustom.piano_folder, 80),
        piano_group: cleanText(data.group ?? previousCustom.piano_group, 80)
      }
    };
    await api.saveSong({ ...song, title: cleanText(data.title ?? song.title) || 'Untitled', artist: identifiers.author, identifiers });
    window.dispatchEvent(new CustomEvent('piano:unified-refresh-requested'));
  } else throw new Error('Unknown Piano media command.');
}

export function setupExtendedPianoFrontendPort({ api, parent, parentOrigin, reply, workspace, media, seek, preset, importSongs, loadSong }) {
  let latestProgress = null;
  const progressSnapshot = () => {
    const p = latestProgress || {};
    const bar = byId('eventSeekRange');
    const total = Math.max(0, firstFinite(p.total_events, p.sheet_total, Number(bar?.max) > 1 ? bar.max : 0));
    const index = firstFinite(p.current_index, Number(bar?.value) > 0 ? bar.value : 0);
    const preview = sheetProgressPreview(typeof media === 'function' ? media() || {} : {}, index, total);
    return { status: String(p.status || byId('statusChip')?.dataset.state || 'idle').slice(0, 30),
      index: total ? Math.max(0, Math.min(total, index)) : 0, total,
      token: String(p.current_token || byId('currentToken')?.textContent || '').slice(0, 120),
      sheetPreview: preview.text, sheetHighlight: { start: preview.currentStart, end: preview.currentEnd },
      sheetEvents: preview.events || [] };
  };
  const supported = new Set(['controls:get', 'controls:set', 'controls:refresh', 'queue:get',
    'queue:add', 'queue:remove', 'queue:reorder', 'queue:duplicate', 'queue:play-item', 'queue:mode', 'queue:play', 'queue:stop',
    'queue:next', 'queue:previous', 'queue:shuffle', 'queue:clear', 'queue:play-all', 'progress:get', 'progress:seek',
    'media:get', 'playback:preset', 'workspace:history-load', 'workspace:inbox-load', 'workspace:inbox-discard',
    'library:import', 'song:load', 'song:update']);
  let mutating = false;
  window.addEventListener('message', async event => {
    const data = event.data;
    if (event.source !== parent || (parentOrigin && event.origin !== parentOrigin)) return;
    if (data?.type !== 'eveos:piano-frontend-port-command' || !Number.isSafeInteger(data.id) || !supported.has(data.action)) return;
    const result = { type: 'piano:eveos-frontend-port-response', id: data.id, action: data.action };
    const mutation = !['controls:get', 'queue:get', 'progress:get', 'media:get'].includes(data.action);
    try {
      if (mutation && mutating) throw new Error('Piano is processing another setting or queue command.');
      if (mutation) mutating = true;
      if (data.action === 'progress:get') result.progress = progressSnapshot();
      else if (supported.has(data.action) && !data.action.startsWith('controls:') && !data.action.startsWith('queue:')) {
        await performMedia(data, api, { workspace, media, seek, preset, importSongs, loadSong });
        result.media = await mediaSnapshot(api, workspace, media);
      }
      else if (data.action === 'controls:get') result.controls = controlsSnapshot();
      else if (data.action === 'controls:set') result.controls = await setControl(data);
      else if (data.action === 'controls:refresh') { byId('refreshWindowsBtn')?.click(); result.controls = controlsSnapshot(); }
      else result.queue = await performQueue(data, api);
    } catch (error) { result.error = String(error?.message || 'Piano command failed.').slice(0, 180); }
    finally { if (mutation) mutating = false; }
    reply(result);
  });
  const updates = () => reply({ type: 'piano:eveos-port-update', controls: controlsSnapshot(), queue: queueSnapshot() });
  const mediaUpdates = async () => {
    try { reply({ type: 'piano:eveos-port-update', media: await mediaSnapshot(api, workspace, media) }); } catch (_) {}
  };
  window.addEventListener('piano:sheet-progress-status', event => {
    latestProgress = event.detail && typeof event.detail === 'object' ? event.detail : null;
    reply({ type: 'piano:eveos-port-update', progress: progressSnapshot() });
  });
  window.addEventListener('piano:player-queue-ready', updates);
  window.addEventListener('piano:queue-updated', updates);
  window.addEventListener('piano:workspace-updated', mediaUpdates);
  window.addEventListener('piano:unified-refresh-requested', mediaUpdates);
  document.addEventListener('change', event => {
    if (['internalPlay', 'windowSelect', 'pianoLayout', 'pianoSound'].includes(event.target?.id)) updates();
  });
  updates();
  reply({ type: 'piano:eveos-port-update', progress: progressSnapshot() });
  void mediaUpdates();
}

export function summarizeFrontendSong(song) {
  const identifiers = song?.identifiers || {}, auto = song?.automatic_identifiers || {};
  return {
    id: String(song.id || ''), title: String(song.title || 'Untitled'), artist: String(song.artist || ''),
    kind: song.performance?.length ? 'recording' : 'song', source: String(song.source || ''),
    updated_at: Number(song.updated_at || 0), duration_ms: Number(auto.duration_ms || song.duration_ms || 0),
    identifiers: { author: String(identifiers.author || ''), genre: identifiers.genre || [], tags: identifiers.tags || [],
      personal_rating: identifiers.personal_rating ?? null, custom: {
        favorite: String(identifiers.custom?.favorite || ''),
        piano_tab: String(identifiers.custom?.piano_tab || ''),
        piano_folder: String(identifiers.custom?.piano_folder || ''),
        piano_group: String(identifiers.custom?.piano_group || '')
      } },
    automatic_identifiers: { kind: String(auto.kind || ''), source_host: String(auto.source_host || ''),
      event_count: Number(auto.event_count || 0), duration_ms: Number(auto.duration_ms || 0),
      conversion_rating: auto.conversion_rating ?? null, tags: auto.tags || [] }
  };
}
