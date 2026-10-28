const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PIANO = path.join(ROOT, 'tools', 'Piano-Auto-Player');
const WEB = path.join(PIANO, 'web');
const APP = path.join(PIANO, 'app');
const LIBRARY = fs.readFileSync(path.join(APP, 'library.py'), 'utf8');
const SERVER = fs.readFileSync(path.join(APP, 'server.py'), 'utf8');
const API = fs.readFileSync(path.join(WEB, 'api.js'), 'utf8');
const MAIN_APP = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
const QUEUE = fs.readFileSync(path.join(WEB, 'player_queue.js'), 'utf8');
const PLANNER = fs.readFileSync(path.join(WEB, 'player_queue_advanced.js'), 'utf8');
const PLANNER_STATE = fs.readFileSync(path.join(WEB, 'player_queue_planner_state.js'), 'utf8');
const CSS = fs.readFileSync(path.join(WEB, 'player_queue_advanced.css'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(WEB, 'eveos-host-bridge.js'), 'utf8');
const UNIFIED = fs.readFileSync(path.join(WEB, 'piano_unified_workspace.js'), 'utf8');
const UNIFIED_CSS = fs.readFileSync(path.join(WEB, 'piano_unified_workspace.css'), 'utf8');
const SHEET_PROGRESS = fs.readFileSync(path.join(WEB, 'sheet_progress.js'), 'utf8');
const QUEUE_PREVIEW = fs.readFileSync(path.join(WEB, 'piano_queue_preview.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const BASE_CSS = fs.readFileSync(path.join(WEB, 'styles.css'), 'utf8');
const TRANSFER = fs.readFileSync(path.join(APP, 'library_transfer.py'), 'utf8');

for (const token of [
  '"identifiers"', '"automatic_identifiers"', 'personal_rating', 'conversion_rating',
  'genre', 'tags', 'author', 'custom', 'event_count', 'note_count', 'duration_ms',
  'event_density_per_minute', 'source_host', 'hifi_worst_window_confidence', 'update_identifiers'
]) assert(LIBRARY.includes(token), `library metadata contract missing: ${token}`);

for (const token of [
  'Send to Queue', 'Remove from Queue', 'Remove Entirely', 'Replace Queue', 'Go to Queue', 'Go back', 'Play selected', 'Stop playback', 'Shuffle Queue',
  'Save identifiers', 'automatic_identifiers', 'personal_rating', 'conversion_rating',
  'Required tag', 'Min events', 'Max events', 'Custom identifiers',
  'api.updateSongIdentifiers', 'PianoPlayerQueue', 'addSongs', 'document.createTextNode',
  'async function withQueue(action)', '<details class="planner-filters">', 'FILTERS &amp; SORTING'
]) assert(PLANNER.includes(token), `planner contract missing: ${token}`);
assert(PLANNER_STATE.includes('piano_player_planner_v1') && PLANNER_STATE.includes('filteredSongs'), 'planner preference and filtering owner must remain durable');
assert(!PLANNER.includes('<details class="planner-filters" open'), 'advanced filters must default collapsed');
assert(PLANNER.includes('<details class="planner-actions">') && !PLANNER.includes('<details class="planner-actions" open'), 'selection and queue actions must default collapsed');
assert(PLANNER.includes('removeAllSongs') && PLANNER.includes('state.lastPill'), 'planner must expose complete queue removal and reversible queue-tab navigation');

for (const token of ['sheet-workspace-planner', 'planner-filters[open]', 'planner-filterbar', 'planner-grid', 'planner-editor', '@media (max-width: 760px)']) {
  assert(CSS.includes(token), `planner CSS contract missing: ${token}`);
}

for (const token of [
  'My Songs', 'PIANO LIBRARY / WORKSPACE', 'NOW PLAYING', 'Queue mode',
  'SONG / RECORDING DETAILS', 'THIS SONG OVERRIDE · blank = global default',
  'LIBRARY BROWSER', 'data-u-library-toggle', "savedCollapsed('library-browser', false)",
  "const LEGACY_QUEUE = '.sheet-workspace-queue'", "const LEGACY_LIBRARY = '.library-panel'",
  "queuePanel.hidden = true", "libraryPanel.hidden = true", "data-u-mode", 'PianoPlayerQueue',
  'data-u-workspace-toggle', 'data-u-editor-toggle', 'piano-panel-toggle',
  "enhancePanelDisclosure('.controls-panel', 'playback-controls', false)",
  "enhancePanelDisclosure('.recorder-panel', 'custom-performance', true)",
  "enhancePanelDisclosure('.search-panel', 'sheet-finder', false)",
  "enhancePanelDisclosure('.notation-panel', 'compatibility', true)",
  "savedCollapsed('song-details', true)", "savedCollapsed('my-songs', false)",
  "document.getElementById('importLibraryInput')", 'waitForQueueApi',
  'data-u-queue-preview', 'data-u-previous', 'data-u-next-button', 'Player Queue controller is unavailable'
]) assert(UNIFIED.includes(token), `unified Piano workspace contract missing: ${token}`);
assert(UNIFIED.includes('data-u-view-player') && UNIFIED.includes('playQueueId') && QUEUE_PREVIEW.includes("status === 'candidate'"), 'Now Playing must navigate to the player and expose clickable ordered/shuffle timeline entries');
for (const token of ['draggable = true', 'onMove(source, item.queueId, after)', 'onDuplicate(item.queueId)', 'onRemove(item.queueId)']) assert(QUEUE_PREVIEW.includes(token), `manual queue preview contract missing: ${token}`);

for (const token of [
  '.piano-unified-workspace', '.piano-now-playing', '.piano-unified-head',
  '.piano-library-browser', '.piano-library-browser-body',
  '.piano-library-browser[data-u-collapsed="1"] .piano-library-browser-body',
  '.library-panel[hidden][data-compatibility-bridge]', '@media (max-width: 760px)',
  'grid-template-columns: auto auto minmax(0, 1fr) auto',
  '.planner-editor[data-u-collapsed="1"]', '.planner-grid.editor-collapsed',
  '.piano-collapsible-panel[data-u-collapsed="1"]',
  'button:not(.planner-pill):not(.planner-fav-btn)', 'min-height: 30px',
  '.planner-queue-btns [data-p-q-up]', '.planner-queue-btns [data-p-q-down]'
]) assert(UNIFIED_CSS.includes(token), `unified Piano workspace CSS contract missing: ${token}`);

assert(UNIFIED.includes("panel.closest('.hero-grid')?.classList.toggle('piano-controls-collapsed', collapsed)"),
  'Playback disclosure must own the hero-grid collapsed state');
const collapsedHeroRule = UNIFIED_CSS.match(/\.hero-grid\.piano-controls-collapsed\s*\{([^}]*)\}/)?.[1] || '';
assert(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+(?:minmax\(|clamp\(|fit-content\(|auto\b|\d)/.test(collapsedHeroRule)
  && !/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+max-content\s*;/.test(collapsedHeroRule)
  && UNIFIED_CSS.includes('.hero-grid.piano-controls-collapsed > .controls-panel[data-u-collapsed="1"]'),
  'collapsed Playback must give the player flexible width and retain a responsive Controls card');
const stackedControlsLayout = UNIFIED_CSS.split('@media (max-width: 1180px) {')[1]?.split('@media (max-width: 900px) {')[0] || '';
assert(/grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(stackedControlsLayout)
  && /width:\s*100%/.test(stackedControlsLayout)
  && /justify-self:\s*stretch/.test(stackedControlsLayout),
  'stacked collapsed Playback must fill its column and retain compact height');
assert(UNIFIED.includes('const QUEUE_PREVIEW_CLOSE_MS = 550;')
  && UNIFIED.includes("nextWrap.addEventListener('pointerleave', schedulePreviewClose)")
  && UNIFIED.includes("nextWrap.addEventListener('pointerenter', () => { keepPreviewOpen(); revealCurrent(); })")
  && UNIFIED.includes("nextWrap.addEventListener('focusin', event =>")
  && UNIFIED.includes("nextWrap.addEventListener('focusout', schedulePreviewClose)")
  && UNIFIED.includes("!nextWrap.matches(':hover') && !nextWrap.contains(document.activeElement)"),
  'queue preview must retain focus, cancel delayed close on reentry, and close when idle');
assert(UNIFIED_CSS.includes('.piano-next-wrap[data-preview-open="1"] .piano-queue-preview'),
  'delayed-open queue preview must remain visible across the pointer gap');
assert(INDEX.includes('<details class="event-view-disclosure">')
  && !INDEX.includes('<details class="event-view-disclosure" open>')
  && INDEX.includes('<div class="event-view-body">'),
  'event view and sheet editor must use a default-collapsed disclosure');
for (const token of ['.event-view-disclosure > summary', '.event-view-disclosure[open] > summary::after', '.event-view-disclosure:not([open]) > .event-view-body']) {
  assert(BASE_CSS.includes(token), `event disclosure CSS contract missing: ${token}`);
}
assert(UNIFIED_CSS.includes('.recorder-panel[data-u-collapsed="1"] > .recorder-head > div > .muted')
  && UNIFIED_CSS.includes('.recorder-panel[data-u-collapsed="1"] > .recorder-head > div > h2'),
  'collapsed custom performance panel must hide its description and retain a compact title');
assert(UNIFIED_CSS.includes('.piano-unified-workspace .planner-action-pair button')
  && UNIFIED_CSS.includes('flex: 1 1 108px')
  && UNIFIED_CSS.includes('white-space: normal'),
  'planner action labels and buttons must adapt without clipped text');

assert(SERVER.includes('if path == "/api/songs/identifiers"'), 'server must expose a metadata-only update route');
assert(SERVER.includes('LIBRARY.update_identifiers(song_id, identifiers)'), 'metadata-only route must not use the full-song save path');
assert(API.includes('updateSongIdentifiers') && API.includes('/api/songs/identifiers'), 'web API must expose metadata-only updates');
assert(PLANNER.includes('api.updateSongIdentifiers(songId, identifiers)'), 'planner must use the shared metadata mutation owner');
assert(!PLANNER.includes('JSON.stringify({ ...song, identifiers })'), 'planner must not write a stale full-song snapshot during metadata edits');
assert(!PLANNER.includes('node.innerHTML = `<b>${key}</b>${String(value)}`'), 'automatic metadata values must not flow through innerHTML');
assert(!PLANNER.includes('pianoSongId'), 'planner must not couple queue operations to library-card array order');
assert(!PLANNER.includes('textContent.trim() === "Queue"'), 'planner must not locate queue actions by visible button text');
assert(!PLANNER.includes('playBtn.addEventListener("click", () => { if (queue)'), 'row Play must resolve the live queue controller instead of closing over startup state');
assert(LIBRARY.includes('if "custom" in patch:'), 'explicit custom metadata updates must support deletion/replacement');
assert(BRIDGE.includes("import('./player_queue.js')") && BRIDGE.includes("import('./player_queue_advanced.js')") && BRIDGE.includes("import('./piano_unified_workspace.js')"), 'bridge must load queue, metadata controller, then the unified visible workspace');
assert(BRIDGE.indexOf("import('./player_queue.js')") < BRIDGE.indexOf("import('./player_queue_advanced.js')") && BRIDGE.indexOf("import('./player_queue_advanced.js')") < BRIDGE.indexOf("import('./piano_unified_workspace.js')"), 'unified Piano workspace must load only after proven queue and metadata controllers');
assert(BRIDGE.includes('piano:module-error') && !BRIDGE.includes('.catch(() => {})'), 'bridge must surface module load failures');
assert(BRIDGE.includes("addEventListener('DOMContentLoaded', loadWorkspaceModules") && !BRIDGE.includes("addEventListener('load'"), 'workspace modules must not wait for optional page resources');
assert(API.includes('if (songsRequest) return songsRequest') && API.includes('songsGeneration'), 'song API must coalesce reads and fence stale snapshots');
assert(QUEUE.includes('api.songs()') && PLANNER.includes('api.songs()'), 'queue and planner must share the canonical song snapshot owner');
assert(!QUEUE.includes('fetch("/api/songs"') && !PLANNER.includes('fetch("/api/songs"'), 'workspace modules must not duplicate the large song-library request');
assert(!UNIFIED.includes("dispatchEvent(new CustomEvent('piano:unified-refresh-requested'"), 'unified Refresh must not emit a second refresh beside the canonical control');
assert(TRANSFER.includes('json.dumps({"format": _FORMAT_SONG, "schema": _SCHEMA, "song": song}'), 'library export must continue carrying the full song record');
assert(UNIFIED.includes("dataset.compatibilityBridge = 'player-queue'") && UNIFIED.includes("dataset.compatibilityBridge = 'local-library'"), 'old queue/library panels must remain compatibility bridges rather than separate visible workspaces');
assert(UNIFIED.includes('const queue = await waitForQueueApi();') && UNIFIED.includes('queue?.render?.();'), 'unified workspace must force a live queue render after controller readiness');
assert(UNIFIED.includes('queue.toggleQueue?.()') && UNIFIED.includes('queue.previous?.()') && UNIFIED.includes('queue.next?.()'), 'unified transport must use the canonical queue toggle and history navigation');
assert(UNIFIED.includes("saveCollapsed('library-browser', collapsed)"), 'library browser disclosure state must persist with the existing Piano disclosure store');
assert(UNIFIED.includes("setStatus('Reloading Piano workspace…', 'countdown')") && UNIFIED.includes('window.location.reload();'), 'unified Refresh must reload the actual Piano runtime and its UI assets');
assert(UNIFIED.includes("['.planner-pills', '.planner-filters', '.planner-actions', '.planner-grid']"), 'unified workspace must move the complete collapsed filter disclosure, not detach its controls');
assert(UNIFIED_CSS.includes('grid-template-columns: minmax(0, 1fr) clamp(250px, 24vw, 360px)')
  && /width:\s*100%/.test(stackedControlsLayout) && /justify-self:\s*stretch/.test(stackedControlsLayout),
  'collapsed Playback must retain responsive wide layout and full-width stacked layout');
assert(MAIN_APP.includes('setSeekTarget(stoppedResumeEvent > 0 ? stoppedResumeEvent : 1, false, currentSeekTotal())'),
  'Stop must display the authoritative resume position instead of resetting to event one');
assert(SHEET_PROGRESS.includes('status?.status === "idle" && Number(status?.resume_index || 0) > 0')
  && SHEET_PROGRESS.includes('currentIndexFromStatus(status, currentIndex ||'),
  'sheet event marker must persist during stopping and reflect idle resume position');
assert(MAIN_APP.includes('els.play.addEventListener("click", startPlayback)') && MAIN_APP.includes('els.pause.addEventListener("click", togglePause)') && MAIN_APP.includes('els.stop.addEventListener("click", stopPlayback)'), 'core Play/Pause/Stop bindings must remain intact');
assert(PLANNER.split(/\r?\n/).length < 450, 'advanced planner exceeds the 450-line first-party cap');
assert(UNIFIED.split(/\r?\n/).length < 450, 'unified workspace adapter exceeds the 450-line first-party cap');
assert(LIBRARY.split(/\r?\n/).length < 450, 'song library exceeds the 450-line first-party cap');
verifySongSnapshot().then(() => console.log('PIANO_METADATA_PLANNER_SMOKE_OK')).catch(error => { console.error(error); process.exitCode = 1; });

async function verifySongSnapshot() {
  const previousFetch = global.fetch;
  let calls = 0;
  global.fetch = async (url) => ({ ok: true, status: 200, json: async () => {
    calls += 1;
    return String(url).includes('/identifiers') ? { song: { id: 'song-1' } } : { songs: [{ id: 'song-1' }] };
  } });
  try {
    const source = `data:text/javascript;base64,${Buffer.from(API).toString('base64')}#piano-snapshot`;
    const { api } = await import(source);
    const [first, second] = await Promise.all([api.songs(), api.songs()]);
    assert(first === second && calls === 1, 'concurrent song reads must share one response');
    await api.songs();
    assert(calls === 1, 'trusted song snapshot must serve repeated workspace hydration');
    await api.updateSongIdentifiers('song-1', { tags: ['updated'] });
    await api.songs();
    assert(calls === 3, 'successful song mutation must invalidate the shared snapshot');
  } finally { global.fetch = previousFetch; }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
