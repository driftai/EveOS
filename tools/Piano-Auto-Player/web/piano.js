import { PianoSoundEngine } from "./piano_sound.js";

const WHITE = "1234567890qwertyuiopasdfghjklzxcvbnm";
const BLACK = "!@$%^*(QWETYIOPSDGHJLZCVB";
const BLACK_AFTER = new Set([0, 1, 3, 4, 5]);
const CTRL_RANGE_KEYS = "1234567890qwertyuiopasdfghj";
const STANDARD_MIN = 36;
const STANDARD_MAX = 96;
const FULL_MIN = 21;
const FULL_MAX = 108;
const BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);

function buildTokenMidi() {
  const map = new Map();
  let whiteIndex = 0;
  let blackIndex = 0;
  for (let octave = 0; octave < 5; octave++) {
    const base = STANDARD_MIN + octave * 12;
    const naturals = [0, 2, 4, 5, 7, 9, 11];
    for (let i = 0; i < naturals.length; i++) {
      map.set(WHITE[whiteIndex++], base + naturals[i]);
      if (BLACK_AFTER.has(i)) map.set(BLACK[blackIndex++], base + naturals[i] + 1);
    }
  }
  map.set(WHITE[whiteIndex], STANDARD_MAX);
  return map;
}

const TOKEN_MIDI = buildTokenMidi();
const MIDI_TOKEN = new Map([...TOKEN_MIDI].map(([token, midi]) => [midi, token]));
export const SUPPORTED_KEYS = new Set([...TOKEN_MIDI.keys()]);

function normalizeLayout(value) { return String(value || "61") === "88" ? "88" : "61"; }
function isBlack(midi) { return BLACK_PITCH_CLASSES.has(((Number(midi) % 12) + 12) % 12); }

function foldStandardMidi(midi) {
  let value = Number(midi);
  while (value < STANDARD_MIN) value += 12;
  while (value > STANDARD_MAX) value -= 12;
  return value;
}

function tokenForMidi(midi) { return MIDI_TOKEN.get(Number(midi)) || ""; }
function fallbackTokenForMidi(midi) { return tokenForMidi(foldStandardMidi(midi)); }

function ctrlMidiForKey(key) {
  const index = CTRL_RANGE_KEYS.indexOf(String(key || "").toLowerCase());
  if (index < 0) return null;
  return index < 15 ? FULL_MIN + index : STANDARD_MAX + 1 + (index - 15);
}

function shortcutForMidi(midi, layout) {
  if (midi >= STANDARD_MIN && midi <= STANDARD_MAX) return tokenForMidi(midi);
  if (normalizeLayout(layout) !== "88") return fallbackTokenForMidi(midi);
  if (midi >= FULL_MIN && midi < STANDARD_MIN) return `Ctrl+${CTRL_RANGE_KEYS[midi - FULL_MIN]}`;
  if (midi > STANDARD_MAX && midi <= FULL_MAX) return `Ctrl+${CTRL_RANGE_KEYS[15 + midi - STANDARD_MAX - 1]}`;
  return "";
}

function midiRange(layout) { return normalizeLayout(layout) === "88" ? [FULL_MIN, FULL_MAX] : [STANDARD_MIN, STANDARD_MAX]; }

function pianoKey(container, midi) { return container.querySelector(`[data-midi="${Number(midi)}"]`); }
function setKeyState(container, midi, className, pressed) {
  const key = pianoKey(container, midi);
  if (!key) return;
  key.classList.toggle(className, pressed);
  key.setAttribute("aria-pressed", pressed ? "true" : "false");
}

export class LocalPianoOutput {
  constructor(container, sound = new PianoSoundEngine()) {
    this.container = container;
    this.sound = sound;
  }

  unlock() { return this.sound.unlock(); }
  setSound(soundId) { this.sound.setSound(soundId); }
  prepareSound() { return this.sound.prepare(); }
  soundLabel() { return this.sound.label(); }

  down(token) {
    const midi = TOKEN_MIDI.get(token);
    if (midi === undefined) return;
    this.downMidi(midi, `token:${token}`);
  }

  up(token) {
    const midi = TOKEN_MIDI.get(token);
    if (midi === undefined) return;
    this.upMidi(midi, `token:${token}`);
  }

  downMidi(midi, id = `midi:${midi}`) {
    this.sound.downMidi(Number(midi), id);
    setKeyState(this.container, midi, "preview-active", true);
  }

  upMidi(midi, id = `midi:${midi}`) {
    this.sound.upMidi(id);
    setKeyState(this.container, midi, "preview-active", false);
  }

  downToken(token = "") { for (const key of String(token)) this.down(key); }
  upToken(token = "") { for (const key of String(token)) this.up(key); }

  allOff() {
    this.sound.allOff();
    this.container.querySelectorAll(".preview-active").forEach(key => {
      key.classList.remove("preview-active");
      key.setAttribute("aria-pressed", "false");
    });
  }
}

export class PerformanceRecorder {
  constructor(onChange = () => {}, sound = new PianoSoundEngine()) {
    this.onChange = onChange;
    this.sound = sound;
    this.recording = false;
    this.startedAt = 0;
    this.events = [];
    this.downTimes = new Map();
  }

  setSound(soundId) { this.sound.setSound(soundId); }
  prepareSound() { return this.sound.prepare(); }
  unlock() { this.sound.ensure(); }

  start() {
    this.events = [];
    this.downTimes.clear();
    this.startedAt = performance.now();
    this.recording = true;
    this.onChange(this.snapshot());
  }

  stop() {
    const now = performance.now();
    for (const midi of [...this.downTimes.keys()]) this.noteUpMidi(midi, now);
    this.recording = false;
    this.onChange(this.snapshot());
    return this.snapshot();
  }

  clear() {
    this.recording = false;
    this.events = [];
    this.downTimes.clear();
    this.sound.allOff();
    this.onChange(this.snapshot());
  }

  load(events = []) {
    this.recording = false;
    this.events = Array.isArray(events) ? events.map(event => ({ ...event })) : [];
    this.downTimes.clear();
    this.onChange(this.snapshot());
  }

  noteDown(token, now = performance.now()) {
    const midi = TOKEN_MIDI.get(token);
    if (midi === undefined) return;
    this.noteDownMidi(midi, now);
  }

  noteUp(token, now = performance.now()) {
    const midi = TOKEN_MIDI.get(token);
    if (midi === undefined) return;
    this.noteUpMidi(midi, now);
  }

  noteDownMidi(midi, now = performance.now()) {
    const note = Number(midi);
    if (!Number.isFinite(note) || this.downTimes.has(note)) return;
    this.sound.downMidi(note, `record:${note}`);
    if (this.recording) this.downTimes.set(note, now);
    this.onChange(this.snapshot());
  }

  noteUpMidi(midi, now = performance.now()) {
    const note = Number(midi);
    this.sound.upMidi(`record:${note}`);
    const down = this.downTimes.get(note);
    if (down === undefined) return;
    this.downTimes.delete(note);
    this.events.push({
      key: fallbackTokenForMidi(note),
      midi_notes: [note],
      at_ms: Math.max(0, down - this.startedAt),
      duration_ms: Math.max(8, now - down),
    });
    this.events.sort((a, b) => a.at_ms - b.at_ms);
    this.onChange(this.snapshot());
  }

  snapshot() {
    let duration = 0;
    for (const event of this.events) duration = Math.max(duration, event.at_ms + event.duration_ms);
    if (this.recording) duration = Math.max(duration, performance.now() - this.startedAt);
    return { recording: this.recording, events: this.events.map(event => ({ ...event })), duration_ms: duration };
  }
}

export function renderPiano(container, recorder, layout = "61") {
  const mode = normalizeLayout(layout);
  const [minMidi, maxMidi] = midiRange(mode);
  const whiteMidis = [];
  for (let midi = minMidi; midi <= maxMidi; midi++) if (!isBlack(midi)) whiteMidis.push(midi);

  container.innerHTML = "";
  container.dataset.layout = mode;
  container.classList.toggle("piano-88", mode === "88");
  container.classList.toggle("piano-61", mode !== "88");

  const whiteWrap = document.createElement("div");
  whiteWrap.className = "white-keys";
  for (const midi of whiteMidis) whiteWrap.append(keyButton(midi, shortcutForMidi(midi, mode), "white-key", recorder));
  container.append(whiteWrap);

  const whitePosition = new Map(whiteMidis.map((midi, index) => [midi, index]));
  for (let midi = minMidi; midi <= maxMidi; midi++) {
    if (!isBlack(midi)) continue;
    let previous = midi - 1;
    while (previous >= minMidi && isBlack(previous)) previous -= 1;
    const previousIndex = whitePosition.get(previous);
    if (previousIndex === undefined) continue;
    const key = keyButton(midi, shortcutForMidi(midi, mode), "black-key", recorder);
    key.style.left = `calc(${((previousIndex + 1) / whiteMidis.length) * 100}% - 13px)`;
    container.append(key);
  }
}

function keyButton(midi, shortcut, className, recorder) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.dataset.midi = String(midi);
  const standardToken = tokenForMidi(midi);
  if (standardToken) button.dataset.key = standardToken;
  button.setAttribute("aria-label", `${shortcut || "Piano key"} · MIDI ${midi}`);
  button.setAttribute("aria-pressed", "false");
  const ctrl = String(shortcut).startsWith("Ctrl+");
  button.innerHTML = ctrl ? `<span class="ctrl-label"><em>Ctrl</em>${escapeHtml(String(shortcut).slice(5))}</span>` : `<span>${escapeHtml(shortcut)}</span>`;
  button.addEventListener("pointerdown", event => {
    event.preventDefault();
    button.setPointerCapture?.(event.pointerId);
    button.classList.add("manual-active");
    button.setAttribute("aria-pressed", "true");
    recorder.noteDownMidi(midi);
  });
  const release = event => {
    event.preventDefault();
    button.classList.remove("manual-active");
    button.setAttribute("aria-pressed", "false");
    recorder.noteUpMidi(midi);
  };
  button.addEventListener("pointerup", release);
  button.addEventListener("pointercancel", release);
  return button;
}

export function bindPhysicalPiano(recorder, container, layoutGetter = () => "61") {
  const pressed = new Map();
  window.addEventListener("keydown", event => {
    if (!recorder.recording || ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
    let midi = null;
    if (normalizeLayout(layoutGetter()) === "88" && event.ctrlKey && event.key.length === 1) midi = ctrlMidiForKey(event.key);
    if (midi === null && event.key.length === 1) midi = TOKEN_MIDI.get(event.key) ?? null;
    const identity = event.code || `${event.key}:${event.ctrlKey}`;
    if (midi === null || pressed.has(identity)) return;
    event.preventDefault();
    pressed.set(identity, midi);
    setKeyState(container, midi, "manual-active", true);
    recorder.noteDownMidi(midi);
  });
  window.addEventListener("keyup", event => {
    const identity = event.code || `${event.key}:${event.ctrlKey}`;
    let midi = pressed.get(identity);
    if (midi === undefined && normalizeLayout(layoutGetter()) === "88" && event.ctrlKey && event.key.length === 1) midi = ctrlMidiForKey(event.key);
    if (midi === undefined && event.key.length === 1) midi = TOKEN_MIDI.get(event.key);
    if (midi === undefined || midi === null) return;
    event.preventDefault();
    pressed.delete(identity);
    setKeyState(container, midi, "manual-active", false);
    recorder.noteUpMidi(midi);
  });
}

function escapeHtml(value = "") {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
