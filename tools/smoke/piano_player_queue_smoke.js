const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const PIANO = path.join(ROOT, 'tools', 'Piano-Auto-Player', 'web');
const queue = fs.readFileSync(path.join(PIANO, 'player_queue.js'), 'utf8');
const css = fs.readFileSync(path.join(PIANO, 'player_queue.css'), 'utf8');
const bridge = fs.readFileSync(path.join(PIANO, 'eveos-host-bridge.js'), 'utf8');

for (const token of [
  'PLAYER QUEUE',
  'Play all library',
  'Shuffle',
  'Manual — stop after each song',
  'Ordered — advance in queue order',
  'Shuffle — choose a random next song',
  'piano_player_queue_v1',
  'transitionMs',
  'data-add-player-queue',
  'advanceAfterComplete',
  'sheet-workspace-queue',
  'playerQueueReady',
  'addSongs',
  'pianoQueueController',
  'Queued song did not finish loading',
]) assert(queue.includes(token), `queue contract missing: ${token}`);

assert(queue.includes('if (!loaded) throw new Error'), 'queue must refuse playback when the requested library song never finishes loading');
assert(queue.includes('try { playButton.click(); } finally { suppressCancel = false; }'), 'queue must restore suppression state after programmatic play');

for (const token of ['sheet-workspace-queue', 'player-queue-now', 'player-queue-item', '@media (max-width: 760px)']) {
  assert(css.includes(token), `queue CSS contract missing: ${token}`);
}

assert(bridge.includes("import('./player_queue.js')"), 'EveOS host bridge must load Player Queue');
assert(queue.split(/\r?\n/).length < 450, 'Player Queue controller exceeds the 450-line first-party cap');
console.log('PIANO_PLAYER_QUEUE_SMOKE_OK');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
