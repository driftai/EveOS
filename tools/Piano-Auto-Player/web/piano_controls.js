import { renderPiano } from "./piano.js";
import { pianoSoundCatalog } from "./piano_sound.js";

const LAYOUT_PREFERENCE_KEY = "eveos:piano:layout:v1";
function savedPianoLayout() {
  try {
    const value = window.localStorage.getItem(LAYOUT_PREFERENCE_KEY);
    return value === "61" || value === "88" ? value : null;
  } catch (_) { return null; }
}
function savePianoLayout(value) {
  if (value !== "61" && value !== "88") return;
  try { window.localStorage.setItem(LAYOUT_PREFERENCE_KEY, value); } catch (_) {}
}

export function setupPianoControls({ layoutSelect, soundSelect, soundStatus, visualMeta, piano, recorder, preview }) {
  const savedLayout = savedPianoLayout();
  if (savedLayout) layoutSelect.value = savedLayout;
  function render() {
    renderPiano(piano, recorder, layoutSelect.value || "61");
    updateMeta();
  }

  function applySound() {
    const soundId = soundSelect.value || "acoustic_grand";
    recorder.setSound(soundId);
    preview.setSound(soundId);
    soundStatus.textContent = soundId === "legacy_synth" ? "offline" : "sampled";
    updateMeta();
  }

  async function prepareSound() {
    applySound();
    if (soundSelect.value === "legacy_synth") return { fallback: false };
    soundStatus.textContent = "loading…";
    try {
      await Promise.all([preview.prepareSound(), recorder.prepareSound()]);
      soundStatus.textContent = "ready";
      return { fallback: false };
    } catch (error) {
      soundSelect.value = "legacy_synth";
      applySound();
      soundStatus.textContent = "offline fallback";
      return { fallback: true, message: error?.message || "Sampled piano unavailable" };
    }
  }


  function warmSelectedSound() {
    if (soundSelect.value === "legacy_synth") return;
    soundStatus.textContent = "loading…";
    Promise.all([preview.prepareSound(), recorder.prepareSound()])
      .then(() => { if (soundSelect.value !== "legacy_synth") soundStatus.textContent = "ready"; })
      .catch(() => { if (soundSelect.value !== "legacy_synth") soundStatus.textContent = "retry on play"; });
  }

  function updateMeta() {
    if (!visualMeta) return;
    const layout = layoutSelect.value === "88" ? "88-key A0–C8" : "61-key C2–C7";
    const label = soundSelect.selectedOptions[0]?.textContent || "Piano";
    visualMeta.textContent = `${layout} · ${label}`;
  }

  layoutSelect.addEventListener("change", () => {
    // Layout only changes the visible/manual key range. Keep the active song
    // timeline and internal voices alive, just as an instrument change does.
    savePianoLayout(layoutSelect.value);
    render();
  });
  soundSelect.addEventListener("change", () => {
    // Keep the playback timeline alive while the sound engine releases the
    // current voices and routes subsequent notes through the new instrument.
    applySound();
    recorder.unlock();
    prepareSound().catch(() => {});
  });

  const ids = new Set(pianoSoundCatalog().map(item => item.id));
  if (!ids.has(soundSelect.value)) soundSelect.value = "acoustic_grand";
  applySound();
  render();
  warmSelectedSound();
  return { render, applySound, prepareSound, updateMeta };
}
