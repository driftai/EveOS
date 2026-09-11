const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const PIANO = path.join(ROOT, 'tools', 'Piano-Auto-Player');
const WEB = path.join(PIANO, 'web');
const APP = path.join(PIANO, 'app');
const LIBRARY = fs.readFileSync(path.join(APP, 'library.py'), 'utf8');
const SERVER = fs.readFileSync(path.join(APP, 'server.py'), 'utf8');
const API = fs.readFileSync(path.join(WEB, 'api.js'), 'utf8');
const MAIN_APP = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
const PLANNER = fs.readFileSync(path.join(WEB, 'player_queue_advanced.js'), 'utf8');
const CSS = fs.readFileSync(path.join(WEB, 'player_queue_advanced.css'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(WEB, 'eveos-host-bridge.js'), 'utf8');
const UNIFIED = fs.readFileSync(path.join(WEB, 'piano_unified_workspace.js'), 'utf8');
const UNIFIED_CSS = fs.readFileSync(path.join(WEB, 'piano_unified_workspace.css'), 'utf8');
const TRANSFER = fs.readFileSync(path.join(APP, 'library_transfer.py'), 'utf8');

for (const token of [
  '"identifiers"', '"automatic_identifiers"', 'personal_rating', 'conversion_rating',
  'genre', 'tags', 'author', 'custom', 'event_count', 'note_count', 'duration_ms',
  'event_density_per_minute', 'source_host', 'hifi_worst_window_confidence', 'update_identifiers'
]) assert(LIBRARY.includes(token), `library metadata contract missing: ${token}`);

for (const token of [
  'Send to Queue', 'Replace Queue', 'Play selected', 'Shuffle selected',
  'Save identifiers', 'automatic_identifiers', 'personal_rating', 'conversion_rating',
  'Required tag', 'Min events', 'Max events', 'Custom identifiers', 'piano_player_planner_v1',
  '/api/songs/identifiers', 'PianoPlayerQueue', 'addSongs', 'document.createTextNode'
]) assert(PLANNER.includes(token), `planner contract missing: ${token}`);

for (const token of ['sheet-workspace-planner', 'planner-filterbar', 'planner-grid', 'planner-editor', '@media (max-width: 760px)']) {
  assert(CSS.includes(token), `planner CSS contract missing: ${token}`);
}

for (const token of [
  'My Songs', 'PIANO LIBRARY / WORKSPACE', 'NOW PLAYING', 'Queue mode',
  'SONG / RECORDING DETAILS', 'THIS SONG OVERRIDE · blank = global default',
  "const LEGACY_QUEUE = '.sheet-workspace-queue'", "const LEGACY_LIBRARY = '.library-panel'",
  "queuePanel.hidden = true", "libraryPanel.hidden = true", "data-u-mode", 'PianoPlayerQueue',
  'data-u-workspace-toggle', 'data-u-editor-toggle', 'piano-panel-toggle',
  "enhancePanelDisclosure('.controls-panel', 'playback-controls', false)",
  "enhancePanelDisclosure('.recorder-panel', 'custom-performance', true)",
  "enhancePanelDisclosure('.search-panel', 'sheet-finder', false)",
  "enhancePanelDisclosure('.notation-panel', 'compatibility', true)",
  "savedCollapsed('song-details', true)", "savedCollapsed('my-songs', false)",
  "document.getElementById('importLibraryInput')", 'waitForQueueApi',
  "proxyButton('stopBtn')", 'Player Queue controller is unavailable'
]) assert(UNIFIED.includes(token), `unified Piano workspace contract missing: ${token}`);

for (const token of [
  '.piano-unified-workspace', '.piano-now-playing', '.piano-unified-head',
  '.library-panel[hidden][data-compatibility-bridge]', '@media (max-width: 760px)',
  'grid-template-columns: auto auto minmax(0, 1fr) auto',
  '.planner-editor[data-u-collapsed="1"]', '.planner-grid.editor-collapsed',
  '.piano-collapsible-panel[data-u-collapsed="1"]',
  'button:not(.planner-pill):not(.planner-fav-btn)', 'min-height: 30px',
  '.planner-queue-btns [data-p-q-up]', '.planner-queue-btns [data-p-q-down]'
]) assert(UNIFIED_CSS.includes(token), `unified Piano workspace CSS contract missing: ${token}`);

assert(SERVER.includes('if path == "/api/songs/identifiers"'), 'server must expose a metadata-only update route');
assert(SERVER.includes('LIBRARY.update_identifiers(song_id, identifiers)'), 'metadata-only route must not use the full-song save path');
assert(API.includes('updateSongIdentifiers') && API.includes('/api/songs/identifiers'), 'web API must expose metadata-only updates');
assert(PLANNER.includes('JSON.stringify({ id: songId, identifiers })'), 'planner must send only song id + identifiers');
assert(!PLANNER.includes('JSON.stringify({ ...song, identifiers })'), 'planner must not write a stale full-song snapshot during metadata edits');
assert(!PLANNER.includes('node.innerHTML = `<b>${key}</b>${String(value)}`'), 'automatic metadata values must not flow through innerHTML');
assert(!PLANNER.includes('pianoSongId'), 'planner must not couple queue operations to library-card array order');
assert(!PLANNER.includes('textContent.trim() === "Queue"'), 'planner must not locate queue actions by visible button text');
assert(LIBRARY.includes('if "custom" in patch:'), 'explicit custom metadata updates must support deletion/replacement');
assert(BRIDGE.includes("import('./player_queue.js')") && BRIDGE.includes("import('./player_queue_advanced.js')") && BRIDGE.includes("import('./piano_unified_workspace.js')"), 'bridge must load queue, metadata controller, then the unified visible workspace');
assert(BRIDGE.indexOf("import('./player_queue.js')") < BRIDGE.indexOf("import('./player_queue_advanced.js')") && BRIDGE.indexOf("import('./player_queue_advanced.js')") < BRIDGE.indexOf("import('./piano_unified_workspace.js')"), 'unified Piano workspace must load only after proven queue and metadata controllers');
assert(BRIDGE.includes('piano:module-error') && !BRIDGE.includes('.catch(() => {})'), 'bridge must surface module load failures');
assert(TRANSFER.includes('json.dumps({"format": _FORMAT_SONG, "schema": _SCHEMA, "song": song}'), 'library export must continue carrying the full song record');
assert(UNIFIED.includes("dataset.compatibilityBridge = 'player-queue'") && UNIFIED.includes("dataset.compatibilityBridge = 'local-library'"), 'old queue/library panels must remain compatibility bridges rather than separate visible workspaces');
assert(UNIFIED.includes('const queue = await waitForQueueApi();') && UNIFIED.includes('queue?.render?.();'), 'unified workspace must force a live queue render after controller readiness');
assert(UNIFIED.includes("if (!proxyButton('stopBtn'))"), 'unified Stop must route through the proven main Stop control before queue-only fallback');
assert(MAIN_APP.includes('els.play.addEventListener("click", startPlayback)') && MAIN_APP.includes('els.pause.addEventListener("click", togglePause)') && MAIN_APP.includes('els.stop.addEventListener("click", stopPlayback)'), 'core Play/Pause/Stop bindings must remain intact');
assert(PLANNER.split(/\r?\n/).length < 450, 'advanced planner exceeds the 450-line first-party cap');
assert(UNIFIED.split(/\r?\n/).length < 450, 'unified workspace adapter exceeds the 450-line first-party cap');
assert(LIBRARY.split(/\r?\n/).length < 450, 'song library exceeds the 450-line first-party cap');
console.log('PIANO_METADATA_PLANNER_SMOKE_OK');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
