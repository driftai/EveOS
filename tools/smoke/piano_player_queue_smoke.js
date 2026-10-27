const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const TOOL = path.join(ROOT, 'tools', 'Piano-Auto-Player');
const WEB = path.join(TOOL, 'web');
const APP = path.join(TOOL, 'app');
const queue = fs.readFileSync(path.join(WEB, 'player_queue.js'), 'utf8');
const queueState = fs.readFileSync(path.join(WEB, 'player_queue_state.js'), 'utf8');
const css = fs.readFileSync(path.join(WEB, 'player_queue.css'), 'utf8');
const workspace = fs.readFileSync(path.join(WEB, 'sheet_workspace.js'), 'utf8');
const bridge = fs.readFileSync(path.join(WEB, 'eveos-host-bridge.js'), 'utf8');
const mainApp = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
const playback = fs.readFileSync(path.join(APP, 'playback.py'), 'utf8');
const lifecycle = fs.readFileSync(path.join(APP, 'performance_lifecycle.py'), 'utf8');
const windowFocus = fs.readFileSync(path.join(APP, 'window_focus.py'), 'utf8');

for (const token of [
  'PLAYER QUEUE',
  'Play all library',
  'Shuffle future',
  'Manual — stop after each song',
  'Ordered — advance in queue order',
  'Shuffle — choose a random next song',
  'piano_player_queue_v1',
  'transitionMs',
  'data-add-player-queue',
  'advanceAfterComplete',
  'sheet-workspace-queue',
  'window.PianoPlayerQueue',
  'piano:player-queue-ready',
  'addSongs',
  'clearQueue',
  'toggleQueue',
  'shuffleSelected',
  'playQueueId',
  'removeAllSongs',
  'reorderQueueId',
  'duplicateQueueIdAfter',
  'getSongEntries',
  'piano:preserve-playback-scroll',
  'Library song did not finish loading before playback',
  'waitForLibraryLoadButton',
  'refreshLibraryBtn',
]) assert(queue.includes(token), `queue contract missing: ${token}`);

for (const token of ['sheet-workspace-queue', 'player-queue-now', 'player-queue-item', '@media (max-width: 760px)']) {
  assert(css.includes(token), `queue CSS contract missing: ${token}`);
}

assert(queue.includes('if (!loaded) throw new Error'), 'queue must refuse playback when a requested library song never finishes loading');
assert(queue.includes('const loadButton = await waitForLibraryLoadButton(song.id)') && queue.includes('document.getElementById("refreshLibraryBtn")?.click()'), 'queue must self-repair a temporarily missing library Load control through the canonical fresh refresh');
assert(queue.includes('playButton.click();'), 'queue playback must enter through the same main Play control as manual playback');
assert(queue.includes('pauseButton.click();'), 'Play Queue must resume the stopped current song through the proven Resume control');
assert(queue.includes('emitUpdate();') && !queue.includes('list.append(empty); return;'), 'empty queue rendering must still notify every derived view');
assert(!workspace.includes('<details class="sheet-workspace-staging" open>'), 'Source Inbox must default collapsed');
assert(mainApp.includes('target_hwnd: Number(els.window.value) || 0') && mainApp.includes('auto_focus: els.inputMode.value === "foreground" && els.autoFocus.checked'), 'main Play payload must preserve selected target window and Auto Focus for queue playback');
assert(mainApp.includes('els.play.addEventListener("click", startPlayback)'), 'main Play control must remain bound to the proven playback path');
assert(playback.includes('if mode == "foreground" and options.auto_focus') && playback.includes('focus_window(options.target_window, target_hwnd)'), 'foreground playback must attempt the same target focus for manual and queued starts');
assert(bridge.includes("import('./player_queue.js')"), 'EveOS host bridge must load Player Queue');
assert(bridge.includes('piano:module-error') && bridge.includes('reportModuleFailure'), 'host bridge must surface dynamic module load failures');
assert(lifecycle.includes('controller._target_is_ready(options)'), 'lifecycle playback must use the real last-moment target interlock');
assert(lifecycle.includes('cursor -= len(due)'), 'lifecycle playback must retry, not drop, a batch interrupted by focus loss');
assert(!windowFocus.includes('OpenWindowStationW('), 'focus polling must not open a window-station handle');
assert(!windowFocus.includes('OpenDesktopW('), 'focus polling must not open a desktop handle');
assert(queue.split(/\r?\n/).length < 450, 'Player Queue controller exceeds the 450-line first-party cap');
verifyTimeline().then(() => console.log('PIANO_PLAYER_QUEUE_SMOKE_OK')).catch(error => { console.error(error); process.exitCode = 1; });

async function verifyTimeline() {
  const source = `data:text/javascript;base64,${Buffer.from(queueState).toString('base64')}#piano-queue-state`;
  const timeline = await import(source);
  const item = (queueId, songId = queueId) => ({ queueId, songId, label: queueId });
  assert(timeline.restoreQueueState().mode === 'ordered', 'a new Player Queue must advance automatically after Play Queue starts it');
  const jumped = timeline.restoreQueueState({ items: ['a', 'b', 'c', 'd', 'e'].map(id => item(id)), mode: 'ordered' });
  timeline.activateQueueId(jumped, 'c', { discardSkipped: true });
  assert(jumped.items.map(entry => entry.queueId).join(',') === 'c,d,e' && jumped.currentId === 'c', 'jumping to #3 must discard skipped pending entries without reordering the remainder');
  timeline.completeCurrent(jumped);
  assert(timeline.entryStatus(jumped, 0) === 'played' && timeline.entryStatus(jumped, 1) === 'next', 'completed entries must remain visible as history before the next song');
  timeline.activateNext(jumped);
  timeline.stepQueue(jumped, -1);
  assert(jumped.currentId === 'c', 'Previous must navigate back through queue history');

  const duplicates = timeline.restoreQueueState({ items: [item('a1', 'a'), item('a2', 'a'), item('b1', 'b')] });
  assert(timeline.entriesForSong(duplicates, 'a').length === 2, 'one song must support multiple independent queue entries');
  assert(timeline.removeLatestSongIds(duplicates, ['a']) === 1 && duplicates.items.map(entry => entry.queueId).join(',') === 'a1,b1', 'Remove from Queue must remove only the latest selected-song occurrence');
  assert(timeline.removeLatestSongIds(duplicates, ['a']) === 1 && duplicates.items.length === 1, 'repeated removal must peel duplicate queue entries one at a time');

  const removeAll = timeline.restoreQueueState({ items: [item('a1', 'a'), item('a2', 'a'), item('b1', 'b')] });
  assert(timeline.removeSongIds(removeAll, ['a']) === 2 && removeAll.items.map(entry => entry.queueId).join(',') === 'b1', 'Remove Entirely must clear every occurrence of each selected song');

  const reordered = timeline.restoreQueueState({ items: ['a', 'b', 'c', 'd'].map(id => item(id)), mode: 'manual' });
  assert(timeline.moveQueueIdTo(reordered, 'd', 'b', false) && reordered.items.map(entry => entry.queueId).join(',') === 'a,d,b,c', 'manual drag ordering must persist an exact before-target move');
  assert(timeline.moveQueueIdTo(reordered, 'a', 'c', true) && reordered.items.map(entry => entry.queueId).join(',') === 'd,b,c,a', 'manual drag ordering must persist an exact after-target move');

  const random = timeline.restoreQueueState({ items: ['a', 'b', 'c', 'd'].map(id => item(id)), mode: 'shuffle' });
  timeline.activateRandomNext(random, () => 0.99);
  assert(random.currentId === 'd' && random.items.slice(1).every((_, index) => timeline.entryStatus(random, index + 1) === 'candidate'), 'Shuffle mode must randomly choose from every unplayed candidate without publishing a fixed next song');
  timeline.completeCurrent(random); timeline.activateRandomNext(random, () => 0); timeline.stepQueue(random, -1); timeline.completeCurrent(random); timeline.activateRandomNext(random, () => 0);
  assert(random.currentId === 'c' && timeline.entriesForSong(random, 'b')[0].status === 'candidate', 'going back in Shuffle must return the song left behind to the unplayed pool while avoiding an immediate replay');

  const selected = timeline.restoreQueueState({ items: ['a', 'b', 'c', 'd'].map(id => item(id)) });
  timeline.activateQueueId(selected, 'a', { discardSkipped: false });
  timeline.shuffleSelected(selected, ['c'], () => 0);
  assert(selected.items.map(entry => entry.queueId).join(',') === 'a,c,b,d', 'Shuffle Queue must swap only selected future entries with random queue positions');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
