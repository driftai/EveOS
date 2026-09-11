const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const TOOL = path.join(ROOT, 'tools', 'Piano-Auto-Player');
const WEB = path.join(TOOL, 'web');
const APP = path.join(TOOL, 'app');
const queue = fs.readFileSync(path.join(WEB, 'player_queue.js'), 'utf8');
const css = fs.readFileSync(path.join(WEB, 'player_queue.css'), 'utf8');
const bridge = fs.readFileSync(path.join(WEB, 'eveos-host-bridge.js'), 'utf8');
const mainApp = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
const playback = fs.readFileSync(path.join(APP, 'playback.py'), 'utf8');
const lifecycle = fs.readFileSync(path.join(APP, 'performance_lifecycle.py'), 'utf8');
const windowFocus = fs.readFileSync(path.join(APP, 'window_focus.py'), 'utf8');

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
  'window.PianoPlayerQueue',
  'piano:player-queue-ready',
  'addSongs',
  'clearQueue',
  'Library song did not finish loading before playback',
]) assert(queue.includes(token), `queue contract missing: ${token}`);

for (const token of ['sheet-workspace-queue', 'player-queue-now', 'player-queue-item', '@media (max-width: 760px)']) {
  assert(css.includes(token), `queue CSS contract missing: ${token}`);
}

assert(queue.includes('if (!loaded) throw new Error'), 'queue must refuse playback when a requested library song never finishes loading');
assert(queue.includes('playButton.click();'), 'queue playback must enter through the same main Play control as manual playback');
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
console.log('PIANO_PLAYER_QUEUE_SMOKE_OK');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
