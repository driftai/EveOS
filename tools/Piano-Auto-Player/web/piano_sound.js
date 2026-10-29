const SOUNDS = {
  fluid_studio_grand: {
    label: "Studio Grand Piano (FluidR3)",
    url: "https://surikov.github.io/webaudiofontdata/sound/0000_FluidR3_GM_sf2_file.js",
    variable: "_tone_0000_FluidR3_GM_sf2_file",
    volume: 0.68,
    sampled: true,
  },
  acoustic_grand: {
    label: "Acoustic Grand Piano",
    url: "https://surikov.github.io/webaudiofontdata/sound/0000_GeneralUserGS_sf2_file.js",
    variable: "_tone_0000_GeneralUserGS_sf2_file",
    volume: 0.72,
    sampled: true,
  },
  bright_acoustic: {
    label: "Bright Acoustic Piano",
    url: "https://surikov.github.io/webaudiofontdata/sound/0010_GeneralUserGS_sf2_file.js",
    variable: "_tone_0010_GeneralUserGS_sf2_file",
    volume: 0.70,
    sampled: true,
  },
  fluid_electric_piano_1: {
    label: "Electric Piano 1 (FluidR3)",
    url: "https://surikov.github.io/webaudiofontdata/sound/0040_FluidR3_GM_sf2_file.js",
    variable: "_tone_0040_FluidR3_GM_sf2_file",
    volume: 0.66,
    sampled: true,
  },
  fluid_electric_piano_2: {
    label: "Electric Piano 2 (FluidR3)",
    url: "https://surikov.github.io/webaudiofontdata/sound/0050_FluidR3_GM_sf2_file.js",
    variable: "_tone_0050_FluidR3_GM_sf2_file",
    volume: 0.66,
    sampled: true,
  },
  electric_grand: {
    label: "Electric Grand Piano",
    url: "https://surikov.github.io/webaudiofontdata/sound/0020_GeneralUserGS_sf2_file.js",
    variable: "_tone_0020_GeneralUserGS_sf2_file",
    volume: 0.68,
    sampled: true,
  },
  honky_tonk: {
    label: "Honky-tonk Piano",
    url: "https://surikov.github.io/webaudiofontdata/sound/0030_GeneralUserGS_sf2_file.js",
    variable: "_tone_0030_GeneralUserGS_sf2_file",
    volume: 0.68,
    sampled: true,
  },
  legacy_synth: {
    label: "Legacy Synth (offline)",
    sampled: false,
    volume: 0.16,
  },
};

let sharedContext = null;
let sharedOutput = null;
const scriptLoads = new Map();
const presetLoads = new Map();

function audioContext(resume = true) {
  if (!sharedContext) sharedContext = new (window.AudioContext || window.webkitAudioContext)();
  if (resume && sharedContext.state === "suspended") sharedContext.resume();
  return sharedContext;
}

function outputNode(ctx) {
  if (sharedOutput) return sharedOutput;
  const compressor = ctx.createDynamicsCompressor();
  const master = ctx.createGain();
  compressor.threshold.value = -14;
  compressor.knee.value = 18;
  compressor.ratio.value = 7;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.22;
  master.gain.value = 0.62;
  master.connect(compressor).connect(ctx.destination);
  sharedOutput = master;
  return sharedOutput;
}

function loadScript(meta) {
  if (window[meta.variable]) return Promise.resolve(window[meta.variable]);
  if (scriptLoads.has(meta.url)) return scriptLoads.get(meta.url);
  const promise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = meta.url;
    script.async = true;
    script.onload = () => window[meta.variable] ? resolve(window[meta.variable]) : reject(new Error(`Loaded ${meta.label}, but its preset data was missing.`));
    script.onerror = () => reject(new Error(`Could not download ${meta.label}. Check your internet connection.`));
    document.head.append(script);
  });
  scriptLoads.set(meta.url, promise);
  promise.catch(() => scriptLoads.delete(meta.url));
  return promise;
}

function base64Bytes(text = "") {
  const decoded = atob(text);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i) & 255;
  return bytes;
}

async function decodeZone(ctx, source) {
  const zone = {
    keyRangeLow: Number(source.keyRangeLow ?? 0),
    keyRangeHigh: Number(source.keyRangeHigh ?? 127),
    originalPitch: Number(source.originalPitch ?? 6000),
    coarseTune: Number(source.coarseTune ?? 0),
    fineTune: Number(source.fineTune ?? 0),
    loopStart: Number(source.loopStart ?? 0),
    loopEnd: Number(source.loopEnd ?? 0),
    sampleRate: Number(source.sampleRate ?? 44100),
    buffer: source.buffer || null,
  };
  if (zone.buffer) return zone;
  if (source.file) {
    const bytes = base64Bytes(source.file);
    zone.buffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
    return zone;
  }
  if (source.sample) {
    const bytes = base64Bytes(source.sample);
    const sampleCount = Math.floor(bytes.length / 2);
    const buffer = ctx.createBuffer(1, sampleCount, zone.sampleRate);
    const output = buffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) {
      let value = bytes[i * 2 + 1] * 256 + bytes[i * 2];
      if (value >= 32768) value -= 65536;
      output[i] = value / 32768;
    }
    zone.buffer = buffer;
    return zone;
  }
  throw new Error("SoundFont zone did not contain audio data.");
}

async function preparePreset(soundId) {
  const meta = SOUNDS[soundId] || SOUNDS.acoustic_grand;
  if (!meta.sampled) return null;
  if (presetLoads.has(soundId)) return presetLoads.get(soundId);
  const promise = (async () => {
    const ctx = audioContext(false);
    const preset = await loadScript(meta);
    const zones = await Promise.all((preset.zones || []).map(zone => decodeZone(ctx, zone)));
    if (!zones.length) throw new Error(`${meta.label} contained no playable zones.`);
    return { meta, zones };
  })();
  presetLoads.set(soundId, promise);
  promise.catch(() => presetLoads.delete(soundId));
  return promise;
}

function findZone(preset, midi) {
  return preset?.zones?.find(zone => midi >= zone.keyRangeLow && midi <= zone.keyRangeHigh) || null;
}

function sampledVoice(ctx, preset, midi, volume = 1, startAt = ctx.currentTime, durationSeconds = null) {
  const zone = findZone(preset, midi);
  if (!zone?.buffer) return null;
  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  const baseDetune = zone.originalPitch - 100 * zone.coarseTune - zone.fineTune;
  source.buffer = zone.buffer;
  source.playbackRate.value = Math.pow(2, (100 * midi - baseDetune) / 1200);
  if (zone.loopStart > 1 && zone.loopEnd > zone.loopStart) {
    source.loop = true;
    source.loopStart = zone.loopStart / zone.sampleRate;
    source.loopEnd = zone.loopEnd / zone.sampleRate;
  }
  const now = Math.max(ctx.currentTime, Number(startAt) || ctx.currentTime);
  const peak = Math.max(0.02, Math.min(0.9, volume));
  let stopAt = null;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(peak, now + 0.008);
  if (Number.isFinite(durationSeconds)) {
    const releaseAt = now + Math.max(0.002, Number(durationSeconds));
    gain.gain.setValueAtTime(peak, releaseAt);
    gain.gain.exponentialRampToValueAtTime(0.0001, releaseAt + 0.18);
    stopAt = releaseAt + 0.21;
  }
  source.connect(gain).connect(outputNode(ctx));
  source.start(now);
  if (stopAt !== null) source.stop(stopAt);
  return { source, gain, sampled: true };
}

function synthVoice(ctx, midi, volume = 0.16, startAt = ctx.currentTime, durationSeconds = null) {
  const freq = 440 * Math.pow(2, (Number(midi) - 69) / 12);
  const osc = ctx.createOscillator();
  const overtone = ctx.createOscillator();
  const gain = ctx.createGain();
  const overtoneGain = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  osc.type = "triangle";
  overtone.type = "sine";
  osc.frequency.value = freq;
  overtone.frequency.value = freq * 2.01;
  overtoneGain.gain.value = 0.11;
  filter.type = "lowpass";
  filter.frequency.value = 3200;
  const now = Math.max(ctx.currentTime, Number(startAt) || ctx.currentTime);
  const releaseAt = Number.isFinite(durationSeconds)
    ? now + Math.max(0.002, Number(durationSeconds))
    : null;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(volume, now + 0.008);
  gain.gain.exponentialRampToValueAtTime(
    Math.max(0.025, volume * 0.35),
    releaseAt === null ? now + 0.42 : Math.min(now + 0.42, releaseAt)
  );
  osc.connect(filter);
  overtone.connect(overtoneGain).connect(filter);
  filter.connect(gain).connect(outputNode(ctx));
  osc.start(now);
  overtone.start(now);
  if (releaseAt !== null) {
    gain.gain.setValueAtTime(Math.max(0.025, volume * 0.35), releaseAt);
    gain.gain.exponentialRampToValueAtTime(0.0001, releaseAt + 0.11);
    osc.stop(releaseAt + 0.14);
    overtone.stop(releaseAt + 0.14);
  }
  return { source: osc, overtone, gain, sampled: false };
}

function releaseVoice(ctx, voice, fast = false) {
  if (!voice) return;
  const now = ctx.currentTime;
  const release = fast ? 0.018 : voice.sampled ? 0.18 : 0.11;
  voice.gain.gain.cancelScheduledValues(now);
  voice.gain.gain.setValueAtTime(Math.max(voice.gain.gain.value, 0.0001), now);
  voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + release);
  try { voice.source.stop(now + release + 0.03); } catch (_) {}
  if (voice.overtone) { try { voice.overtone.stop(now + release + 0.03); } catch (_) {} }
}

export class PianoSoundEngine {
  constructor(soundId = "acoustic_grand") {
    this.soundId = SOUNDS[soundId] ? soundId : "acoustic_grand";
    this.active = new Map();
    this.readyPreset = null;
  }

  static catalog() { return { ...SOUNDS }; }

  label() { return SOUNDS[this.soundId]?.label || SOUNDS.acoustic_grand.label; }

  isSampled() { return Boolean(SOUNDS[this.soundId]?.sampled); }

  ensure() { return audioContext(true); }
  audioTime() { return this.ensure().currentTime; }
  async unlock() { const ctx=audioContext(false); if(ctx.state === "suspended") await ctx.resume(); if(ctx.state !== "running") throw new Error("Internal piano audio is waiting for browser playback permission."); return ctx; }

  setSound(soundId) {
    const next = SOUNDS[soundId] ? soundId : "acoustic_grand";
    if (next === this.soundId) return;
    this.allOff();
    this.soundId = next;
    this.readyPreset = null;
  }

  async prepare() {
    audioContext(false);
    if (!this.isSampled()) { this.readyPreset = null; return true; }
    this.readyPreset = await preparePreset(this.soundId);
    return true;
  }

  downMidi(midi, id = `midi:${midi}`) {
    return this._startMidi(midi, id, this.audioTime(), null);
  }

  scheduleMidi(midi, id, startAt, durationSeconds) {
    return this._startMidi(midi, id, startAt, durationSeconds);
  }

  _startMidi(midi, id, startAt, durationSeconds) {
    const note = Number(midi);
    if (!Number.isFinite(note) || this.active.has(id)) return false;
    const ctx = this.ensure();
    const meta = SOUNDS[this.soundId] || SOUNDS.acoustic_grand;
    let voice = null;
    if (meta.sampled && this.readyPreset) voice = sampledVoice(ctx, this.readyPreset, note, meta.volume, startAt, durationSeconds);
    if (!voice) {
      voice = synthVoice(ctx, note, meta.sampled ? 0.12 : meta.volume, startAt, durationSeconds);
      if (meta.sampled && !this.readyPreset) this.prepare().catch(() => {});
    }
    this.active.set(id, voice);
    voice.source.addEventListener?.("ended", () => {
      if (this.active.get(id) === voice) this.active.delete(id);
    }, { once: true });
    return true;
  }

  upMidi(id) {
    const voice = this.active.get(id);
    if (!voice) return;
    releaseVoice(this.ensure(), voice, false);
    this.active.delete(id);
  }

  allOff() {
    if (!this.active.size) return;
    const ctx = this.ensure();
    for (const voice of this.active.values()) releaseVoice(ctx, voice, true);
    this.active.clear();
  }
}

export function pianoSoundCatalog() {
  return Object.entries(SOUNDS).map(([id, meta]) => ({ id, label: meta.label, sampled: Boolean(meta.sampled) }));
}
