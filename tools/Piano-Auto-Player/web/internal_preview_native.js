// Server-owned Internal Play adapter: the native renderer, not this iframe, owns audio.
// Recommended server-owned default; Browser PCM remains an explicit compatibility option.
import { pianoMasterVolume } from './piano_sound.js';

export class ServerOwnedPreview {
  constructor(preview) {
    this.preview = preview;
    this.active = false;
    this.receipt = null;
    this.generation = 0;
    this.timeline = null;
    this.originIndex = 0;
    this.polling = false;
    this.inFlight = false;
    this.message = '';
    this.available = false;
    this.hostPreferred = undefined;
    this.pendingHostPreference = null;
    this.queuedSessionId = "";
    this.control = null;
    this.enginePicker = null;
    this.installControl();
    window.addEventListener('piano:eveos-context', () => this.refreshAvailability());
    this.refreshAvailability();
    // A reload may attach to an independently playing server session.
    void this.reattach();
  }

  host() { return window.PianoEveOS?.native; }
  refreshAvailability() {
    const native = window.PianoEveOS?.getContext?.()?.pianoNative;
    const next = Boolean(this.host() && native?.available);
    // Only apply a host preference when it changes. If the parent sent it before
    // readiness, keep it pending; do not overwrite later manual checkbox changes.
    if (typeof native?.preferred === 'boolean' && native.preferred !== this.hostPreferred) {
      this.hostPreferred = native.preferred;
      this.pendingHostPreference = native.preferred;
    }
    // Preference must remain explicit even when the native device is offline:
    // otherwise Browser PCM could silently start from a native selection.
    if (this.pendingHostPreference !== null && !this.active && this.control) {
      this.control.checked = this.pendingHostPreference;
      if (this.control.checked) {
        const internal = document.getElementById('internalPlay');
        if (internal) internal.checked = true;
      }
      this.pendingHostPreference = null;
    }
    if (next && !this.available) void this.reattach();
    this.available = next;
    if (this.control) {
      this.control.disabled = !next;
      this.control.title = next ? 'Native playback continues when the browser is minimized or closed using the selected AudioFlix output.'
        : 'Choose a verified native output in AudioFlix from file:// or localhost EveOS.';
      this.syncPicker();
    }
  }
  installControl() {
    const internal = document.getElementById('internalPlay');
    if (!internal?.parentElement) return;
    const existing = document.getElementById('serverOwnedPiano');
    if (existing) {
      this.control = existing;
      this.enginePicker = document.querySelector('.piano-engine-dialog');
      this.engineTrigger = document.querySelector('[data-piano-engine-open]');
      this.bindControl(existing); this.syncPicker(); return;
    }
    const label = internal.parentElement;
    const shell = document.createElement('span'); shell.className = 'piano-internal-engine-shell';
    label.before(shell); shell.append(label);
    const gear = document.createElement('button'); gear.type = 'button';
    gear.className = 'piano-engine-gear'; gear.dataset.pianoEngineOpen = '';
    gear.setAttribute('aria-label', 'Internal Play engine settings');
    gear.setAttribute('title', 'Choose the Internal Play audio engine');
    gear.innerHTML = '<span aria-hidden="true">⚙</span>';
    shell.append(gear);
    const dialog = document.createElement('dialog'); dialog.className = 'piano-engine-dialog';
    dialog.setAttribute('aria-label', 'Internal Play engine settings');
    dialog.innerHTML = `<form method="dialog" class="piano-engine-modal-content">
      <header><div><small>INTERNAL PLAY</small><h3>Choose playback engine</h3></div><button type="submit" class="piano-engine-close" aria-label="Close engine settings">×</button></header>
      <fieldset class="piano-engine-options"><legend>Audio generation</legend>
        <label><input type="radio" name="piano-native-engine" value="server" checked><span><strong>Server-owned output · Recommended</strong><small>Renders notes on the EveOS server. Plays smoothly when you minimize or close the browser. Uses the device selected under AudioFlix → Audio Output / Voice Port.</small></span></label>
        <label><input type="radio" name="piano-native-engine" value="browser"><span><strong>Browser PCM · Compatibility</strong><small>Generates notes in your browser and streams PCM to the same selected output. Background throttling can make it choppy when minimized.</small></span></label>
      </fieldset><p class="piano-engine-selected" data-engine-selected></p><p class="piano-engine-note" data-engine-note role="status"></p>
      <footer><button type="submit">Done</button></footer></form>`;
    document.body.append(dialog);
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
    checkbox.id = 'serverOwnedPiano'; checkbox.hidden = true; checkbox.checked = false;
    shell.append(checkbox);
    this.control = checkbox; this.enginePicker = dialog; this.engineTrigger = gear;
    const styleId = 'piano-engine-picker-style';
    let style = document.getElementById(styleId);
    if (!style) { style = document.createElement('style'); style.id = styleId; document.head.append(style); }
    style.textContent = `.piano-internal-engine-shell{display:inline-flex;align-items:stretch;border:1px solid #39859b;border-radius:9px;background:#102e38;margin:0 3px;overflow:hidden;vertical-align:middle}
      .piano-internal-engine-shell>.check{margin:0;border:0;border-radius:0;padding:7px 7px 7px 11px}
      .piano-internal-engine-shell>.piano-engine-gear{display:grid;place-items:center;min-width:32px;min-height:32px;padding:4px 9px;margin:0;border:0;border-left:1px solid #39859b;border-radius:0;background:#17414c;color:#b7eff0;cursor:pointer;font:600 16px system-ui}
      .piano-internal-engine-shell>.piano-engine-gear:hover,.piano-internal-engine-shell>.piano-engine-gear:focus-visible{background:#235868;outline:2px solid #78d9eb;outline-offset:-3px}
      .piano-engine-dialog{width:min(540px,calc(100vw - 32px));max-height:min(82dvh,700px);overflow:auto;border:1px solid #408a98;border-radius:16px;background:#0a2027;color:#dff7f7;padding:0;box-shadow:0 22px 70px #000b;position:fixed}
      .piano-engine-dialog::backdrop{background:rgba(0,7,12,.7);backdrop-filter:blur(3px)}
      .piano-engine-modal-content{display:grid;gap:14px;padding:18px;font:12px system-ui}
      .piano-engine-modal-content header{display:flex;justify-content:space-between;align-items:start;gap:12px}
      .piano-engine-modal-content header small{letter-spacing:.12em;color:#78d8e6;font-weight:800}
      .piano-engine-modal-content h3{margin:4px 0 0;font-size:21px;color:#e9fbfc}
      .piano-engine-close{font-size:24px;min-width:36px;min-height:36px}
      .piano-engine-options{display:grid;gap:9px;margin:0;border:1px solid #31535a;border-radius:11px;padding:12px}
      .piano-engine-options legend{color:#7fe4e9;font-size:11px;font-weight:750}
      .piano-engine-options label{display:flex;align-items:start;gap:10px;border:1px solid #36535a;border-radius:9px;padding:12px;background:#102a30;cursor:pointer}
      .piano-engine-options label:has(input:checked){border-color:#54d7ae;background:#103b35}
      .piano-engine-options label input{margin-top:3px;accent-color:#61dcc5}
      .piano-engine-options label span{display:grid;gap:6px}
      .piano-engine-options strong{color:#daf7f5;font-size:12px}
      .piano-engine-options small{color:#b3cbd0;line-height:1.55;font-size:11px}
      .piano-engine-options label:has(input:disabled){opacity:.64}
      .piano-engine-selected{margin:0;color:#79e3c2;font-weight:700}
      .piano-engine-note{margin:0;color:#a6c5cb;line-height:1.5}
      .piano-engine-modal-content footer{display:flex;justify-content:flex-end}
      .piano-engine-modal-content button{border:1px solid #396a77;border-radius:8px;background:#113a45;color:#e1fbfa;padding:6px 12px;cursor:pointer}`;
    gear.addEventListener('click', event => { event.preventDefault(); dialog.showModal(); this.syncPicker(); });
    dialog.addEventListener('change', event => {
      const value = event.target?.value;
      if (value !== 'server' && value !== 'browser') return;
      if (this.active && value === 'browser') { this.message = 'Stop playback before changing engines.'; this.syncPicker(); return; }
      checkbox.checked = value === 'server';
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    });
    this.bindControl(checkbox); this.syncPicker();
  }
  syncPicker() {
    const picker = this.enginePicker;
    if (!picker || !this.control) return;
    const wanted = this.control.checked ? 'server' : 'browser';
    picker.querySelectorAll('input[type="radio"]').forEach(radio => {
      radio.checked = radio.value === wanted;
      radio.disabled = (radio.value === 'server' && !this.available) || (radio.value === 'browser' && this.active);
    });
    const chosen = picker.querySelector('[data-engine-selected]');
    const route = window.PianoEveOS?.getContext?.()?.outputRoute || 'the AudioFlix-selected output';
    if (chosen) chosen.textContent = `${this.active ? 'Playing' : 'Selected'}: ${wanted === 'server' ? 'Server-owned output' : 'Browser PCM'} · ${route}`;
    const note = picker.querySelector('[data-engine-note]');
    if (note) note.textContent = this.active ? 'Stop the current song before changing engines.'
      : wanted === 'server' && !this.available ? 'Waiting for the verified native output route. Browser PCM will not silently replace the selected engine.'
      : 'Engine changes take effect when the next song starts.';
    this.engineTrigger?.setAttribute('aria-label', `Internal Play engine settings (${wanted === 'server' ? 'server-owned' : 'browser PCM'})`);
  }
  bindControl(checkbox) {
    checkbox.addEventListener('change', () => {
      this.pendingHostPreference = null;
      if (!checkbox.checked && this.active) {
        checkbox.checked = true;
        this.message = 'Stop the native session before switching to browser PCM.';
      }
      if (checkbox.checked) {
        const internal = document.getElementById('internalPlay');
        if (internal) internal.checked = true;
      }
      this.syncPicker();
      // UI preference is non-sensitive; never send native session tokens to a
      // potentially unrelated ancestor window. EveOS authenticates the iframe
      // source + origin before accepting this settings-only message.
      const host = window.parent && window.parent !== window ? window.parent : window.opener;
      if (host && window.PianoEveOS?.getContext?.()?.pianoNative)
        host.postMessage({ type: 'piano:eveos-engine-choice', nativePreferred: checkbox.checked }, '*');
    });
  }
  enabled() { return Boolean(this.control?.checked); }
  snapshot() {
    const entry = this.receipt || {};
    const state = String(entry.state || 'rendering');
    const current = Math.max(0, Number(entry.currentTime || 0));
    const rows = this.timeline?.events || this.preview.rows || [];
    const ownedByQueue = !!entry.sessionId && this.queuedSessionId === entry.sessionId;
    const serverIndex = Math.max(0, Number(entry.currentIndex || 0));
    const eventAt = Number(rows[this.originIndex]?.at_ms || 0) + current * 1000;
    let i = this.originIndex;
    while (i + 1 < rows.length && Number(rows[i + 1].at_ms || 0) <= eventAt) i++;
    return {
      status: state, message: entry.message || this.message || 'Preparing native Piano…',
      current_index: ownedByQueue ? serverIndex : rows.length ? Math.min(rows.length, i + 1) : serverIndex,
      total_events: ownedByQueue ? Number(entry.totalEvents || 0) : rows.length || Number(entry.totalEvents || 0),
      current_token: ownedByQueue ? (rows[Math.max(0, serverIndex - 1)]?.token || rows[Math.max(0, serverIndex - 1)]?.key || '') : (rows[i]?.token || rows[i]?.key || ''),
      resume_index: state === 'stopped' ? Math.max(1, i + 1) : 0,
      internal_preview: true, server_owned: true,
      current_time: current, duration_seconds: Number(entry.duration || 0),
    };
  }
  adoptQueuedSession(receipt, timeline = null) {
    // Projection only: do not call start, reset, or stop on the live native audio.
    const sessionId = String(receipt?.sessionId || '');
    if (!sessionId) return false;
    const isNew = this.queuedSessionId !== sessionId;
    if (isNew) {
      this.queuedSessionId = sessionId;
      this.timeline = { events: [] }; // discard previous-song event timing
      this.originIndex = 0;
    }
    if (timeline?.events && this.queuedSessionId === sessionId) this.timeline = timeline;
    this.receipt = receipt;
    this.active = ['rendering', 'playing', 'paused'].includes(String(receipt.state));
    this.syncPicker();
    if (this.active && !this.polling) this.poll();
    return true;
  }
  async request(action, payload = {}) {
    const fn = this.host();
    if (!fn) throw new Error('Piano native host has not connected.');
    return fn(action, payload);
  }
  async reattach() {
    if (!this.host()) return;
    try {
      const status = await this.request('attach');
      if (status && ['rendering', 'playing', 'paused'].includes(status.state)) {
        this.active = true; this.receipt = status;
        this.control && (this.control.checked = true);
        this.syncPicker(); this.poll();
      }
    } catch (_) { /* no previous owner; do not seize another session */ }
  }
  start(timeline, startEvent = 1) {
    if (this.active || this.inFlight) return false;
    if (!this.available) { this.message = 'Native Piano unavailable; use the browser PCM option.'; return false; }
    this.timeline = timeline;
    const rows = Array.isArray(timeline?.events) ? timeline.events : [];
    if (!rows.length) throw new Error('The Piano timeline is empty.');
    this.originIndex = Math.max(0, Math.min(rows.length - 1, Math.round(Number(startEvent || 1)) - 1));
    const startAt = Number(rows[this.originIndex].at_ms || 0);
    const adjusted = rows.slice(this.originIndex).map(row => ({ ...row, at_ms: Math.max(0, Number(row.at_ms || 0) - startAt) }));
    this.active = true; this.inFlight = true;
    this.syncPicker();
    this.receipt = { state: 'rendering', totalEvents: adjusted.length, currentTime: 0,
      message: 'Preparing server-owned Piano on the selected AudioFlix output…' };
    this.generation += 1;
    void this.request('start', {
      timeline: { events: adjusted, total_events: adjusted.length,
        duration_ms: Math.max(0, Number(timeline.duration_ms || 0) - startAt) },
      soundId: this.preview.output.sound?.soundId || 'acoustic_grand',
      volumePercent: pianoMasterVolume(), sampleRate: 48000,
    }).then(receipt => {
      if (!this.active) return this.request('stop').catch(() => {});
      this.receipt = receipt; this.message = receipt.message || ''; this.poll();
    }).catch(error => {
      this.active = false;
      this.receipt = { state: 'error', message: String(error?.message || error) };
      this.message = this.receipt.message; this.syncPicker();
      // Do not silently switch a failed native start onto browser speakers.
    }).finally(() => { this.inFlight = false; });
    return true;
  }
  poll() {
    if (!this.active || this.polling) return;
    this.polling = true;
    void this.request('status').then(status => { this.receipt = status;
      if (['complete', 'stopped', 'error'].includes(status.state)) {
        this.active = false; this.syncPicker();
        return;
      }
    }).catch(error => { this.message = String(error?.message || error); })
      .finally(() => { this.polling = false;
        if (this.active) setTimeout(() => this.poll(), document.hidden ? 1800 : 350);
      });
  }
  togglePause() {
    if (!this.active || this.inFlight) return false;
    const paused = this.receipt?.state !== 'paused';
    this.inFlight = true;
    void this.request('pause', { paused }).then(r => { this.receipt = r; })
      .catch(e => { this.message = String(e?.message || e); })
      .finally(() => { this.inFlight = false; });
    return paused;
  }
  seek(eventIndex) {
    const rows = this.timeline?.events || [];
    if (!this.active || !rows.length || this.inFlight) return Number(eventIndex) || 1;
    const index = Math.max(this.originIndex, Math.min(rows.length - 1, Number(eventIndex || 1) - 1));
    const start = Number(rows[this.originIndex]?.at_ms || 0);
    const seconds = Math.max(0, (Number(rows[index].at_ms || 0) - start) / 1000);
    this.inFlight = true;
    void this.request('seek', { seconds }).then(r => { this.receipt = r; })
      .catch(e => { this.message = String(e?.message || e); })
      .finally(() => { this.inFlight = false; });
    return index + 1;
  }
  stop() {
    const resume = Number(this.snapshot().current_index || 0);
    this.active = false; this.generation += 1;
    this.syncPicker();
    this.receipt = { ...this.receipt, state: "stopped", message: "Server-owned Piano stopped." };
    if (this.receipt?.state !== 'error') {
      void this.request('stop').then(r => { this.receipt = r; })
        .catch(e => { this.message = String(e?.message || e); });
    }
    return { ok: true, resume_event: resume };
  }
}
