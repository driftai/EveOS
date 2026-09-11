const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const PIANO = path.join(ROOT, 'tools', 'Piano-Auto-Player');
const WEB = path.join(PIANO, 'web');
const APP = path.join(PIANO, 'app');
const LIBRARY = fs.readFileSync(path.join(APP, 'library.py'), 'utf8');
const SERVER = fs.readFileSync(path.join(APP, 'server.py'), 'utf8');
const API = fs.readFileSync(path.join(WEB, 'api.js'), 'utf8');
const PLANNER = fs.readFileSync(path.join(WEB, 'player_queue_advanced.js'), 'utf8');
const CSS = fs.readFileSync(path.join(WEB, 'player_queue_advanced.css'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(WEB, 'eveos-host-bridge.js'), 'utf8');
const TRANSFER = fs.readFileSync(path.join(APP, 'library_transfer.py'), 'utf8');

for (const token of [
  '"identifiers"', '"automatic_identifiers"', 'personal_rating', 'conversion_rating',
  'genre', 'tags', 'author', 'custom', 'event_count', 'note_count', 'duration_ms',
  'event_density_per_minute', 'source_host', 'hifi_worst_window_confidence', 'update_identifiers'
]) assert(LIBRARY.includes(token), `library metadata contract missing: ${token}`);

for (const token of [
  'ADVANCED PLAYBACK', 'Send to Queue', 'Replace Queue', 'Play selected', 'Shuffle selected',
  'Save identifiers', 'automatic_identifiers', 'personal_rating', 'conversion_rating',
  'Required tag', 'Min events', 'Max events', 'Custom identifiers', 'piano_player_planner_v1',
  '/api/songs/identifiers', 'PianoPlayerQueue', 'addSongs', 'document.createTextNode'
]) assert(PLANNER.includes(token), `planner contract missing: ${token}`);

for (const token of ['sheet-workspace-planner', 'planner-filterbar', 'planner-grid', 'planner-editor', '@media (max-width: 760px)']) {
  assert(CSS.includes(token), `planner CSS contract missing: ${token}`);
}

assert(SERVER.includes('if path == "/api/songs/identifiers"'), 'server must expose a metadata-only update route');
assert(SERVER.includes('LIBRARY.update_identifiers(song_id, identifiers)'), 'metadata-only route must not use the full-song save path');
assert(API.includes('updateSongIdentifiers') && API.includes('/api/songs/identifiers'), 'web API must expose metadata-only updates');
assert(PLANNER.includes('JSON.stringify({ id: songId, identifiers })'), 'planner must send only song id + identifiers');
assert(!PLANNER.includes('JSON.stringify({ ...song, identifiers })'), 'planner must not write a stale full-song snapshot during metadata edits');
assert(!PLANNER.includes('node.innerHTML = `<b>${key}</b>${String(value)}`'), 'automatic metadata values must not flow through innerHTML');
assert(!PLANNER.includes('pianoSongId'), 'planner must not couple queue operations to library-card array order');
assert(!PLANNER.includes('textContent.trim() === "Queue"'), 'planner must not locate queue actions by visible button text');
assert(LIBRARY.includes('if "custom" in patch:'), 'explicit custom metadata updates must support deletion/replacement');
assert(BRIDGE.includes("import('./player_queue.js')") && BRIDGE.includes("import('./player_queue_advanced.js')"), 'bridge must load the advanced planner after Player Queue');
assert(BRIDGE.includes('piano:module-error') && !BRIDGE.includes('.catch(() => {})'), 'bridge must surface module load failures');
assert(TRANSFER.includes('json.dumps({"format": _FORMAT_SONG, "schema": _SCHEMA, "song": song}'), 'library export must continue carrying the full song record');
assert(PLANNER.split(/\r?\n/).length < 450, 'advanced planner exceeds the 450-line first-party cap');
assert(LIBRARY.split(/\r?\n/).length < 450, 'song library exceeds the 450-line first-party cap');
console.log('PIANO_METADATA_PLANNER_SMOKE_OK');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
