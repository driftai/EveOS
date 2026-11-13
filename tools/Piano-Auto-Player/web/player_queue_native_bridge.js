// Headless server-owned Piano queue handoff. Browser PCM keeps the legacy queue path.
// The EveOS server advances native songs while this document is minimized/suspended.
export function createNativeQueueBridge({ snapshot, reconcile, toast, wait }) {
  let armed = false, syncing = false, signature = '', checkedStartup = false;
  const host = () => window.PianoEveOS;
  const eligible = () => !!(document.getElementById('internalPlay')?.checked &&
    host()?.getContext?.()?.pianoNative?.preferred && host()?.getContext?.()?.pianoNative?.available);
  const value = (id, fallback) => Number(document.getElementById(id)?.value || fallback);
  const options = () => ({
    interval_ms: value('intervalRange', 115), note_hold_ms: value('holdRange', 18),
    speed: value('globalSpeedRange', 1), gate_percent: value('gateRange', 58),
    modifier_lead_ms: value('blackLeadRange', 6),
    chord_spread_ms: value('chordSpreadRange', 4),
    piano_layout: document.getElementById('pianoLayout')?.value || '61'
  });
  const entries = state => state.items.map(item => ({ queueId: item.queueId, songId: item.songId }));
  const pending = async () => {
    if (!eligible()) return null;
    try { return await host().native('attach'); } catch (_) { return null; }
  };
  async function arm(previousSession = '') {
    const state = snapshot();
    if (!eligible() || !state.active || !state.currentId) return false;
    let current = null;
    for (let n = 0; n < 100 && snapshot().active; n++) {
      current = await pending();
      if (current && ['rendering', 'playing', 'paused'].includes(current.state) &&
          (!previousSession || current.sessionId !== previousSession)) break;
      await wait(250);
    }
    if (!current || !['rendering', 'playing', 'paused'].includes(current.state) ||
        (previousSession && current.sessionId === previousSession) || !snapshot().active) return false;
    try {
      const fresh = snapshot();
      const receipt = await host().native('queueArm', {
        items: entries(fresh), currentQueueId: fresh.currentId,
        mode: fresh.mode, loop: !!fresh.loop, transitionMs: fresh.transitionMs,
        options: options(), volumePercent: 100
      });
      armed = !!receipt?.active;
      signature = '';
      return armed;
    } catch (error) {
      armed = false;
      toast(`Server-owned queue handoff unavailable: ${error.message}`, 'error');
      return false;
    }
  }
  async function stop() {
    if (!armed) return;
    armed = false;
    try { await host().native('queueStop'); } catch (_) { /* stop local playback too */ }
  }
  async function sync() {
    if (syncing || document.hidden || (!armed && checkedStartup)) return;
    checkedStartup = true; syncing = true;
    try {
      const receipt = await host().native('queueStatus');
      if (!receipt?.ok) return;
      armed = !!receipt.active;
      reconcile(receipt);
      // Audio ownership and presentation ownership differ: the worker advances
      // the native renderer, and the browser only projects its confirmed receipt.
      // The playingSongId is committed AFTER native.start, not when _choose moves
      // the cursor, so a transition delay cannot display the upcoming song early.
      const playingSongId = String(receipt.playingSongId || '');
      const current = receipt.currentStatus || {};
      if (playingSongId && current.sessionId &&
          ['rendering', 'playing', 'paused'].includes(String(current.state))) {
        window.dispatchEvent(new CustomEvent('piano:native-queue-track', {
          detail: { songId: playingSongId, sessionId: String(current.sessionId),
            status: current }
        }));
      }
    } catch (_) { /* server session survives temporary frontend disconnection */ }
    finally { syncing = false; }
  }
  function update() {
    if (!armed || syncing) return;
    const state = snapshot();
    const detail = { mode: state.mode, loop: !!state.loop, transitionMs: state.transitionMs,
      items: entries(state) };
    const key = JSON.stringify(detail);
    if (key === signature) return;
    signature = key;
    void host().native('queueUpdate', detail).catch(() => { signature = ''; });
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void sync(); });
  window.addEventListener('focus', () => { void sync(); });
  window.addEventListener('piano:eveos-context', () => { checkedStartup = false; void sync(); });
  void sync();
  // This timer is presentation-only. Native queue advancement NEVER uses it.
  setInterval(() => { if (!document.hidden) void sync(); }, 1250);
  return { arm, stop, sync, update, pending, active: () => armed };
}
