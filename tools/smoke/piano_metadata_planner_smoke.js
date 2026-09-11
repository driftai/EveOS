const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const PIANO = path.join(ROOT, 'tools', 'Piano-Auto-Player');
const WEB = path.join(PIANO, 'web');
const LIBRARY = fs.readFileSync(path.join(PIANO, 'app', 'library.py'), 'utf8');
const PLANNER = fs.readFileSync(path.join(WEB, 'player_queue_advanced.js'), 'utf8');
const CSS = fs.readFileSync(path.join(WEB, 'player_queue_advanced.css'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(WEB, 'eveos-host-bridge.js'), 'utf8');
const TRANSFER = fs.readFileSync(path.join(PIANO, 'app', 'library_transfer.py'), 'utf8');

for (const token of [
  '"identifiers"', '"automatic_identifiers"', 'personal_rating', 'conversion_rating',
  'genre', 'tags', 'author', 'custom', 'event_count', 'note_count', 'duration_ms',
  'event_density_per_minute', 'source_host', 'hifi_worst_window_confidence', 'update_identifiers',
  'custom_source = patch.get("custom") if "custom" in patch else'
]) assert(LIBRARY.includes(token), `library metadata contract missing: ${token}`);

for (const token of [
  'ADVANCED PLAYBACK', 'Send to Queue', 'Replace Queue', 'Play selected', 'Shuffle selected',
  'Save identifiers', 'automatic_identifiers', 'personal_rating', 'conversion_rating',
  'Required tag', 'Min events', 'Max events', 'Custom identifiers', 'piano_player_planner_v1',
  'playerQueueReady', 'queue.addSongs', 'JSON.stringify({ id: song.id, identifiers })',
  'document.createTextNode(String(value))'
]) assert(PLANNER.includes(token), `planner contract missing: ${token}`);

assert(!PLANNER.includes('body: JSON.stringify({ ...song, identifiers })'), 'planner must not write stale full-song snapshots during metadata edits');
assert(!PLANNER.includes('node.innerHTML = `<b>${key}</b>${String(value)}`'), 'planner automatic metadata must not render imported values through innerHTML');

for (const token of ['sheet-workspace-planner', 'planner-filterbar', 'planner-grid', 'planner-editor', '@media (max-width: 760px)']) {
  assert(CSS.includes(token), `planner CSS contract missing: ${token}`);
}

assert(BRIDGE.includes("import('./player_queue.js')") && BRIDGE.includes("import('./player_queue_advanced.js')"), 'bridge must load the advanced planner after Player Queue');
assert(BRIDGE.includes('reportModuleError') && BRIDGE.includes('console.error'), 'bridge must surface optional module load failures');
assert(TRANSFER.includes('json.dumps({"format": _FORMAT_SONG, "schema": _SCHEMA, "song": song}'), 'library export must continue carrying the full song record');
assert(PLANNER.split(/\r?\n/).length < 450, 'advanced planner exceeds the 450-line first-party cap');
assert(LIBRARY.split(/\r?\n/).length < 450, 'song library exceeds the 450-line first-party cap');
console.log('PIANO_METADATA_PLANNER_SMOKE_OK');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
