import { LocalPianoOutput } from "./piano.js";

const FOREGROUND_LOOKAHEAD_MS = 6000;
const LATE_AUDIO_SKIP_MS = 120;

export class InternalPreviewPlayer {
  constructor(pianoContainer, output = null) {
    this.output = output || new LocalPianoOutput(pianoContainer);
    this.releaseTimers = new Map();
    this.spanTimers = new Set();
    this.timer = 0;
    this.rows = [];
    this.total = 0;
    this.durationMs = 0;
    this.cursor = 0;
    this.audioCursor = 0;
    this.audioGeneration = 0;
    this.timelineBaseMs = 0;
    this.clockStartedAt = 0;
    this.pausedTimelineMs = 0;
    this.countdownDeadline = 0;
    this.state = "idle";
    this.message = "Ready for internal preview";
    this.currentIndex = 0;
    this.currentToken = "";
    this.resumeIndex = 0;
    this._backgroundSchedule = () => {
      if (this.state === "countdown") this._beginPlaying();
      this._scheduleAudio(true);
    };
    window.addEventListener("blur", this._backgroundSchedule);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this._backgroundSchedule();
    });
  }

  unlock() { return this.output.unlock(); }
  setSound(soundId) { this.output.setSound(soundId); this._rescheduleAudio(); }
  async prepareSound() { const ready = await this.output.prepareSound(); this._rescheduleAudio(); return ready; }
  soundLabel() { return this.output.soundLabel(); }

  status() {
    return {
      status: this.state,
      message: this.message,
      current_index: this.currentIndex,
      total_events: this.total,
      current_token: this.currentToken,
      resume_index: this.resumeIndex,
      internal_preview: true,
    };
  }

  start(timeline, startEvent = 1, countdownSeconds = 0) {
    this._clearTimers();
    this.output.allOff();
    this.rows = Array.isArray(timeline?.events) ? timeline.events : [];
    if (!this.rows.length) throw new Error("The preview timeline has no playable events.");
    this.total = Number(timeline.total_events || this.rows.length);
    this.durationMs = Number(timeline.duration_ms || 0);
    this.cursor = this._indexForEvent(startEvent);
    this.audioCursor = this.cursor;
    this.audioGeneration += 1;
    this.currentIndex = this.cursor + 1;
    this.currentToken = "";
    this.resumeIndex = 0;
    const countdownMs = Math.max(0, Number(countdownSeconds || 0) * 1000);
    if (countdownMs > 0 && !this._isBackgrounded()) {
      this.state = "countdown";
      this.countdownDeadline = performance.now() + countdownMs;
      this._countdownTick();
    } else {
      this._beginPlaying();
    }
  }

  togglePause() {
    if (this.state === "paused") {
      this.state = "playing";
      this.message = "Internal preview — built-in piano";
      this.timelineBaseMs = this.pausedTimelineMs;
      this.clockStartedAt = performance.now();
      this.audioCursor = this.cursor;
      this.audioGeneration += 1;
      this._scheduleNext();
      return false;
    }
    if (this.state !== "playing") return false;
    this.pausedTimelineMs = this._timelineNow();
    this._clearMainTimer();
    this._clearSpanTimers();
    this._clearReleaseTimers();
    this.output.allOff();
    this.state = "paused";
    this.message = "Internal preview paused";
    return true;
  }

  seek(eventIndex) {
    if (!this.rows.length) return 0;
    const index = this._indexForEvent(eventIndex);
    const row = this.rows[index];
    this.cursor = index;
    this.audioCursor = index;
    this.audioGeneration += 1;
    this.currentIndex = index + 1;
    this.currentToken = "";
    this._clearMainTimer();
    this._clearSpanTimers();
    this._clearReleaseTimers();
    this.output.allOff();
    if (this.state === "playing") {
      this.timelineBaseMs = Number(row.at_ms || 0);
      this.clockStartedAt = performance.now();
      this.message = `Internal preview · seeked to event ${this.currentIndex}`;
      this._scheduleNext();
    } else if (this.state === "paused") {
      this.pausedTimelineMs = Number(row.at_ms || 0);
      this.message = `Internal preview paused · event ${this.currentIndex}`;
    }
    return this.currentIndex;
  }

  stop() {
    const active = ["countdown", "playing", "paused"].includes(this.state);
    const resume = active ? Math.max(1, this.currentIndex || this.cursor + 1) : 0;
    this._clearTimers();
    this.output.allOff();
    this.state = "idle";
    this.currentIndex = 0;
    this.currentToken = "";
    this.resumeIndex = resume;
    this.message = resume ? `Internal preview stopped · Resume available at event ${resume}` : "Internal preview stopped";
    return { ok: true, resume_event: resume };
  }

  reset() {
    this._clearTimers();
    this.output.allOff();
    this.rows = [];
    this.total = 0;
    this.durationMs = 0;
    this.cursor = 0;
    this.audioCursor = 0;
    this.audioGeneration += 1;
    this.state = "idle";
    this.message = "Ready for internal preview";
    this.currentIndex = 0;
    this.currentToken = "";
    this.resumeIndex = 0;
  }

  _beginPlaying() {
    this._clearMainTimer();
    const row = this.rows[this.cursor];
    this.state = "playing";
    this.message = "Internal preview — built-in piano";
    this.timelineBaseMs = Number(row?.at_ms || 0);
    this.clockStartedAt = performance.now();
    this.pausedTimelineMs = this.timelineBaseMs;
    this.audioCursor = this.cursor;
    this.audioGeneration += 1;
    this._scheduleNext();
  }

  _countdownTick() {
    if (this.state !== "countdown") return;
    const remaining = Math.max(0, this.countdownDeadline - performance.now());
    if (remaining <= 0) return this._beginPlaying();
    this.message = `Internal preview starts in ${(remaining / 1000).toFixed(1)}s…`;
    this.timer = window.setTimeout(() => this._countdownTick(), Math.min(50, remaining));
  }

  _scheduleNext() {
    if (this.state !== "playing") return;
    this._scheduleAudio(this._isBackgrounded());
    if (this.cursor >= this.rows.length) {
      const remaining = Math.max(0, this.durationMs - this._timelineNow());
      this.timer = window.setTimeout(() => this._finish(), remaining);
      return;
    }
    const row = this.rows[this.cursor];
    const delay = Math.max(0, Number(row.at_ms || 0) - this._timelineNow());
    this.timer = window.setTimeout(() => this._fireDue(), delay);
  }

  _fireDue() {
    if (this.state !== "playing") return;
    const timelineNow = this._timelineNow();
    while (this.cursor < this.rows.length) {
      const row = this.rows[this.cursor];
      if (Number(row.at_ms || 0) - timelineNow > 2) break;
      this.currentIndex = Number(row.event_index || this.cursor + 1);
      this.currentToken = String(row.token || row.key || "");
      const lateness = timelineNow - Number(row.at_ms || 0);
      if (lateness <= 100) {
        if (Array.isArray(row.note_spans) && row.note_spans.length) this._soundSpans(row.note_spans);
        else if (Array.isArray(row.midi_notes) && row.midi_notes.length) this._soundMidi(row.midi_notes, Number(row.duration_ms || 18));
        else if (row.key) this._sound(row.key, Number(row.duration_ms || 18));
      }
      this.cursor += 1;
    }
    this._scheduleNext();
  }

  _sound(token, durationMs) {
    for (const key of String(token)) {
      const previous = this.releaseTimers.get(key);
      if (previous) { window.clearTimeout(previous); this.output.unhighlightToken(key); }
      this.output.highlightToken(key);
      const timer = window.setTimeout(() => {
        this.output.unhighlightToken(key);
        if (this.releaseTimers.get(key) === timer) this.releaseTimers.delete(key);
      }, Math.max(2, durationMs));
      this.releaseTimers.set(key, timer);
    }
  }

  _soundSpans(spans) {
    for (const span of spans) {
      const midi = Number(span?.midi);
      if (!Number.isFinite(midi)) continue;
      const offsetMs = Math.max(0, Number(span?.offset_ms || 0));
      const durationMs = Math.max(2, Number(span?.duration_ms || 18));
      const start = () => {
        if (this.state !== "playing") return;
        this._soundMidi([midi], durationMs);
      };
      if (offsetMs <= 2) start();
      else {
        const timer = window.setTimeout(() => { this.spanTimers.delete(timer); start(); }, offsetMs);
        this.spanTimers.add(timer);
      }
    }
  }

  _soundMidi(notes, durationMs) {
    for (const midi of notes) {
      const id = `midi:${midi}`;
      const previous = this.releaseTimers.get(id);
      if (previous) { window.clearTimeout(previous); this.output.unhighlightMidi(midi); }
      this.output.highlightMidi(midi);
      const timer = window.setTimeout(() => {
        this.output.unhighlightMidi(midi);
        if (this.releaseTimers.get(id) === timer) this.releaseTimers.delete(id);
      }, Math.max(2, durationMs));
      this.releaseTimers.set(id, timer);
    }
  }

  _isBackgrounded() { return document.hidden || !document.hasFocus(); }

  _rescheduleAudio() {
    if (this.state !== "playing") return;
    this.output.allOff();
    this.audioCursor = this.cursor;
    this.audioGeneration += 1;
    this._scheduleAudio(this._isBackgrounded());
  }

  _scheduleAudio(allRemaining = false) {
    if (this.state !== "playing" || !this.rows.length) return;
    const timelineNow = this._timelineNow();
    const horizon = allRemaining ? Infinity : timelineNow + FOREGROUND_LOOKAHEAD_MS;
    const audioNow = this.output.audioTime();
    while (this.audioCursor < this.rows.length) {
      const index = this.audioCursor;
      const row = this.rows[index];
      const rowAt = Number(row.at_ms || 0);
      if (rowAt > horizon) break;
      this.audioCursor += 1;
      if (rowAt < timelineNow - LATE_AUDIO_SKIP_MS) continue;
      this._scheduleRowAudio(row, index, audioNow, timelineNow);
    }
  }

  _scheduleRowAudio(row, index, audioNow, timelineNow) {
    const baseAt = Number(row.at_ms || 0);
    const generation = this.audioGeneration;
    const schedule = (midi, offsetMs, durationMs, suffix) => {
      const startAt = audioNow + Math.max(0, baseAt + offsetMs - timelineNow) / 1000;
      const id = `preview:${generation}:${index}:${suffix}`;
      this.output.scheduleMidi(midi, id, startAt, Math.max(2, durationMs) / 1000);
    };
    if (Array.isArray(row.note_spans) && row.note_spans.length) {
      row.note_spans.forEach((span, noteIndex) => {
        const midi = Number(span?.midi);
        if (Number.isFinite(midi)) schedule(midi, Math.max(0, Number(span?.offset_ms || 0)), Number(span?.duration_ms || 18), noteIndex);
      });
      return;
    }
    if (Array.isArray(row.midi_notes) && row.midi_notes.length) {
      row.midi_notes.forEach((midi, noteIndex) => schedule(Number(midi), 0, Number(row.duration_ms || 18), noteIndex));
      return;
    }
    [...String(row.key || "")].forEach((token, noteIndex) => {
      const startAt = audioNow + Math.max(0, baseAt - timelineNow) / 1000;
      this.output.scheduleToken(token, `preview:${generation}:${index}:token:${noteIndex}`, startAt, Math.max(2, Number(row.duration_ms || 18)) / 1000);
    });
  }

  _timelineNow() {
    if (this.state === "paused") return this.pausedTimelineMs;
    return this.timelineBaseMs + Math.max(0, performance.now() - this.clockStartedAt);
  }

  _finish() {
    if (this.state !== "playing") return;
    this._clearTimers();
    this.output.allOff();
    this.cursor = this.rows.length;
    this.currentIndex = this.total;
    this.currentToken = "";
    this.resumeIndex = 0;
    this.state = "complete";
    this.message = "Internal preview finished";
  }

  _indexForEvent(eventIndex) {
    return Math.max(0, Math.min(Math.round(Number(eventIndex) || 1) - 1, Math.max(0, this.rows.length - 1)));
  }

  _clearMainTimer() {
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = 0;
  }

  _clearSpanTimers() {
    for (const timer of this.spanTimers) window.clearTimeout(timer);
    this.spanTimers.clear();
  }

  _clearReleaseTimers() {
    for (const timer of this.releaseTimers.values()) window.clearTimeout(timer);
    this.releaseTimers.clear();
  }

  _clearTimers() {
    this._clearMainTimer();
    this._clearSpanTimers();
    this._clearReleaseTimers();
  }
}
