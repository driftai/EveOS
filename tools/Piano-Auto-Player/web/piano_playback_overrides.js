import { songPlaybackSettings, targetOption } from "./piano_playback_settings.js";

export function setupPianoPlaybackOverrides(options) {
  const {
    els, api, preview, controls, internalMode, refreshWindows, currentSeekTotal,
    setSeekTarget, toast, updateInputModeUI, bridge, onResumeEvent
  } = options;

  async function changeInternalMode(persist = true) {
    const internal = internalMode();
    if (persist) bridge()?.persistInternalMode?.();
    const data = internal ? await api.stop().catch(() => ({ resume_event: 0 })) : preview.stop();
    if (data.resume_event) {
      if (!internal) onResumeEvent(data.resume_event);
      setSeekTarget(data.resume_event, false, currentSeekTotal());
    }
    toast(internal ? "Internal play enabled — output stays inside this tool" : "External playback route restored", "idle");
    updateInputModeUI();
  }

  async function applySongSettings(song) {
    const settings = songPlaybackSettings(song);
    const desiredInternal = settings.route === "inherit"
      ? (bridge()?.preferredInternalMode?.() ?? internalMode())
      : settings.route === "internal";
    if (els.internalPlay.checked !== desiredInternal) {
      els.internalPlay.checked = desiredInternal;
      await changeInternalMode(false);
    }
    if (settings.route === "inherit") await controls.restorePreferences();
    if (settings.layout && !controls.setLayout(settings.layout)) throw new Error("This song's Piano layout is unavailable.");
    if (settings.instrumentId && !await controls.setSound(settings.instrumentId)) throw new Error("This song's Piano instrument is unavailable.");
    controls.setVolume(settings.internalVolumePercent ?? 100);
    if (!desiredInternal) {
      let match = settings.targetHint ? targetOption(els.window, settings.targetHint) : bridge()?.restoreTargetWindow?.();
      if (!match && settings.route === "target") {
        await refreshWindows();
        match = settings.targetHint ? targetOption(els.window, settings.targetHint) : bridge()?.restoreTargetWindow?.();
      }
      if (settings.route === "target" && !match) throw new Error("This song's target window is unavailable. Choose a current target in Playback setup.");
      if (match) els.window.value = match.value;
    }
    return settings;
  }

  return { changeInternalMode, applySongSettings };
}
